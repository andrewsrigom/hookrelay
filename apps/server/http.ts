import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { AppError } from '../../packages/core/model.js';
import { policy } from '../../packages/core/policy.js';
import type { createRouter } from './router.js';

export async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;

    if (size > policy.maxPayloadBytes + 2048) {
      throw new AppError(413, 'Request is too large.');
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString('utf8');
}

export function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

export function makeHttpServer(
  router: ReturnType<typeof createRouter>,
  allowedOrigins: string[],
  staticDirectory?: string,
) {
  return createServer(async (request, response) => {
    try {
      const host = request.headers.host ?? '';
      const allowedHosts = allowedOrigins.map((origin) => new URL(origin).host);

      if (!allowedHosts.includes(host)) {
        json(response, 403, { error: 'Host is not allowed.' });
        return;
      }

      const origin = request.headers.origin;

      if (origin && !allowedOrigins.includes(origin)) {
        json(response, 403, { error: 'Origin is not allowed.' });
        return;
      }

      const path = new URL(request.url ?? '/', 'http://localhost').pathname;

      if (path.startsWith('/api/')) {
        if (
          ['POST', 'PUT', 'PATCH'].includes(request.method ?? '') &&
          !request.headers['content-type']?.startsWith('application/json')
        ) {
          json(response, 415, { error: 'Use Content-Type: application/json.' });
          return;
        }

        const result = await router({
          method: request.method ?? 'GET',
          path,
          body: await readBody(request),
          authorization: request.headers.authorization,
        });
        json(response, result.statusCode, result.body);

        return;
      }

      if (staticDirectory && request.method === 'GET') {
        const base = resolve(staticDirectory);
        const file = resolve(base, '.' + decodeURIComponent(path));

        if (file !== base && !file.startsWith(base + sep)) {
          json(response, 403, { error: 'Invalid path.' });
          return;
        }

        let content: Buffer;
        let extension = extname(file);

        try {
          content = await readFile(file);
        } catch {
          content = await readFile(resolve(base, 'index.html'));
          extension = '.html';
        }

        const types: Record<string, string> = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'text/javascript',
          '.css': 'text/css',
          '.svg': 'image/svg+xml',
        };
        response.writeHead(200, {
          'Content-Type': types[extension] ?? 'application/octet-stream',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy':
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
        });
        response.end(content);

        return;
      }

      json(response, 404, { error: 'Route not found.' });
    } catch (error) {
      json(response, error instanceof AppError ? error.status : 500, {
        error: error instanceof AppError ? error.message : 'Request failed.',
      });
    }
  });
}
