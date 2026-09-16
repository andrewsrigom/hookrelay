import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { AppError } from '../core/model.js';

export interface Address {
  address: string;
  family: number;
}

export type Resolver = (hostname: string) => Promise<Address[]>;

export function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === 'unicast';
  } catch {
    return false;
  }
}

export class UrlPolicy {
  constructor(
    private readonly localReceiverOrigin?: string,
    private readonly resolver: Resolver = (hostname) => lookup(hostname, { all: true }),
  ) {}

  async resolve(value: string): Promise<{ url: URL; address: Address }> {
    let url: URL;

    try {
      url = new URL(value);
    } catch {
      throw new AppError(400, 'Invalid URL.');
    }

    if (url.username || url.password || url.hash) {
      throw new AppError(400, 'URL must not contain credentials or a fragment.');
    }

    // Only the configured local receiver may use HTTP loopback.
    if (
      this.localReceiverOrigin &&
      url.origin === this.localReceiverOrigin &&
      /^\/hooks\/[a-z-]+$/.test(url.pathname)
    ) {
      return { url, address: { address: '127.0.0.1', family: 4 } };
    }

    if (url.protocol !== 'https:' || (url.port && url.port !== '443')) {
      throw new AppError(400, 'Use a public HTTPS endpoint on port 443.');
    }

    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = ipaddr.isValid(hostname)
      ? [{ address: hostname, family: ipaddr.parse(hostname).kind() === 'ipv6' ? 6 : 4 }]
      : await this.resolveWithTimeout(hostname);

    if (!addresses.length || addresses.some((address) => !isPublicAddress(address.address))) {
      throw new AppError(400, 'Endpoint must resolve only to public IP addresses.');
    }

    return { url, address: addresses[0]! };
  }

  private async resolveWithTimeout(hostname: string): Promise<Address[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.resolver(hostname),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('DNS timeout')), 3000);
        }),
      ]);
    } catch {
      throw new AppError(503, 'Endpoint hostname could not be resolved.');
    } finally {
      clearTimeout(timer);
    }
  }

  async validate(value: string): Promise<void> {
    await this.resolve(value);
  }
}
