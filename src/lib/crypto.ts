import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { config } from '../config.js';

/** Encrypt small secrets (OAuth tokens, API keys) for storage, with AES-256-GCM. */
function key(): Buffer {
  return Buffer.from(hkdfSync('sha256', config().APP_SECRET, 'flywheel', 'stored-secrets-v1', 32));
}

export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

export function decryptJson<T>(sealed: string): T {
  const [v, iv, tag, data] = sealed.split('.');
  if (v !== 'v1') throw new Error('unknown secret format');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8')) as T;
}
