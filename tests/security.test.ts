import { canonicalJson } from '../packages/core/security.js';
import { expect, it } from 'vitest';
import { UrlPolicy, isPublicAddress } from '../packages/delivery/url-policy.js';
import {
  decryptSecret,
  encryptSecret,
  signWebhook,
  verifyWebhook,
} from '../packages/core/security.js';

it.each([
  '127.0.0.1',
  '10.0.0.1',
  '169.254.169.254',
  '192.168.1.1',
  '172.16.0.1',
  '0.0.0.0',
  '::1',
  '::ffff:127.0.0.1',
  'fc00::1',
  'fe80::1',
  '224.0.0.1',
])('blocks non-public IP %s', (ip) => {
  expect(isPublicAddress(ip)).toBe(false);
});

it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('recognizes public IP %s', (ip) => {
  expect(isPublicAddress(ip)).toBe(true);
});

it('blocks mixed public/private DNS and allows only the exact local receiver exception', async () => {
  const policy = new UrlPolicy('http://127.0.0.1:4311', async () => [
    { address: '1.1.1.1', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ]);
  await expect(policy.validate('https://example.com/webhook')).rejects.toMatchObject({
    status: 400,
  });
  await expect(
    policy.validate('http://127.0.0.1:4311/hooks/communications'),
  ).resolves.toBeUndefined();
  await expect(policy.validate('http://127.0.0.1:4311/admin')).rejects.toThrow();
  await expect(policy.validate('http://127.0.0.1:4312/hooks/communications')).rejects.toThrow();
});

it.each([
  'http://example.com/hook',
  'https://user:pass@example.com/hook',
  'https://example.com:8443/hook',
  'https://example.com/hook#secret',
  'file:///tmp/test',
])('rejects unsafe URL %s', async (url) => {
  await expect(new UrlPolicy().validate(url)).rejects.toMatchObject({ status: 400 });
});

it('treats transient DNS failures as retryable', async () => {
  await expect(
    new UrlPolicy(undefined, async () => {
      throw new Error('EAI_AGAIN');
    }).validate('https://example.com/hook'),
  ).rejects.toMatchObject({ status: 503 });
});

it('verifies raw-body signatures, timestamps and delivery IDs', () => {
  const secret = 'whsec_test';
  const timestamp = '1800000000';
  const body = '{"x":1}';
  const signature = signWebhook(secret, timestamp, 'dlv_1', body);
  expect(verifyWebhook(secret, timestamp, 'dlv_1', body, signature, 1800000000000)).toBe(true);
  expect(verifyWebhook(secret, timestamp, 'dlv_2', body, signature, 1800000000000)).toBe(false);
  expect(verifyWebhook(secret, timestamp, 'dlv_1', '{"x":2}', signature, 1800000000000)).toBe(
    false,
  );
  expect(verifyWebhook(secret, timestamp, 'dlv_1', body, signature, 1800000400000)).toBe(false);
  expect(verifyWebhook(secret, 'abc', 'dlv_1', body, signature)).toBe(false);
});

it('detects ciphertext tampering and a wrong encryption key', () => {
  const encrypted = encryptSecret('secret', 'master');
  expect(decryptSecret(encrypted, 'master')).toBe('secret');
  expect(() => decryptSecret(encrypted, 'other')).toThrow();
  const [nonce, tag, text] = encrypted.split('.');
  expect(() => decryptSecret(`${nonce}.${tag}.${text!.slice(0, -2)}AA`, 'master')).toThrow();
});

it('uses stable code-point ordering for fingerprints regardless of server locale', () => {
  expect(canonicalJson({ a: 1, Z: 2, Ω: 3 })).toBe('{"Z":2,"a":1,"Ω":3}');
});
