import { parsePushSubscription } from '@/server/pushSubscriptions';
import { createECDH, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const keys = {
  p256dh: createECDH('prime256v1').generateKeys().toString('base64url'),
  auth: randomBytes(16).toString('base64url'),
};
describe('push destination and key validation', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/token',
    'https://updates.push.services.mozilla.com/wpush/v2/token',
    'https://web.push.apple.com/token',
  ])('accepts supported provider %s', (endpoint) => {
    expect(parsePushSubscription({ endpoint, keys, extra: 'ignored' })).toEqual(
      { endpoint, keys },
    );
  });
  it.each([
    'http://fcm.googleapis.com/token',
    'https://127.0.0.1/token',
    'https://[::1]/token',
    'https://169.254.169.254/latest/meta-data',
    'https://redis.default.svc/token',
    'https://fcm.googleapis.com:8443/token',
    'https://user:password@fcm.googleapis.com/token',
    'https://fcm.googleapis.com.evil.example/token',
    'https://fcm.googleapis.com@evil.example/token',
    'https://evilpush.apple.com/token',
    'https://web.push.apple.com.evil.example/token',
    'https://push.apple.com/token',
    'https://fcm.googleapis.com/token#fragment',
  ])('rejects an arbitrary/internal or misleading endpoint %s', (endpoint) => {
    expect(parsePushSubscription({ endpoint, keys })).toBeNull();
  });
  it('rejects malformed encryption keys and strips unsupported request options', () => {
    expect(
      parsePushSubscription({
        endpoint: 'https://fcm.googleapis.com/token',
        keys: { ...keys, auth: 'short' },
      }),
    ).toBeNull();
    expect(
      parsePushSubscription({
        endpoint: 'https://fcm.googleapis.com/token',
        keys: { ...keys, p256dh: Buffer.alloc(65, 4).toString('base64url') },
      }),
    ).toBeNull();
    expect(
      parsePushSubscription({
        endpoint: 'https://fcm.googleapis.com/token',
        keys,
        headers: { Authorization: 'attacker' },
      }),
    ).toEqual({ endpoint: 'https://fcm.googleapis.com/token', keys });
  });
});
