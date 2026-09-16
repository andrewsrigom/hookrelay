import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { SqliteStore } from '../storage/sqlite-store.js';
import { RelayService } from '../core/relay-service.js';
import { DeliveryWorker } from '../core/delivery-worker.js';
import { UrlPolicy } from '../delivery/url-policy.js';
import { HttpTransport } from '../delivery/http-transport.js';
import { createRouter, type ReceiverControl } from '../../apps/server/router.js';
import { makeHttpServer } from '../../apps/server/http.js';
import { makeReceiver } from '../../apps/receiver/server.js';
import { kinds, type Endpoint } from '../core/model.js';

export interface LocalOptions {
  directory?: string;
  apiPort?: number;
  receiverPort?: number;
  webPort?: number;
  seed?: boolean;
  staticDirectory?: string;
}

export async function startLocal(options: LocalOptions = {}) {
  const directory = resolve(options.directory ?? '.local');
  await mkdir(directory, { recursive: true });
  const keyPath = resolve(directory, 'master.key');

  try {
    await writeFile(keyPath, randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
      throw error;
    }
  }

  const masterKey = (await readFile(keyPath, 'utf8')).trim();
  const store = new SqliteStore(resolve(directory, 'hookrelay.sqlite'));
  const receiver = makeReceiver(store, masterKey);
  await new Promise<void>((done, reject) => {
    receiver.once('error', reject);
    receiver.listen(options.receiverPort ?? 4311, '127.0.0.1', done);
  });
  const receiverAddress = receiver.address();

  if (!receiverAddress || typeof receiverAddress === 'string') {
    throw new Error('Receiver failed to start');
  }

  const receiverOrigin = `http://127.0.0.1:${receiverAddress.port}`;
  const urls = new UrlPolicy(receiverOrigin);
  const relay = new RelayService({ store, masterKey, validateUrl: (url) => urls.validate(url) });
  const worker = new DeliveryWorker({ store, masterKey, transport: new HttpTransport(urls) });

  if (options.seed !== false && (await store.list<Endpoint>(kinds.endpoint, 1)).length === 0) {
    const presets = [
      {
        id: 'communications',
        name: 'Customer communications',
        mode: 'success',
        eventTypes: ['order.confirmed', 'fulfillment.shipped'],
      },
      { id: 'warehouse', name: 'Warehouse sync', mode: 'flaky', eventTypes: ['order.confirmed'] },
      {
        id: 'analytics',
        name: 'Sales analytics',
        mode: 'failure',
        eventTypes: ['order.confirmed', 'fulfillment.shipped', 'return.received'],
      },
    ] as const;
    for (const preset of presets) {
      await relay.createEndpoint({
        name: preset.name,
        url: `${receiverOrigin}/hooks/${preset.id}`,
        eventTypes: [...preset.eventTypes],
      });
      const control: ReceiverControl = {
        id: preset.id,
        mode: preset.mode,
        createdAt: Date.now(),
        version: 1,
      };
      await store.transact([{ kind: 'RECEIVER', value: control, expectedVersion: 'absent' }]);
    }
  }

  const apiPort = options.apiPort ?? 4310;
  const allowedOrigins = [apiPort, options.webPort ?? 4317].flatMap((port) => [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ]);
  const api = makeHttpServer(
    createRouter({ store, relay, receiverOrigin }),
    allowedOrigins,
    options.staticDirectory,
  );
  await new Promise<void>((done, reject) => {
    api.once('error', reject);
    api.listen(apiPort, '127.0.0.1', done);
  });
  const apiAddress = api.address();

  if (!apiAddress || typeof apiAddress === 'string') {
    throw new Error('API failed to start');
  }

  // Port zero is used by integration tests; make that actual loopback origin valid too.
  allowedOrigins.push(`http://127.0.0.1:${apiAddress.port}`);
  let running: Promise<void> | undefined;
  const tick = async () => {
    const jobs = await store.claimJobs(Date.now());
    await Promise.all(
      jobs.map(async (job) => {
        try {
          await worker.process(job);
          await store.acknowledge(job);
        } catch (error) {
          console.error(
            JSON.stringify({
              event: 'job.deferred',
              deliveryId: job.deliveryId,
              error: error instanceof Error ? error.name : 'UnknownError',
            }),
          );
        }
      }),
    );
  };
  const timer = setInterval(() => {
    if (!running) {
      running = tick()
        .catch((error: unknown) =>
          console.error(
            JSON.stringify({
              event: 'queue.error',
              error: error instanceof Error ? error.name : 'UnknownError',
            }),
          ),
        )
        .finally(() => {
          running = undefined;
        });
    }
  }, 150);

  return {
    store,
    relay,
    receiverOrigin,
    apiOrigin: `http://127.0.0.1:${apiAddress.port}`,
    async stop() {
      clearInterval(timer);
      await running;
      await Promise.all(
        [api, receiver].map(
          (server) =>
            new Promise<void>((done) => {
              server.close(() => done());
              server.closeAllConnections();
            }),
        ),
      );
      store.close();
    },
  };
}
