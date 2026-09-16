import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { AppError } from '../core/model.js';
import { policy } from '../core/policy.js';
import type { HttpResult, Transport } from '../core/delivery-worker.js';
import { UrlPolicy } from './url-policy.js';

export class HttpTransport implements Transport {
  constructor(
    private readonly urls: UrlPolicy,
    private readonly timeoutMs = policy.requestTimeoutMs,
  ) {}

  async send(value: string, body: string, headers: Record<string, string>): Promise<HttpResult> {
    try {
      // Connect to a newly validated IP on each attempt to prevent DNS rebinding.
      const { url, address } = await this.urls.resolve(value);
      return await new Promise<HttpResult>((resolve) => {
        const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
        const req = request(
          {
            protocol: url.protocol,
            hostname: address.address,
            family: address.family,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: `${url.pathname}${url.search}`,
            method: 'POST',
            agent: false,
            servername: url.hostname,
            checkServerIdentity: (_host, cert) => checkServerIdentity(url.hostname, cert),
            headers: { ...headers, Host: url.host, 'Content-Length': Buffer.byteLength(body) },
          },
          (response) => {
            const statusCode = response.statusCode ?? 502;
            const retryAfter = response.headers['retry-after'];
            const retryAfterMs = retryAfter
              ? /^\d+$/.test(retryAfter)
                ? Number(retryAfter) * 1000
                : Math.max(0, Date.parse(retryAfter) - Date.now())
              : undefined;
            // Only the status is needed; discard the response body.
            clearTimeout(timer);
            response.destroy();
            resolve({
              statusCode,
              retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : undefined,
            });
          },
        );
        const timer = setTimeout(() => req.destroy(new Error('timeout')), this.timeoutMs);
        req.on('error', (error) => {
          clearTimeout(timer);
          resolve({
            error: error.message === 'timeout' ? 'Response timed out.' : 'Connection failed.',
          });
        });
        req.end(body);
      });
    } catch (error) {
      if (error instanceof AppError) {
        return { statusCode: 400, error: error.message };
      }
      return { error: 'Endpoint lookup failed.' };
    }
  }
}
