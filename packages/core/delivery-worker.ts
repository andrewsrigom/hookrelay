import { randomUUID } from 'node:crypto';
import { webhookEnvelope } from './webhook-envelope.js';
import {
  attemptKind,
  ConflictError,
  kinds,
  type Store,
  type Delivery,
  type Endpoint,
  type RelayEvent,
  type Job,
  type Attempt,
  type Mutation,
} from './model.js';
import { isRetryable, policy, retryDelay } from './policy.js';
import { decryptSecret, signWebhook } from './security.js';
import { makeJob } from './relay-service.js';

export interface HttpResult {
  statusCode?: number;
  error?: string;
  retryAfterMs?: number;
}

export interface Transport {
  send(url: string, body: string, headers: Record<string, string>): Promise<HttpResult>;
}

export interface WorkerDependencies {
  store: Store;
  transport: Transport;
  masterKey: string;
  now?: () => number;
}

export class BusyDeliveryError extends Error {
  constructor() {
    super('Delivery is leased or not due');
  }
}

export class DeliveryWorker {
  private readonly now: () => number;

  constructor(private readonly deps: WorkerDependencies) {
    this.now = deps.now ?? Date.now;
  }

  async process(job: Pick<Job, 'deliveryId' | 'expectedAttempt'>): Promise<void> {
    const current = await this.deps.store.get<Delivery>(kinds.delivery, job.deliveryId);

    if (!current) {
      throw new Error('Delivery record is missing');
    }

    // SQS and stream retries can repeat old jobs. An already completed attempt is safe to acknowledge.
    if (
      current.status === 'delivered' ||
      current.status === 'failed' ||
      job.expectedAttempt <= current.attemptCount
    ) {
      return;
    }

    if (job.expectedAttempt !== current.attemptCount + 1) {
      throw new Error('Out-of-order delivery job');
    }

    const now = this.now();

    if (current.nextAttemptAt > now || (current.leaseUntil ?? 0) > now) {
      throw new BusyDeliveryError();
    }

    const claimed: Delivery = {
      ...current,
      version: current.version + 1,
      status: 'processing',
      leaseToken: randomUUID(),
      leaseUntil: now + policy.leaseMs,
      updatedAt: now,
    };

    try {
      await this.deps.store.transact([
        { kind: kinds.delivery, value: claimed, expectedVersion: current.version },
      ]);
    } catch (error) {
      if (error instanceof ConflictError) {
        throw new BusyDeliveryError();
      }
      throw error;
    }

    const [event, endpoint] = await Promise.all([
      this.deps.store.get<RelayEvent>(kinds.event, current.eventId),
      this.deps.store.get<Endpoint>(kinds.endpoint, current.endpointId),
    ]);

    if (!event || !endpoint) {
      throw new Error('Delivery references are missing');
    }

    let result: HttpResult;

    if (!endpoint.active) {
      result = { statusCode: 410, error: 'Endpoint paused. Resume it, then replay the delivery.' };
    } else {
      const timestamp = Math.floor(now / 1000).toString();
      const body = JSON.stringify(webhookEnvelope(event));
      const secret = decryptSecret(endpoint.encryptedSecret, this.deps.masterKey);
      result = await this.deps.transport.send(current.endpointUrl, body, {
        'Content-Type': 'application/json',
        'User-Agent': 'HookRelay/1.0',
        'Webhook-Id': current.id,
        'Webhook-Event-Id': event.id,
        'Webhook-Endpoint-Id': endpoint.id,
        'Webhook-Attempt': String(current.attemptCount + 1),
        'Webhook-Timestamp': timestamp,
        'Webhook-Signature': signWebhook(secret, timestamp, current.id, body),
      });
    }

    await this.finish(claimed, result, now);
  }

  private async finish(claimed: Delivery, result: HttpResult, startedAt: number) {
    const now = this.now();
    const number = claimed.attemptCount + 1;
    const successful =
      result.statusCode !== undefined && result.statusCode >= 200 && result.statusCode < 300;
    const retryAfterTooLong = (result.retryAfterMs ?? 0) > 900000;
    const retry =
      !successful &&
      !retryAfterTooLong &&
      isRetryable(result.statusCode) &&
      number < policy.maxAttempts;

    if (retryAfterTooLong && !successful) {
      result.error = 'Retry-After exceeds 15 minutes. Replay after the receiver is ready.';
    }

    const status = successful ? 'delivered' : retry ? 'retrying' : 'failed';
    const updated: Delivery = {
      ...claimed,
      version: claimed.version + 1,
      status,
      attemptCount: number,
      updatedAt: now,
      nextAttemptAt: retry ? now + retryDelay(number, result.retryAfterMs) : now,
      lastStatus: result.statusCode,
      lastError: successful ? undefined : (result.error ?? `HTTP ${result.statusCode}`),
      leaseToken: undefined,
      leaseUntil: undefined,
      completedAt: retry ? undefined : now,
    };
    const attempt: Attempt = {
      id: `${claimed.id}_${number}`,
      version: 1,
      createdAt: now,
      deliveryId: claimed.id,
      number,
      startedAt,
      durationMs: Math.max(0, now - startedAt),
      outcome: successful ? 'success' : retry ? 'retry' : 'failed',
      statusCode: result.statusCode,
      error: updated.lastError,
    };
    const changes: Mutation[] = [
      { kind: kinds.delivery, value: updated, expectedVersion: claimed.version },
      { kind: attemptKind(claimed.id), value: attempt, expectedVersion: 'absent' },
    ];

    if (!successful) {
      changes.push({
        kind: kinds.job,
        value: makeJob(updated, now, retry ? 'delivery' : 'dead-letter'),
        expectedVersion: 'absent',
      });
    }

    // A stale worker cannot overwrite a replacement lease. Failed writes leave the original queue job retryable.
    await this.deps.store.transact(changes);
  }
}
