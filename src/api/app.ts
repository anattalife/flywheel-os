import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { config } from '../config.js';
import { withSystem } from '../db/pool.js';
import { HttpError, parseBody, parseCookies, readBody, send } from '../lib/http.js';
import { router } from './context.js';
import { alertOperator, log } from '../core/ops.js';
import './routes/public.js';
import './routes/webhooks.js';
import './routes/admin.js';
import './routes/auth.js';
import './routes/owner.js';
import './routes/owner-schedule.js';
import './routes/site.js';
import './routes/portal.js';
import './routes/billing.js';
import './routes/retention.js';
import './routes/discovery.js';
import './routes/intelligence.js';
import './routes/email.js';
import './routes/setup.js';
import './routes/ops.js';
import './routes/static.js';

const domainCache = new Map<string, { id: string | null; at: number }>();
async function businessForHost(host: string): Promise<string | null> {
  const hit = domainCache.get(host);
  if (hit && Date.now() - hit.at < 60_000) return hit.id;
  const id = await withSystem(async (tx) => (await tx.query<{ id: string | null }>(`select find_business_by_domain($1) as id`, [host])).rows[0].id);
  if (domainCache.size > 2000) domainCache.clear(); // Host headers are attacker-chosen; keep memory bounded.
  domainCache.set(host, { id, at: Date.now() });
  return id;
}
const GLOBAL_PATHS = /^\/(m|assets|webhooks|public|internal|health|app|auth|v1|admin|pay|receipt|media|oauth|u)(\/|$)/;

/** Requests on a customer's own domain are served from that business's site. */
async function rewriteForCustomDomain(req: IncomingMessage, pathname: string): Promise<string> {
  delete req.headers['x-fw-site-host'];
  const host = (req.headers.host ?? '').split(':')[0].toLowerCase();
  // The app's own domain can also be a business's website (one domain for everything):
  // /app, /v1, webhooks etc. stay global, every other path is that business's site.
  if (!host || host === 'localhost' || /^[\d.]+$/.test(host) || GLOBAL_PATHS.test(pathname)) return pathname;
  const id = await businessForHost(host);
  if (!id) return pathname;
  req.headers['x-fw-site-host'] = '1';
  return `/site/${id}${pathname === '/' ? '' : pathname}`;
}

export async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://local');
  const started = Date.now();
  res.on('finish', () => {
    if (process.env.NODE_ENV === 'test') return;
    if (res.statusCode >= 400 || process.env.LOG_REQUESTS === 'true') log(res.statusCode >= 500 ? 'error' : 'info', 'request', { method: req.method, path: url.pathname, status: res.statusCode, ms: Date.now() - started });
  });
  try {
    url.pathname = await rewriteForCustomDomain(req, url.pathname);
    const match = router.match(req.method ?? 'GET', url.pathname);
    if (!match) throw new HttpError(404, 'not found');
    const isUpload = url.pathname === '/v1/photos' && req.method === 'POST';
    const isImport = url.pathname === '/v1/import/customers';
    const buf = req.method === 'GET' || req.method === 'HEAD' ? Buffer.alloc(0) : await readBody(req, isUpload ? 9 * 1024 * 1024 : isImport ? 5 * 1024 * 1024 : undefined);
    const rawBody = isUpload ? '' : buf.toString('utf8');
    const out = await match.handler({
      method: req.method ?? 'GET', path: url.pathname, params: match.params, query: url.searchParams,
      headers: req.headers, rawBody, rawBuffer: isUpload ? buf : undefined, body: isUpload || isImport ? {} : parseBody(rawBody, req.headers['content-type']),
      cookies: parseCookies(req.headers.cookie),
      ip: (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0].trim() ?? req.socket.remoteAddress ?? 'unknown',
    });
    send(res, out);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : typeof (e as any)?.status === 'number' ? (e as any).status : 500;
    if (status >= 500) {
      log('error', 'unhandled error', { path: url.pathname, error: (e as Error).message, stack: (e as Error).stack?.split('\n').slice(0, 5).join(' | ') });
      void alertOperator('api', `${req.method} ${url.pathname}: ${(e as Error).message}`).catch(() => {});
    }
    send(res, { status, json: { error: status >= 500 ? 'Something went wrong on our side.' : (e as Error).message } });
  }
}

export const createApp = () => createServer((req, res) => { void handle(req, res); });
