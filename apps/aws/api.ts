import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { createRouter } from '../server/router.js';
import { awsStore, readSecret, requiredEnv } from '../../packages/runtime/aws.js';
import { RelayService } from '../../packages/core/relay-service.js';
import { UrlPolicy } from '../../packages/delivery/url-policy.js';
import { policy } from '../../packages/core/policy.js';

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
  try {
    const body = event.isBase64Encoded
      ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
      : (event.body ?? '');

    if (Buffer.byteLength(body) > policy.maxPayloadBytes + 2048) {
      return {
        statusCode: 413,
        headers,
        body: JSON.stringify({ error: 'Request is too large.' }),
      };
    }

    if (
      ['POST', 'PUT', 'PATCH'].includes(event.requestContext.http.method) &&
      !event.headers['content-type']?.startsWith('application/json')
    ) {
      return {
        statusCode: 415,
        headers,
        body: JSON.stringify({ error: 'Use Content-Type: application/json.' }),
      };
    }

    const [masterKey, apiKey] = await Promise.all([
      readSecret(requiredEnv('MASTER_KEY_ARN')),
      readSecret(requiredEnv('API_KEY_ARN')),
    ]);
    const store = awsStore();
    const urls = new UrlPolicy();
    const relay = new RelayService({ store, masterKey, validateUrl: (url) => urls.validate(url) });
    const result = await createRouter({ store, relay, apiKey })({
      method: event.requestContext.http.method,
      path: event.rawPath,
      body,
      authorization: event.headers.authorization,
    });

    return { statusCode: result.statusCode, headers, body: JSON.stringify(result.body) };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'api.unavailable',
        error: error instanceof Error ? error.name : 'UnknownError',
      }),
    );
    return {
      statusCode: 503,
      headers,
      body: JSON.stringify({ error: 'Service temporarily unavailable.' }),
    };
  }
};
