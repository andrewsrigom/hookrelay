import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export function newSecret(): string {
  return `whsec_${randomBytes(24).toString('base64url')}`;
}

export function encryptSecret(secret: string, masterKey: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv(
    'aes-256-gcm',
    createHash('sha256').update(masterKey).digest(),
    nonce,
  );
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);

  return [nonce, cipher.getAuthTag(), encrypted]
    .map((part) => part.toString('base64url'))
    .join('.');
}

export function decryptSecret(value: string, masterKey: string): string {
  const parts = value.split('.');

  if (parts.length !== 3) {
    throw new Error('Invalid encrypted secret');
  }

  const [nonce, tag, encrypted] = parts.map((part) => Buffer.from(part, 'base64url'));
  const decipher = createDecipheriv(
    'aes-256-gcm',
    createHash('sha256').update(masterKey).digest(),
    nonce!,
  );
  decipher.setAuthTag(tag!);

  return Buffer.concat([decipher.update(encrypted!), decipher.final()]).toString('utf8');
}

export function signWebhook(
  secret: string,
  timestamp: string,
  deliveryId: string,
  body: string,
): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${deliveryId}.${body}`).digest('hex')}`;
}

export function equalSecret(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyWebhook(
  secret: string,
  timestamp: string,
  deliveryId: string,
  body: string,
  signature: string,
  now = Date.now(),
): boolean {
  if (!/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300) {
    return false;
  }
  return equalSecret(signature, signWebhook(secret, timestamp, deliveryId, body));
}

/** Object key order must not turn a retried event into a different payload. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
