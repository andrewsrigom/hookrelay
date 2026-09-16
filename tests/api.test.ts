import { expect, it } from 'vitest';
import { harness } from './helpers.js';
import { createRouter } from '../apps/server/router.js';

const h = harness();

it('protects cloud routes and never returns encrypted signing secrets', async () => {
  const router = createRouter({ store: h.store, relay: h.relay, apiKey: 'api-key' });
  expect((await router({ method: 'GET', path: '/api/overview' })).statusCode).toBe(401);
  expect((await router({ method: 'GET', path: '/api/health' })).statusCode).toBe(200);
  const created = await router({
    method: 'POST',
    path: '/api/endpoints',
    authorization: 'Bearer api-key',
    body: JSON.stringify({ name: 'Endpoint', url: 'https://example.com/hook', eventTypes: ['*'] }),
  });
  expect(created.statusCode).toBe(201);
  const overview = await router({
    method: 'GET',
    path: '/api/overview',
    authorization: 'Bearer api-key',
  });
  expect(JSON.stringify(overview.body)).not.toContain('encryptedSecret');
  expect(JSON.stringify(overview.body)).not.toContain('signingSecret');
  h.store.close();
});

it('returns clear errors for invalid JSON, invalid fields and unknown routes', async () => {
  const local = harness();
  try {
    const router = createRouter({ store: local.store, relay: local.relay });
    expect((await router({ method: 'POST', path: '/api/events', body: '{' })).statusCode).toBe(400);
    expect(
      (await router({ method: 'POST', path: '/api/events', body: '{"type":"bad","data":{}}' }))
        .statusCode,
    ).toBe(400);
    expect((await router({ method: 'GET', path: '/api/missing' })).statusCode).toBe(404);
  } finally {
    local.store.close();
  }
});
