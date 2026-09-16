import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { HttpTransport } from '../packages/delivery/http-transport.js';
import { UrlPolicy } from '../packages/delivery/url-policy.js';

it('makes real HTTP calls, propagates Retry-After, refuses redirects and times out', async () => {
  let received = '';
  const server = createServer((request, response) => {
    if (request.url?.includes('slow')) {
      return;
    }
    request.on('data', (chunk: Buffer) => {
      received += chunk.toString();
    });
    request.on('end', () => {
      if (request.url?.includes('redirect')) {
        response.writeHead(302, { location: 'http://127.0.0.1/admin' });
      } else {
        response.writeHead(429, { 'retry-after': '7' });
      }
      response.end();
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('No port');
  }

  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const transport = new HttpTransport(new UrlPolicy(origin), 100);
    expect(
      await transport.send(`${origin}/hooks/communications`, '{"real":true}', {}),
    ).toMatchObject({
      statusCode: 429,
      retryAfterMs: 7000,
    });
    expect(received).toBe('{"real":true}');
    expect(await transport.send(`${origin}/hooks/redirect`, '{}', {})).toMatchObject({
      statusCode: 302,
    });
    expect(await transport.send(`${origin}/hooks/slow`, '{}', {})).toMatchObject({
      error: expect.stringContaining('timed out'),
    });
  } finally {
    await new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
    });
  }
});
