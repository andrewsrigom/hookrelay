import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { z } from 'zod';

const outputsSchema = z.record(
  z.object({
    ApiUrl: z.string().url(),
    ApiKeyArn: z.string().min(1),
    FailedDeliveryQueueUrl: z.string().url(),
  }),
);

const endpointSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  active: z.boolean(),
  eventTypes: z.array(z.string()),
});

const terminalMessageSchema = z.object({
  deliveryId: z.string(),
  route: z.literal('dead-letter'),
});

const outputsFile = process.env['HOOKRELAY_OUTPUTS_FILE'] ?? '.local/aws-outputs.json';
const deployments = outputsSchema.parse(JSON.parse(await readFile(outputsFile, 'utf8')));
const selectedOutputs = deployments['HookRelay-dev'] ?? Object.values(deployments)[0];

if (!selectedOutputs) {
  throw new Error(`No stack outputs found in ${outputsFile}.`);
}

const outputs = selectedOutputs;
const baseUrl = outputs.ApiUrl.replace(/\/$/, '');
const secretClient = new SecretsManagerClient({});
const sqsClient = new SQSClient({});
const secretResult = await secretClient.send(
  new GetSecretValueCommand({ SecretId: outputs.ApiKeyArn }),
);
const apiKey = z.string().min(32).parse(secretResult.SecretString);

async function request(path: string, init: RequestInit = {}, authenticated = true) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(authenticated ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
}

async function jsonRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await request(path, init);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`HookRelay returned HTTP ${response.status}: ${text}`);
  }

  return JSON.parse(text) as T;
}

async function removeValidationFailure(deliveryId: string) {
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    const received = await sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: outputs.FailedDeliveryQueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        VisibilityTimeout: 1,
      }),
    );

    let currentRemoved = false;
    let removedCount = 0;

    for (const message of received.Messages ?? []) {
      try {
        const parsed = terminalMessageSchema.safeParse(JSON.parse(message.Body ?? '{}'));

        if (!parsed.success) {
          continue;
        }

        const detail = await jsonRequest<{ event?: { id: string } }>(
          `/api/deliveries/${parsed.data.deliveryId}`,
        );

        if (!detail.event?.id.startsWith('evt_aws_validation_')) {
          continue;
        }

        assert(message.ReceiptHandle);
        await sqsClient.send(
          new DeleteMessageCommand({
            QueueUrl: outputs.FailedDeliveryQueueUrl,
            ReceiptHandle: message.ReceiptHandle,
          }),
        );

        removedCount += 1;
        currentRemoved ||= parsed.data.deliveryId === deliveryId;
      } catch {
        continue;
      }
    }

    if (currentRemoved) {
      console.log(
        `PASS ${removedCount} synthetic terminal message${removedCount === 1 ? '' : 's'} removed from the failure queue.`,
      );
      return;
    }

    await delay(500);
  }

  throw new Error(`Synthetic terminal message for ${deliveryId} was not found.`);
}

const health = await request('/api/health', {}, false);
assert.equal(health.status, 200);
assert.equal(((await health.json()) as { authRequired?: boolean }).authRequired, true);

const unauthorized = await request('/api/overview', {}, false);
assert.equal(unauthorized.status, 401);

const overview = await jsonRequest<{ endpoints: unknown[] }>('/api/overview');
assert(Array.isArray(overview.endpoints));

console.log('PASS API health and authentication boundary.');

const endpointUrl = `${baseUrl}/api/overview`;
const currentOverview = await jsonRequest<{ endpoints: unknown[] }>('/api/overview');
const endpoints = z.array(endpointSchema).parse(currentOverview.endpoints);
let endpoint = endpoints.find(
  (candidate) => candidate.name === 'AWS managed-path validation' && candidate.url === endpointUrl,
);

if (endpoint) {
  if (!endpoint.active) {
    await jsonRequest(`/api/endpoints/${endpoint.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ active: true }),
    });
  }
} else {
  const created = await jsonRequest<{ endpoint: z.infer<typeof endpointSchema> }>(
    '/api/endpoints',
    {
      method: 'POST',
      body: JSON.stringify({
        name: 'AWS managed-path validation',
        url: endpointUrl,
        eventTypes: ['hookrelay.aws_validation'],
      }),
    },
  );
  endpoint = endpointSchema.parse(created.endpoint);
}

try {
  const eventId = `evt_aws_validation_${Date.now()}`;
  const published = await jsonRequest<{ event: { deliveryIds: string[] } }>('/api/events', {
    method: 'POST',
    body: JSON.stringify({
      id: eventId,
      type: 'hookrelay.aws_validation',
      data: { source: 'aws-validate' },
    }),
  });

  assert.equal(published.event.deliveryIds.length, 1);

  const deliveryId = published.event.deliveryIds[0]!;
  const deadline = Date.now() + 60_000;
  let lastStatus = 'queued';

  while (Date.now() < deadline) {
    const result = await jsonRequest<{
      delivery: { status: string; attemptCount: number };
      attempts: Array<{ statusCode?: number }>;
    }>(`/api/deliveries/${deliveryId}`);

    lastStatus = result.delivery.status;

    if (lastStatus === 'failed') {
      assert.equal(result.delivery.attemptCount, 1);
      assert.equal(result.attempts.length, 1);
      assert.equal(result.attempts[0]?.statusCode, 401);

      console.log(
        'PASS DynamoDB, Streams, dispatcher, SQS, worker, outbound HTTPS, and terminal delivery recording.',
      );
      await removeValidationFailure(deliveryId);
      break;
    }

    await delay(1_000);
  }

  assert.equal(lastStatus, 'failed', `Delivery timed out with status ${lastStatus}.`);
} finally {
  await jsonRequest(`/api/endpoints/${endpoint.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ active: false }),
  });
}

console.log('AWS validation passed. The reusable validation endpoint is paused.');
