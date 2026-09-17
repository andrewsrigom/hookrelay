import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { z } from 'zod';
import { verifyWebhook } from '../../packages/core/security.js';
import { readSecret, requiredEnv } from '../../packages/runtime/aws.js';

const payloadSchema = z.object({
  id: z.string(),
  type: z.string(),
  createdAt: z.string(),
  data: z.record(z.unknown()),
});

function response(statusCode: number, body: object, headers: Record<string, string> = {}) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

export function handleValidationWebhook(
  event: APIGatewayProxyEventV2,
  signingSecret: string,
  now = Date.now(),
) {
  if (event.requestContext.http.method !== 'POST') {
    return response(405, { error: 'Method not allowed.' });
  }

  const body = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : (event.body ?? '');
  const header = (name: string) => event.headers[name] ?? event.headers[name.toLowerCase()] ?? '';
  const deliveryId = header('webhook-id');
  const timestamp = header('webhook-timestamp');

  if (
    !verifyWebhook(signingSecret, timestamp, deliveryId, body, header('webhook-signature'), now)
  ) {
    return response(401, { error: 'Invalid signature.' });
  }

  let payload: z.infer<typeof payloadSchema>;

  try {
    payload = payloadSchema.parse(JSON.parse(body));
  } catch {
    return response(400, { error: 'Invalid payload.' });
  }

  const attempt = z.coerce.number().int().positive().max(10).safeParse(header('webhook-attempt'));

  if (!attempt.success || header('webhook-event-id') !== payload.id) {
    return response(400, { error: 'Invalid delivery headers.' });
  }

  console.log(
    JSON.stringify({
      event: 'validation-receiver.accepted',
      eventId: payload.id,
      deliveryId,
      attempt: attempt.data,
    }),
  );

  if (payload.type === 'hookrelay.cloud_retry' && attempt.data === 1) {
    return response(503, { accepted: false, retry: true }, { 'retry-after': '2' });
  }

  return response(200, {
    accepted: true,
    eventId: payload.id,
    deliveryId,
    attempt: attempt.data,
  });
}

export const handler = async (event: APIGatewayProxyEventV2) =>
  handleValidationWebhook(event, await readSecret(requiredEnv('SIGNING_SECRET_ARN')));
