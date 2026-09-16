import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLocal } from '../packages/runtime/local.js';
import type { Delivery, Job } from '../packages/core/model.js';
import { kinds, type RecordBase } from '../packages/core/model.js';

const directory = await mkdtemp(join(tmpdir(), 'hookrelay-flow-'));

const app = await startLocal({ directory, apiPort: 0, receiverPort: 0, seed: false });

let flowDeliveries: Delivery[];

async function request<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  expected = 200,
  origin = app.apiOrigin,
): Promise<T> {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = (await response.json()) as T;
  assert.equal(response.status, expected, JSON.stringify(result));

  return result;
}

async function waitFor(
  predicate: (deliveries: Delivery[]) => boolean,
  timeout = 115000,
  origin = app.apiOrigin,
): Promise<Delivery[]> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const { deliveries } = await request<{ deliveries: Delivery[] }>(
      '/overview',
      'GET',
      undefined,
      200,
      origin,
    );
    if (predicate(deliveries)) {
      return deliveries;
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error('Timed out waiting for delivery state');
}

try {
  for (const [id, name, mode] of [
    ['communications', 'Customer communications', 'success'],
    ['warehouse', 'Warehouse sync', 'flaky'],
    ['analytics', 'Sales analytics', 'failure'],
  ]) {
    await request(
      '/endpoints',
      'POST',
      { name, url: `${app.receiverOrigin}/hooks/${id}`, eventTypes: ['order.confirmed'] },
      201,
    );
    await request('/receiver', 'PUT', { id, mode });
  }

  const event = {
    id: 'evt_full_flow',
    type: 'order.confirmed',
    data: { orderId: 'ord_1042', currency: 'BRL', totalMinor: 15990 },
  };
  await request('/events', 'POST', event, 202);
  await request('/events', 'POST', event, 200);
  await request('/events', 'POST', { ...event, data: { changed: true } }, 409);
  const unsigned = await fetch(`${app.receiverOrigin}/hooks/communications`, {
    method: 'POST',
    body: '{}',
  });
  assert.equal(unsigned.status, 401);
  const hostile = await fetch(`${app.apiOrigin}/api/overview`, {
    headers: { Origin: 'https://evil.example' },
  });
  assert.equal(hostile.status, 403);
  console.log(
    'PASS signed HTTP publication, duplicate suppression, conflicting IDs, unsigned receiver rejection, origin checks.',
  );
  const recovered = await waitFor(
    (deliveries) =>
      deliveries.some(
        (delivery) => delivery.endpointName === 'Warehouse sync' && delivery.status === 'delivered',
      ),
    25000,
  );
  assert.equal(
    recovered.find((delivery) => delivery.endpointName === 'Warehouse sync')?.attemptCount,
    3,
  );
  assert.equal(
    recovered.find((delivery) => delivery.endpointName === 'Customer communications')?.attemptCount,
    1,
  );
  console.log(
    'PASS independent HTTP delivery: one attempt for success, three attempts after two real 503 responses.',
  );
  const completed = await waitFor(
    (deliveries) =>
      deliveries.length === 3 &&
      deliveries.every((delivery) => ['delivered', 'failed'].includes(delivery.status)),
  );
  const failed = completed.find((delivery) => delivery.status === 'failed')!;
  assert.equal(failed.attemptCount, 5);
  assert.equal(
    (await app.store.list<Job>(kinds.job, 100)).filter((job) => job.route === 'dead-letter').length,
    1,
  );
  console.log('PASS five HTTP failures produce a terminal delivery and a dead-letter record.');
  await request('/receiver', 'PUT', { id: 'analytics', mode: 'success' });
  const replay = await request<Delivery>(`/deliveries/${failed.id}/replay`, 'POST', {}, 202);
  const final = await waitFor(
    (deliveries) =>
      deliveries.some((delivery) => delivery.id === replay.id && delivery.status === 'delivered'),
    10000,
  );
  assert.equal(final.find((delivery) => delivery.id === failed.id)?.status, 'failed');
  assert.equal(final.find((delivery) => delivery.id === replay.id)?.replayOf, failed.id);
  console.log(
    'PASS manual recovery creates a new successful delivery and preserves the failed history.',
  );
  flowDeliveries = final;
} finally {
  await app.stop();
  await rm(directory, { recursive: true, force: true });
}

