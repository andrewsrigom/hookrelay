import { createServer } from 'node:http';
import { decryptSecret, verifyWebhook } from '../../packages/core/security.js';
import {
  ConflictError,
  kinds,
  type Endpoint,
  type RecordBase,
  type Store,
} from '../../packages/core/model.js';
import { json, readBody } from '../server/http.js';
import type { ReceiverControl } from '../server/router.js';

export function makeReceiver(store: Store, masterKey: string) {
  return createServer(async (request, response) => {
    try {
      const match = /^\/hooks\/(communications|warehouse|analytics)$/.exec(request.url ?? '');

      if (request.method !== 'POST' || !match) {
        json(response, 404, { error: 'Unknown receiver' });
        return;
      }

      const body = await readBody(request);
      const header = (key: string) => String(request.headers[key] ?? '');
      const endpoint = await store.get<Endpoint>(kinds.endpoint, header('webhook-endpoint-id'));

      if (
        !endpoint ||
        !verifyWebhook(
          decryptSecret(endpoint.encryptedSecret, masterKey),
          header('webhook-timestamp'),
          header('webhook-id'),
          body,
          header('webhook-signature'),
        )
      ) {
        json(response, 401, { error: 'Invalid signature' });
        return;
      }

      const deliveryId = header('webhook-id');
      const counter = await store.get<{
        id: string;
        version: number;
        createdAt: number;
        count: number;
      }>('RECEIVED', deliveryId);
      const count = (counter?.count ?? 0) + 1;
      await store.transact([
        {
          kind: 'RECEIVED',
          value: {
            id: deliveryId,
            version: (counter?.version ?? 0) + 1,
            createdAt: counter?.createdAt ?? Date.now(),
            count,
          } as NonNullable<typeof counter>,
          expectedVersion: counter?.version ?? 'absent',
        },
      ]);

      if (await store.get<RecordBase>('RECEIVER_EFFECT', deliveryId)) {
        json(response, 200, { received: true, deliveryId, attempt: count, duplicate: true });
        return;
      }

      const control = await store.get<ReceiverControl>('RECEIVER', match[1]!);
      const mode = control?.mode ?? 'success';

      if (mode === 'failure' || (mode === 'flaky' && count <= 2)) {
        json(response, 503, { error: 'Temporary unavailability' });
        return;
      }

      try {
        await store.transact([
          {
            kind: 'RECEIVER_EFFECT',
            value: { id: deliveryId, version: 1, createdAt: Date.now() } satisfies RecordBase,
            expectedVersion: 'absent',
          },
        ]);
      } catch (error) {
        if (!(error instanceof ConflictError)) {
          throw error;
        }
        json(response, 200, { received: true, deliveryId, attempt: count, duplicate: true });
        return;
      }

      if (mode === 'lost-ack') {
        response.destroy();
        return;
      }

      if (mode === 'slow') {
        const timer = setTimeout(() => {
          if (!response.destroyed) {
            json(response, 200, { received: true, deliveryId });
          }
        }, 10000);
        response.on('close', () => clearTimeout(timer));
        return;
      }

      json(response, 200, { received: true, deliveryId, attempt: count });
    } catch {
      json(response, 500, { error: 'Receiver failure' });
    }
  });
}
