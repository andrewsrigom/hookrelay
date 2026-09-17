import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { expect, it, vi } from 'vitest';
import { handleValidationWebhook } from '../apps/aws/validation-receiver.js';
import { signWebhook } from '../packages/core/security.js';

const signingSecret = 'whsec_validation_receiver_test_secret_123456';
const now = 1800000000000;

function event(type: string, attempt: number, validSignature = true) {
  const body = JSON.stringify({
    id: 'evt_cloud_validation',
    type,
    createdAt: new Date(now).toISOString(),
    data: { source: 'test' },
  });
  const timestamp = Math.floor(now / 1000).toString();
  const deliveryId = 'dlv_cloud_validation';
  const signature = signWebhook(signingSecret, timestamp, deliveryId, body);

  return {
    body,
    isBase64Encoded: false,
    headers: {
      'webhook-id': deliveryId,
      'webhook-event-id': 'evt_cloud_validation',
      'webhook-attempt': String(attempt),
      'webhook-timestamp': timestamp,
      'webhook-signature': validSignature ? signature : 'v1=invalid',
    },
    requestContext: { http: { method: 'POST' } },
  } as unknown as APIGatewayProxyEventV2;
}

it('accepts a correctly signed cloud delivery', () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});

  const result = handleValidationWebhook(event('hookrelay.cloud_success', 1), signingSecret, now);

  expect(result.statusCode).toBe(200);
  expect(JSON.parse(result.body)).toMatchObject({ accepted: true, attempt: 1 });
});

it('returns 503 once and then accepts the retry', () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});

  expect(
    handleValidationWebhook(event('hookrelay.cloud_retry', 1), signingSecret, now).statusCode,
  ).toBe(503);
  expect(
    handleValidationWebhook(event('hookrelay.cloud_retry', 2), signingSecret, now).statusCode,
  ).toBe(200);
});

it('rejects an invalid signature before parsing the event', () => {
  expect(
    handleValidationWebhook(event('hookrelay.cloud_success', 1, false), signingSecret, now)
      .statusCode,
  ).toBe(401);
});