const recoveryDirectory = await mkdtemp(join(tmpdir(), 'hookrelay-restart-'));

let recoveryApp: Awaited<ReturnType<typeof startLocal>> | undefined;

let lostAcknowledgement:
  | {
      deliveryId: string;
      receivedCount: number;
      committedEffects: number;
      restarted: boolean;
    }
  | undefined;

try {
  recoveryApp = await startLocal({
    directory: recoveryDirectory,
    apiPort: 0,
    receiverPort: 0,
    seed: false,
  });
  const originalOrigin = recoveryApp.apiOrigin;
  const receiverPort = Number(new URL(recoveryApp.receiverOrigin).port);
  await request(
    '/endpoints',
    'POST',
    {
      name: 'Customer communications',
      url: `${recoveryApp.receiverOrigin}/hooks/communications`,
      eventTypes: ['order.confirmed'],
    },
    201,
    originalOrigin,
  );
  await request(
    '/receiver',
    'PUT',
    { id: 'communications', mode: 'lost-ack' },
    200,
    originalOrigin,
  );
  const event = { id: 'evt_lost_ack', type: 'order.confirmed', data: { orderId: 'ord_2042' } };
  const accepted = await request<{ event: { deliveryIds: string[] } }>(
    '/events',
    'POST',
    event,
    202,
    originalOrigin,
  );
  const deliveryId = accepted.event.deliveryIds[0]!;
  await waitFor(
    (deliveries) =>
      deliveries.some(
        (delivery) =>
          delivery.id === deliveryId &&
          delivery.status === 'retrying' &&
          delivery.attemptCount === 1,
      ),
    10000,
    originalOrigin,
  );
  assert.ok(await recoveryApp.store.get<RecordBase>('RECEIVER_EFFECT', deliveryId));
  await recoveryApp.stop();
  recoveryApp = undefined;
  recoveryApp = await startLocal({
    directory: recoveryDirectory,
    apiPort: 0,
    receiverPort,
    seed: false,
  });
  const restartedOrigin = recoveryApp.apiOrigin;
  const completed = await waitFor(
    (deliveries) =>
      deliveries.some((delivery) => delivery.id === deliveryId && delivery.status === 'delivered'),
    10000,
    restartedOrigin,
  );
  assert.equal(completed.find((delivery) => delivery.id === deliveryId)?.attemptCount, 2);
  const received = await recoveryApp.store.get<RecordBase & { count: number }>(
    'RECEIVED',
    deliveryId,
  );
  assert.equal(received?.count, 2);
  const effects = await recoveryApp.store.list<RecordBase>('RECEIVER_EFFECT', 10);
  assert.deepEqual(
    effects.map((effect) => effect.id),
    [deliveryId],
  );
  const repeated = await request<{ duplicate: boolean; event: { deliveryIds: string[] } }>(
    '/events',
    'POST',
    event,
    200,
    restartedOrigin,
  );
  assert.equal(repeated.duplicate, true);
  assert.deepEqual(repeated.event.deliveryIds, [deliveryId]);
  lostAcknowledgement = {
    deliveryId,
    receivedCount: received.count,
    committedEffects: 1,
    restarted: true,
  };
  console.log(
    'PASS lost acknowledgement retries after restart without applying the receiver action twice.',
  );
} finally {
  await recoveryApp?.stop();
  await rm(recoveryDirectory, { recursive: true, force: true });
}

await mkdir('.local', { recursive: true });

await writeFile(
  '.local/flow-verification.json',
  JSON.stringify(
    {
      verifiedAt: new Date().toISOString(),
      transport: 'real loopback HTTP',
      persistence: 'SQLite',
      cloudServices: false,
      deliveries: flowDeliveries,
      lostAcknowledgement,
    },
    null,
    2,
  ),
);
