import { createHash, randomUUID } from 'node:crypto';
import {
  AppError,
  ConflictError,
  kinds,
  publicEndpoint,
  type Store,
  type Endpoint,
  type RelayEvent,
  type Delivery,
  type Job,
  type Mutation,
} from './model.js';
import { policy } from './policy.js';
import { canonicalJson, encryptSecret, newSecret } from './security.js';
import { endpointInput, publishInput } from './validation.js';

export interface RelayDependencies {
  store: Store;
  masterKey: string;
  validateUrl: (url: string) => Promise<void>;
  now?: () => number;
}

export function makeJob(delivery: Delivery, now: number, route: Job['route'] = 'delivery'): Job {
  const expectedAttempt = delivery.attemptCount + 1;
  return {
    id: `${delivery.id}_${route}_${expectedAttempt}`,
    version: 1,
    createdAt: now,
    deliveryId: delivery.id,
    expectedAttempt,
    route,
    availableAt: delivery.nextAttemptAt,
  };
}

export class RelayService {
  private readonly now: () => number;

  constructor(private readonly deps: RelayDependencies) {
    this.now = deps.now ?? Date.now;
  }

  async createEndpoint(input: unknown) {
    const parsed = endpointInput.parse(input);
    const { signingSecret, ...endpointInputValue } = parsed;

    await this.deps.validateUrl(parsed.url);

    // The counter bounds fan-out and serializes endpoint registration.
    for (let retry = 0; retry < 5; retry++) {
      const counter = await this.deps.store.get<{
        id: string;
        version: number;
        createdAt: number;
        count: number;
      }>('META', 'endpoints');

      if ((counter?.count ?? 0) >= policy.maxEndpoints) {
        throw new AppError(409, 'This workspace already has 20 endpoints.');
      }

      const now = this.now();
      const secret = signingSecret ?? newSecret();
      const endpoint: Endpoint = {
        ...endpointInputValue,
        id: `ep_${randomUUID()}`,
        version: 1,
        createdAt: now,
        active: true,
        encryptedSecret: encryptSecret(secret, this.deps.masterKey),
      };

      try {
        await this.deps.store.transact([
          { kind: kinds.endpoint, value: endpoint, expectedVersion: 'absent' },
          {
            kind: 'META',
            value: {
              id: 'endpoints',
              version: (counter?.version ?? 0) + 1,
              createdAt: counter?.createdAt ?? now,
              count: (counter?.count ?? 0) + 1,
            } as typeof counter & object,
            expectedVersion: counter?.version ?? 'absent',
          },
        ]);
        return { endpoint: publicEndpoint(endpoint), signingSecret: secret };
      } catch (error) {
        if (!(error instanceof ConflictError)) {
          throw error;
        }
      }
    }

    throw new AppError(409, 'Another update is in progress. Try again.');
  }

  async setEndpointActive(id: string, active: boolean) {
    const endpoint = await this.deps.store.get<Endpoint>(kinds.endpoint, id);

    if (!endpoint) {
      throw new AppError(404, 'Endpoint not found.');
    }

    const updated = { ...endpoint, active, version: endpoint.version + 1 };
    await this.deps.store.transact([
      { kind: kinds.endpoint, value: updated, expectedVersion: endpoint.version },
    ]);

    return publicEndpoint(updated);
  }

  async publish(input: unknown) {
    const parsed = publishInput.parse(input);
    const body = canonicalJson({ type: parsed.type, data: parsed.data });

    if (Buffer.byteLength(body) > policy.maxPayloadBytes) {
      throw new AppError(413, 'Event payload exceeds 32 KB.');
    }

    const id = parsed.id ?? `evt_${randomUUID()}`;
    const fingerprint = createHash('sha256').update(body).digest('hex');
    const existing = await this.deps.store.get<RelayEvent>(kinds.event, id);

    if (existing) {
      return this.duplicate(existing, fingerprint);
    }

    const endpoints = (
      await this.deps.store.list<Endpoint>(kinds.endpoint, policy.maxEndpoints)
    ).filter(
      (endpoint) =>
        endpoint.active &&
        (endpoint.eventTypes.includes('*') || endpoint.eventTypes.includes(parsed.type)),
    );
    const now = this.now();
    const deliveries = endpoints.map((endpoint) =>
      this.newDelivery(id, parsed.type, endpoint, now),
    );
    const event: RelayEvent = {
      id,
      version: 1,
      createdAt: now,
      type: parsed.type,
      data: parsed.data,
      fingerprint,
      deliveryIds: deliveries.map((delivery) => delivery.id),
    };
    const changes: Mutation[] = [{ kind: kinds.event, value: event, expectedVersion: 'absent' }];

    for (const delivery of deliveries) {
      changes.push(
        { kind: kinds.delivery, value: delivery, expectedVersion: 'absent' },
        { kind: kinds.job, value: makeJob(delivery, now), expectedVersion: 'absent' },
      );
    }

    try {
      await this.deps.store.transact(changes);
    } catch (error) {
      if (!(error instanceof ConflictError)) {
        throw error;
      }

      const concurrent = await this.deps.store.get<RelayEvent>(kinds.event, id);

      if (!concurrent) {
        throw error;
      }

      return this.duplicate(concurrent, fingerprint);
    }

    return { event, duplicate: false };
  }

  async replay(id: string) {
    const original = await this.deps.store.get<Delivery>(kinds.delivery, id);

    if (!original) {
      throw new AppError(404, 'Delivery not found.');
    }

    if (original.status !== 'failed') {
      throw new AppError(409, 'Only failed deliveries can be replayed.');
    }

    const endpoint = await this.deps.store.get<Endpoint>(kinds.endpoint, original.endpointId);

    if (!endpoint?.active) {
      throw new AppError(409, 'Resume the endpoint before replaying this delivery.');
    }

    const now = this.now();
    const delivery = {
      ...this.newDelivery(original.eventId, original.eventType, endpoint, now),
      replayOf: original.id,
    };
    await this.deps.store.transact([
      { kind: kinds.delivery, value: delivery, expectedVersion: 'absent' },
      { kind: kinds.job, value: makeJob(delivery, now), expectedVersion: 'absent' },
    ]);

    return delivery;
  }

  private duplicate(event: RelayEvent, fingerprint: string) {
    if (event.fingerprint !== fingerprint) {
      throw new AppError(409, 'This ID belongs to an event with a different payload.');
    }
    return { event, duplicate: true };
  }

  private newDelivery(
    eventId: string,
    eventType: string,
    endpoint: Endpoint,
    now: number,
  ): Delivery {
    return {
      id: `dlv_${randomUUID()}`,
      version: 1,
      createdAt: now,
      updatedAt: now,
      eventId,
      eventType,
      endpointId: endpoint.id,
      endpointName: endpoint.name,
      endpointUrl: endpoint.url,
      status: 'queued',
      attemptCount: 0,
      nextAttemptAt: now,
    };
  }
}
