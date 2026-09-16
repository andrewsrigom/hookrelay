import { afterEach, expect, it, vi } from 'vitest';
import { harness, masterKey } from './helpers.js';
import {
  BusyDeliveryError,
  DeliveryWorker,
  type HttpResult,
} from '../packages/core/delivery-worker.js';
import {
  ConflictError,
  attemptKind,
  kinds,
  type Attempt,
  type Delivery,
  type Endpoint,
  type Job,
} from '../packages/core/model.js';
import { decryptSecret, verifyWebhook } from '../packages/core/security.js';

const open: ReturnType<typeof harness>[] = [];

function setup(send = vi.fn(async (): Promise<HttpResult> => ({ statusCode: 200 }))) {
  const h = harness({ send });
  open.push(h);
  return { ...h, send };
}

afterEach(() => {
  open.splice(0).forEach((h) => h.store.close());
});

it('signs the exact body and marks a 2xx delivery completed', async () => {
  const h = setup();
  const { job, delivery } = await h.publish();
  await h.worker.process(job);
  await h.worker.process(job);
  expect(h.send).toHaveBeenCalledTimes(1);
  const stored = (await h.store.get<Endpoint>(kinds.endpoint, delivery.endpointId))!;
  const [, body, headers] = h.send.mock.calls[0]! as unknown as [
    string,
    string,
    Record<string, string>,
  ];
  expect(
    verifyWebhook(
      decryptSecret(stored.encryptedSecret, masterKey),
      headers['Webhook-Timestamp']!,
      delivery.id,
      body,
      headers['Webhook-Signature']!,
      h.now(),
    ),
  ).toBe(true);
  expect(await h.store.get<Delivery>(kinds.delivery, delivery.id)).toMatchObject({
    status: 'delivered',
    attemptCount: 1,
  });
});

it('allows only one of 25 concurrent workers to send', async () => {
  const h = setup();
  const { job } = await h.publish();
  await Promise.allSettled(Array.from({ length: 25 }, () => h.worker.process(job)));
  expect(h.send).toHaveBeenCalledTimes(1);
});

it('schedules each retry durably and never re-sends a completed attempt', async () => {
  const send = vi.fn(async (): Promise<HttpResult> => ({ statusCode: 503 }));
  const h = setup(send);
  const { delivery, job } = await h.publish();
  await h.worker.process(job);
  const retryJob = (await h.store.list<Job>(kinds.job)).find((item) => item.expectedAttempt === 2)!;
  await expect(h.worker.process(retryJob)).rejects.toBeInstanceOf(BusyDeliveryError);
  h.advance(2000);
  send.mockResolvedValue({ statusCode: 200 });
  await h.worker.process(retryJob);
  await h.worker.process(job);
  expect(send).toHaveBeenCalledTimes(2);
  expect(await h.store.list<Attempt>(attemptKind(delivery.id))).toHaveLength(2);
});

it('ends five failed HTTP attempts with a terminal queue record', async () => {
  const h = setup(vi.fn(async () => ({ statusCode: 503 })));
  const { delivery } = await h.publish();

  for (let attempt = 1; attempt <= 5; attempt++) {
    const job = (await h.store.list<Job>(kinds.job)).find(
      (item) => item.expectedAttempt === attempt && item.route === 'delivery',
    )!;
    h.advance(900000);
    await h.worker.process(job);
  }

  expect(await h.store.get<Delivery>(kinds.delivery, delivery.id)).toMatchObject({
    status: 'failed',
    attemptCount: 5,
  });
  expect(
    (await h.store.list<Job>(kinds.job)).filter((job) => job.route === 'dead-letter'),
  ).toHaveLength(1);
});

it.each([301, 400, 401, 403, 404, 410])(
  'treats HTTP %i as a terminal result',
  async (statusCode) => {
    const h = setup(vi.fn(async () => ({ statusCode })));
    const { job, delivery } = await h.publish();
    await h.worker.process(job);
    expect(await h.store.get<Delivery>(kinds.delivery, delivery.id)).toMatchObject({
      status: 'failed',
      attemptCount: 1,
    });
  },
);

