import { ZodError, z } from 'zod';
import { webhookEnvelope } from '../../packages/core/webhook-envelope.js';
import {
  AppError,
  ConflictError,
  attemptKind,
  kinds,
  publicEndpoint,
  type Store,
  type Endpoint,
  type Delivery,
  type RelayEvent,
  type Attempt,
  type RecordBase,
} from '../../packages/core/model.js';
import { RelayService } from '../../packages/core/relay-service.js';
import { idSchema } from '../../packages/core/validation.js';
import { equalSecret } from '../../packages/core/security.js';

export interface ApiRequest {
  method: string;
  path: string;
  body?: string;
  authorization?: string;
}

export interface ApiResponse {
  statusCode: number;
  body: unknown;
}

export interface ReceiverControl extends RecordBase {
  mode: 'success' | 'flaky' | 'failure' | 'slow' | 'lost-ack';
}

export interface RouterOptions {
  store: Store;
  relay: RelayService;
  apiKey?: string;
  receiverOrigin?: string;
}

export function createRouter(options: RouterOptions) {
  const { store, relay } = options;
  return async (request: ApiRequest): Promise<ApiResponse> => {
    try {
      const { method, path } = request;

      if (path === '/api/health' && method === 'GET') {
        return {
          statusCode: 200,
          body: { status: 'ok', name: 'HookRelay', authRequired: Boolean(options.apiKey) },
        };
      }

      if (options.apiKey && !equalSecret(request.authorization ?? '', `Bearer ${options.apiKey}`)) {
        throw new AppError(401, 'Enter a valid access key.');
      }

      const body = () => {
        try {
          return JSON.parse(request.body ?? '{}') as unknown;
        } catch {
          throw new AppError(400, 'Invalid JSON.');
        }
      };

      if (path === '/api/overview' && method === 'GET') {
        const [endpoints, deliveries, events] = await Promise.all([
          store.list<Endpoint>(kinds.endpoint, 20),
          store.list<Delivery>(kinds.delivery, 200),
          store.list<RelayEvent>(kinds.event, 100),
        ]);
        return {
          statusCode: 200,
          body: {
            endpoints: endpoints.map(publicEndpoint),
            deliveries,
            events: events.map(({ data: _data, fingerprint: _hash, ...event }) => event),
            receiverOrigin: options.receiverOrigin,
            now: Date.now(),
            scope: { deliveries: 200, events: 100 },
          },
        };
      }

      if (path === '/api/endpoints' && method === 'POST') {
        return { statusCode: 201, body: await relay.createEndpoint(body()) };
      }

      const endpointMatch = /^\/api\/endpoints\/([^/]+)$/.exec(path);

      if (endpointMatch && method === 'PATCH') {
        const input = z.object({ active: z.boolean() }).strict().parse(body());
        return {
          statusCode: 200,
          body: await relay.setEndpointActive(idSchema.parse(endpointMatch[1]), input.active),
        };
      }

      if (path === '/api/events' && method === 'POST') {
        const result = await relay.publish(body());
        const { fingerprint: _hash, ...event } = result.event;
        return {
          statusCode: result.duplicate ? 200 : 202,
          body: { event, duplicate: result.duplicate },
        };
      }

      const deliveryMatch = /^\/api\/deliveries\/([^/]+)$/.exec(path);

      if (deliveryMatch && method === 'GET') {
        const id = idSchema.parse(deliveryMatch[1]);
        const delivery = await store.get<Delivery>(kinds.delivery, id);

        if (!delivery) {
          throw new AppError(404, 'Delivery not found.');
        }

        const [event, attempts] = await Promise.all([
          store.get<RelayEvent>(kinds.event, delivery.eventId),
          store.list<Attempt>(attemptKind(id), 100),
        ]);

        return {
          statusCode: 200,
          body: {
            delivery,
            event: event && {
              id: event.id,
              type: event.type,
              createdAt: event.createdAt,
              data: event.data,
            },
            payload: event ? webhookEnvelope(event) : undefined,
            attempts: attempts.sort((a, b) => a.number - b.number),
          },
        };
      }

      const replayMatch = /^\/api\/deliveries\/([^/]+)\/replay$/.exec(path);

      if (replayMatch && method === 'POST') {
        return { statusCode: 202, body: await relay.replay(idSchema.parse(replayMatch[1])) };
      }

      if (options.receiverOrigin && path === '/api/receiver' && method === 'GET') {
        return {
          statusCode: 200,
          body: {
            origin: options.receiverOrigin,
            controls: await store.list<ReceiverControl>('RECEIVER', 10),
          },
        };
      }

      if (options.receiverOrigin && path === '/api/receiver' && method === 'PUT') {
        const input = z
          .object({
            id: z.enum(['communications', 'warehouse', 'analytics']),
            mode: z.enum(['success', 'flaky', 'failure', 'slow', 'lost-ack']),
          })
          .strict()
          .parse(body());
        const old = await store.get<ReceiverControl>('RECEIVER', input.id);
        const value = {
          ...input,
          createdAt: old?.createdAt ?? Date.now(),
          version: (old?.version ?? 0) + 1,
        };
        await store.transact([
          { kind: 'RECEIVER', value, expectedVersion: old?.version ?? 'absent' },
        ]);

        return { statusCode: 200, body: value };
      }

      throw new AppError(404, 'Route not found.');
    } catch (error) {
      if (error instanceof AppError) {
        return { statusCode: error.status, body: { error: error.message } };
      }

      if (error instanceof ZodError) {
        return {
          statusCode: 400,
          body: {
            error: 'Check the submitted fields.',
            fields: error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          },
        };
      }

      if (error instanceof ConflictError) {
        return {
          statusCode: 409,
          body: { error: 'Data changed. Refresh and try again.' },
        };
      }

      console.error(
        JSON.stringify({
          event: 'api.error',
          error: error instanceof Error ? error.name : 'UnknownError',
        }),
      );

      return { statusCode: 500, body: { error: 'Operation failed.' } };
    }
  };
}
