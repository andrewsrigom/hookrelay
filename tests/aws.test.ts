import { afterEach, expect, it, vi } from 'vitest';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { DynamoDBStreamEvent, Context, AttributeValue } from 'aws-lambda';
import { DynamoStore } from '../packages/storage/dynamo-store.js';
import { handler } from '../apps/aws/dispatcher.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('uses strong primary-index reads for endpoint routing', async () => {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));
  const send = vi.spyOn(client, 'send').mockImplementation(async () => ({ Items: [] }));
  const store = new DynamoStore(client, 'test-table');
  await store.list('ENDPOINT', 20);
  const command = send.mock.calls[0]![0] as QueryCommand;
  expect(command.input.ConsistentRead).toBe(true);
  expect(command.input.IndexName).toBeUndefined();
  client.destroy();
});

function record(route: 'delivery' | 'dead-letter', sequence = '123') {
  return {
    eventName: 'INSERT',
    dynamodb: {
      SequenceNumber: sequence,
      NewImage: marshall({
        pk: 'OUTBOX',
        value: {
          id: 'job_1',
          deliveryId: 'dlv_1',
          expectedAttempt: 2,
          route,
          availableAt: Date.now() + 4000,
        },
      }) as Record<string, AttributeValue>,
    },
  };
}

it('publishes a delayed delivery job using the real SQS command shape', async () => {
  vi.stubEnv('DELIVERY_QUEUE_URL', 'https://sqs.us-east-1.amazonaws.com/000000000000/deliveries');
  const send = vi
    .spyOn(SQSClient.prototype, 'send')
    .mockImplementation(async () => ({ MessageId: 'message' }));
  const result = await handler(
    { Records: [record('delivery')] } as DynamoDBStreamEvent,
    {} as Context,
    () => {},
  );
  expect(result).toEqual({ batchItemFailures: [] });
  const command = send.mock.calls[0]![0] as SendMessageCommand;
  expect(command.input.DelaySeconds).toBeGreaterThanOrEqual(3);
  expect(command.input.DelaySeconds).toBeLessThanOrEqual(4);
  expect(JSON.parse(command.input.MessageBody!)).toMatchObject({
    deliveryId: 'dlv_1',
    expectedAttempt: 2,
  });
});

it('routes terminal jobs to the failed-delivery queue without delay', async () => {
  vi.stubEnv('FAILED_QUEUE_URL', 'https://sqs.us-east-1.amazonaws.com/000000000000/failed');
  const send = vi
    .spyOn(SQSClient.prototype, 'send')
    .mockImplementation(async () => ({ MessageId: 'message' }));
  await handler(
    { Records: [record('dead-letter')] } as DynamoDBStreamEvent,
    {} as Context,
    () => {},
  );
  expect((send.mock.calls[0]![0] as SendMessageCommand).input).toMatchObject({
    QueueUrl: expect.stringContaining('/failed'),
    DelaySeconds: 0,
  });
});

it('reports only the stream record that failed to publish', async () => {
  vi.stubEnv('DELIVERY_QUEUE_URL', 'https://sqs.us-east-1.amazonaws.com/000000000000/deliveries');
  vi.spyOn(SQSClient.prototype, 'send')
    .mockImplementationOnce(async () => {
      throw new Error('unavailable');
    })
    .mockImplementationOnce(async () => ({ MessageId: 'ok' }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const result = await handler(
    { Records: [record('delivery', 'first'), record('delivery', 'second')] } as DynamoDBStreamEvent,
    {} as Context,
    () => {},
  );
  expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: 'first' }] });
});
