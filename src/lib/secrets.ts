import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const newApiKey = () => `fw_${randomBytes(24).toString('base64url')}`;
export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
