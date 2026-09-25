import type { IncomingMessage, ServerResponse } from 'node:http';

export interface Req {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  rawBody: string;
  rawBuffer?: Buffer;
  body: any;
  ip: string;
  businessId?: string;
  userId?: string | null;
  cookies: Record<string, string>;
}
export interface Res { status?: number; json?: unknown; text?: string | Buffer; contentType?: string; headers?: Record<string, string | string[]> }
export type Handler = (req: Req) => Promise<Res>;
export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

interface Route { method: string; parts: string[]; handler: Handler }

/** A deliberately small router: exact segments and :params, nothing clever. */
export class Router {
  private routes: Route[] = [];
  add(method: string, pattern: string, handler: Handler) {
    this.routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });
    return this;
  }
  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | null {
    const segs = path.split('/').filter(Boolean);
    for (const r of this.routes) {
      if (r.method !== method || r.parts.length !== segs.length) continue;
      const params: Record<string, string> = {};
      if (r.parts.every((p, i) => (p.startsWith(':') ? ((params[p.slice(1)] = decodeURIComponent(segs[i])), true) : p === segs[i]))) {
        return { handler: r.handler, params };
      }
    }
    return null;
  }
}

const MAX_BODY = 1_000_000;

export async function readBody(req: IncomingMessage, max = MAX_BODY): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new HttpError(413, 'request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export function parseBody(raw: string, contentType: string | undefined): any {
  if (!raw) return {};
  if (contentType?.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
  try { return JSON.parse(raw); } catch { throw new HttpError(400, 'body must be JSON'); }
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
};

export function send(res: ServerResponse, out: Res) {
  const status = out.status ?? 200;
  const headers: Record<string, string | string[]> = { ...SECURITY_HEADERS, ...(out.headers ?? {}) };
  if (out.text !== undefined) {
    res.writeHead(status, { 'content-type': out.contentType ?? 'text/plain; charset=utf-8', ...headers });
    res.end(out.text);
  } else {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(out.json ?? {}));
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(name: string, value: string, opts: { maxAgeSec?: number; secure: boolean; path?: string }) {
  return [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path ?? '/'}`, 'HttpOnly', 'SameSite=Lax',
    opts.secure ? 'Secure' : '', opts.maxAgeSec !== undefined ? `Max-Age=${opts.maxAgeSec}` : ''].filter(Boolean).join('; ');
}

/** Fixed-window limiter per key (IP). Enough to blunt form spam on one instance. */
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(private max: number, private windowMs: number) {}
  allow(key: string, now = Date.now()) {
    const h = this.hits.get(key);
    if (!h || h.reset < now) { this.hits.set(key, { n: 1, reset: now + this.windowMs }); return true; }
    h.n++;
    return h.n <= this.max;
  }
}
