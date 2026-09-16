import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoStore } from '../../packages/storage/dynamo-store.js';
import {
  ConflictError,
  kinds,
  type Delivery,
  type Job,
  type RecordBase,
  type Mutation,
} from '../../packages/core/model.js';
import { RelayService } from '../../packages/core/relay-service.js';
import { DeliveryWorker } from '../../packages/core/delivery-worker.js';

const endpoint = process.env['DYNAMODB_LOCAL_ENDPOINT'];

if (!endpoint || !/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint)) {
  throw new Error('Only an explicit loopback DynamoDB endpoint is allowed');
}

const client = new DynamoDBClient({
  endpoint,
  region: 'us-east-1',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});

const document = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

const table = `hookrelay-test-${randomUUID()}`;

const store = new DynamoStore(document, table);

beforeAll(async () => {
  await client.send(
    new CreateTableCommand({
      TableName: table,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
        { AttributeName: 'sort', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'by-created',
          KeySchema: [
            { AttributeName: 'pk', KeyType: 'HASH' },
            { AttributeName: 'sort', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    }),
  );
});

afterAll(async () => {
  await client.send(new DeleteTableCommand({ TableName: table }));
  client.destroy();
});

it('commits a transaction and rolls back every write on a failed condition', async () => {
  const value = { id: 'original', version: 1, createdAt: Date.now() };
  await store.transact([{ kind: 'ROLLBACK', value, expectedVersion: 'absent' }]);
  await expect(
    store.transact([
      { kind: 'ROLLBACK', value: { ...value, id: 'should-not-exist' }, expectedVersion: 'absent' },
      { kind: 'ROLLBACK', value, expectedVersion: 'absent' },
    ]),
  ).rejects.toBeInstanceOf(ConflictError);
  expect(await store.get('ROLLBACK', 'should-not-exist')).toBeUndefined();
  expect(await store.get('ROLLBACK', 'original')).toEqual(value);
});

it('allows only one of 25 concurrent conditional updates', async () => {
  const initial = { id: 'lease', version: 1, createdAt: Date.now() };
  await store.transact([{ kind: 'RACE', value: initial, expectedVersion: 'absent' }]);
  const results = await Promise.allSettled(
    Array.from({ length: 25 }, () =>
      store.transact([{ kind: 'RACE', value: { ...initial, version: 2 }, expectedVersion: 1 }]),
    ),
  );
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(await store.get('RACE', 'lease')).toMatchObject({ version: 2 });
});

it('reads a GSI query above 1 MB completely and honors the requested limit', async () => {
  const values = Array.from({ length: 20 }, (_, i) => ({
    id: `item_${i}`,
    version: 1,
    createdAt: i,
    payload: 'x'.repeat(70000),
  }));
  await store.transact(
    values.map((value) => ({ kind: 'PAGED', value, expectedVersion: 'absent' as const })),
  );
  const all = await store.list<RecordBase & { payload: string }>('PAGED', 20);
  expect(all).toHaveLength(20);
  expect(all[0]?.id).toBe('item_19');
  expect(all.every((item) => item.payload.length === 70000)).toBe(true);
  expect(await store.list('PAGED', 7)).toHaveLength(7);
});

it('uses strong endpoint reads immediately after registration', async () => {
  const value = { id: 'ep_manual', version: 1, createdAt: Date.now() };
  await store.transact([{ kind: kinds.endpoint, value, expectedVersion: 'absent' }]);
  expect(await store.list(kinds.endpoint, 20)).toContainEqual(value);
});

it('runs acceptance, duplicate suppression and retry through the real DynamoDB SDK', async () => {
  // Use a separate endpoint kind view to isolate this application's registration data from raw adapter checks.
  const appStore = {
    get: <T extends RecordBase>(kind: string, id: string) => store.get<T>(`APP_${kind}`, id),
    list: <T extends RecordBase>(kind: string, limit?: number) =>
      store.list<T>(`APP_${kind}`, limit),
    transact: (changes: Mutation[]) =>
      store.transact(changes.map((change) => ({ ...change, kind: `APP_${change.kind}` }))),
  };
  let clock = Date.now();
  const masterKey = 'test-only-key-never-used-in-a-cloud-account';
  const relay = new RelayService({
    store: appStore,
    masterKey,
    validateUrl: async () => {},
    now: () => clock,
  });
  await relay.createEndpoint({
    name: 'Dynamo-backed',
    url: 'https://example.com/webhook',
    eventTypes: ['order.confirmed'],
  });
  const input = { id: 'evt_real_sdk', type: 'order.confirmed', data: { orderId: 'ord_1042' } };
  const accepted = await relay.publish(input);
  expect(accepted.event.deliveryIds).toHaveLength(1);
  expect((await relay.publish(input)).duplicate).toBe(true);
  let calls = 0;
  const worker = new DeliveryWorker({
    store: appStore,
    masterKey,
    now: () => clock,
    transport: { send: async () => ({ statusCode: ++calls === 1 ? 503 : 200 }) },
  });
  const original = (await appStore.list<Job>(kinds.job))[0]!;
  await worker.process(original);
  const retry = (await appStore.list<Job>(kinds.job)).find((job) => job.expectedAttempt === 2)!;
  clock += 2100;
  await worker.process(retry);
  await worker.process(original);
  expect(calls).toBe(2);
  expect(
    await appStore.get<Delivery>(kinds.delivery, accepted.event.deliveryIds[0]!),
  ).toMatchObject({ status: 'delivered', attemptCount: 2 });
});