it.each([408, 429, 500, 503, undefined])('retries status %s', async (statusCode) => {
  const h = setup(vi.fn(async () => ({ statusCode })));
  const { job, delivery } = await h.publish();
  await h.worker.process(job);
  expect(await h.store.get<Delivery>(kinds.delivery, delivery.id)).toMatchObject({
    status: 'retrying',
  });
});

it('honors Retry-After and ends unsupported waits without sending early', async () => {
  const h = setup(vi.fn(async () => ({ statusCode: 429, retryAfterMs: 50000 })));
  const { job, delivery } = await h.publish();
  await h.worker.process(job);
  expect((await h.store.get<Delivery>(kinds.delivery, delivery.id))?.nextAttemptAt).toBe(
    h.now() + 50000,
  );
  h.advance(50000);
  h.send.mockResolvedValue({ statusCode: 429, retryAfterMs: 3600000 });
  const next = (await h.store.list<Job>(kinds.job)).find((item) => item.expectedAttempt === 2)!;
  await h.worker.process(next);
  expect(await h.store.get<Delivery>(kinds.delivery, delivery.id)).toMatchObject({
    status: 'failed',
    lastError: expect.stringContaining('Retry-After'),
  });
});

it('replays a failed delivery with a new ID and immutable original history', async () => {
  const h = setup(vi.fn(async () => ({ statusCode: 400 })));
  const { job, delivery } = await h.publish();
  await h.worker.process(job);
  const replay = await h.relay.replay(delivery.id);
  expect(replay).toMatchObject({
    replayOf: delivery.id,
    status: 'queued',
    attemptCount: 0,
    eventId: delivery.eventId,
  });
  expect(replay.id).not.toBe(delivery.id);
  expect(await h.store.get<Delivery>(kinds.delivery, delivery.id)).toMatchObject({
    status: 'failed',
    attemptCount: 1,
  });
  await expect(h.relay.replay(replay.id)).rejects.toMatchObject({ status: 409 });
});

it('does not send to a paused endpoint and supports explicit recovery after activation', async () => {
  const h = setup();
  const { job, delivery } = await h.publish();
  await h.relay.setEndpointActive(delivery.endpointId, false);
  await h.worker.process(job);
  expect(h.send).not.toHaveBeenCalled();
  await expect(h.relay.replay(delivery.id)).rejects.toMatchObject({ status: 409 });
  await h.relay.setEndpointActive(delivery.endpointId, true);
  expect((await h.relay.replay(delivery.id)).status).toBe('queued');
});

it('recovers after a crash between HTTP acceptance and state persistence', async () => {
  const h = setup();
  const { job, delivery } = await h.publish();
  const transact = h.store.transact.bind(h.store);
  const spy = vi.spyOn(h.store, 'transact').mockImplementation(async (changes) => {
    if (changes.some((change) => change.kind.startsWith('ATTEMPT#'))) {
      throw new Error('database unavailable');
    }
    return transact(changes);
  });
  await expect(h.worker.process(job)).rejects.toThrow('database unavailable');
  spy.mockRestore();
  h.advance(31000);
  await h.worker.process(job);
  expect(h.send).toHaveBeenCalledTimes(2); // The receiver must deduplicate the stable Webhook-Id.
  expect(await h.store.get<Delivery>(kinds.delivery, delivery.id)).toMatchObject({
    status: 'delivered',
    attemptCount: 1,
  });
});

it('fences a stale worker after a replacement lease finishes', async () => {
  let finishFirst!: (result: HttpResult) => void;
  const h = setup(
    vi.fn(
      () =>
        new Promise<HttpResult>((resolve) => {
          finishFirst = resolve;
        }),
    ),
  );
  const { job } = await h.publish();
  const first = h.worker.process(job);
  await vi.waitFor(() => expect(h.send).toHaveBeenCalledOnce());
  h.advance(31000);
  const replacement = new DeliveryWorker({
    store: h.store,
    masterKey,
    now: h.now,
    transport: { send: async () => ({ statusCode: 200 }) },
  });
  await replacement.process(job);
  finishFirst({ statusCode: 503 });
  await expect(first).rejects.toBeInstanceOf(ConflictError);
});
