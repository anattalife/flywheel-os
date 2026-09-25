import { createHash, createHmac } from 'node:crypto';
import type { StorageAdapter } from './types.js';

const sha256 = (v: Buffer | string) => createHash('sha256').update(v).digest('hex');
const hmac = (key: Buffer | string, v: string) => createHmac('sha256', key).update(v).digest();
const encodePath = (p: string) => p.split('/').map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');

export interface S3Config { bucket: string; region: string; accessKeyId: string; secretAccessKey: string; endpoint?: string }

/**
 * AWS Signature Version 4 for a single S3 request. Exported for testing against
 * the published AWS example.
 */
export const signV4 = (o: Parameters<typeof signS3>[0]) => signS3(o);
export function signS3(o: { method: string; host: string; path: string; headers: Record<string, string>; payloadHash: string; amzDate: string; region: string; accessKeyId: string; secretAccessKey: string; service?: string }) {
  const date = o.amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...Object.fromEntries(Object.entries(o.headers).map(([k, v]) => [k.toLowerCase(), v.trim()])), host: o.host, 'x-amz-content-sha256': o.payloadHash, 'x-amz-date': o.amzDate };
  const names = Object.keys(headers).sort();
  const canonical = [o.method, encodePath(o.path), '', names.map((n) => `${n}:${headers[n]}\n`).join(''), names.join(';'), o.payloadHash].join('\n');
  const service = o.service ?? 's3';
  const scope = `${date}/${o.region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', o.amzDate, scope, sha256(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${o.secretAccessKey}`, date), o.region), service), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
  return { signature, authorization: `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`, headers };
}

/** S3 or any S3-compatible bucket (Lightsail object storage is S3-compatible). */
export class S3Storage implements StorageAdapter {
  readonly name = 's3';
  constructor(private c: S3Config) {}

  private target(key: string) {
    if (this.c.endpoint) {
      const u = new URL(this.c.endpoint);
      return { host: u.host, path: `/${this.c.bucket}/${key}`, origin: `${u.protocol}//${u.host}` };
    }
    const host = `${this.c.bucket}.s3.${this.c.region}.amazonaws.com`;
    return { host, path: `/${key}`, origin: `https://${host}` };
  }

  private async request(method: string, key: string, body?: Buffer, extra: Record<string, string> = {}) {
    const t = this.target(key);
    const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const payloadHash = sha256(body ?? '');
    const s = signS3({ method, host: t.host, path: t.path, headers: extra, payloadHash, amzDate, region: this.c.region, accessKeyId: this.c.accessKeyId, secretAccessKey: this.c.secretAccessKey });
    const { host: _host, ...headers } = s.headers;
    return fetch(`${t.origin}${encodePath(t.path)}`, { method, headers: { ...headers, authorization: s.authorization }, body: body ? new Uint8Array(body) : undefined });
  }

  async put(key: string, body: Buffer, contentType: string) {
    const r = await this.request('PUT', key, body, { 'content-type': contentType });
    if (!r.ok) throw new Error(`storage put ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  async get(key: string) {
    const r = await this.request('GET', key);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`storage get ${r.status}`);
    return { body: Buffer.from(await r.arrayBuffer()), contentType: r.headers.get('content-type') ?? 'application/octet-stream' };
  }
  async delete(key: string) {
    const r = await this.request('DELETE', key);
    if (!r.ok && r.status !== 404) throw new Error(`storage delete ${r.status}`);
  }
}
