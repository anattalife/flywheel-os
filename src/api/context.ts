import { z } from 'zod';
import { config } from '../config.js';
import { withSystem } from '../db/pool.js';
import { getSession } from '../core/auth.js';
import { hashKey, safeEqual } from '../lib/secrets.js';
import { HttpError, RateLimiter, Router, type Handler, type Req, type Res } from '../lib/http.js';
import { verifyTwilioSignature } from '../adapters/messaging/twilio.js';

export const router = new Router();
export const SESSION_COOKIE = 'fw_session';
export const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
export const twiml = (inner = '') => ({ text: `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`, contentType: 'text/xml' });
export const xmlEscape = (v: string) => v.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);
export const formLimiter = new RateLimiter(10, 60_000);

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}

export function zodMessage(e: z.ZodError) {
  return e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
}

export type OwnerReq = Req & { businessId: string; userId: string | null; role: 'owner' | 'staff' };

/**
 * Owner access, by either an API key (Bearer) or a login session cookie. Cookie
 * requests that change data must send the X-FW-CSRF header, which a cross-site
 * form can't add, so another site can't act as the logged-in owner.
 */
export function owner(handler: (req: OwnerReq) => Promise<Res>, opts: { ownerOnly?: boolean } = {}): Handler {
  return async (req) => {
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    let ctx: { businessId: string; userId: string | null; role: 'owner' | 'staff' } | null = null;
    if (bearer) {
      const id = await withSystem(async (tx) => (await tx.query<{ id: string | null }>(`select find_business_by_key_hash($1) as id`, [hashKey(bearer)])).rows[0].id);
      if (!id) throw new HttpError(401, 'invalid API key');
      ctx = { businessId: id, userId: null, role: 'owner' };
    } else if (req.cookies[SESSION_COOKIE]) {
      const s = await getSession(req.cookies[SESSION_COOKIE]);
      if (!s) throw new HttpError(401, 'your session has ended; sign in again');
      if (req.method !== 'GET' && req.headers['x-fw-csrf'] !== '1') throw new HttpError(403, 'missing CSRF header');
      ctx = { businessId: s.businessId, userId: s.userId, role: s.role };
    }
    if (!ctx) throw new HttpError(401, 'sign in required');
    if (opts.ownerOnly && ctx.role !== 'owner') throw new HttpError(403, 'only the owner can do that');
    return handler({ ...req, ...ctx });
  };
}

export function admin(handler: Handler): Handler {
  return async (req) => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!safeEqual(token, config().ADMIN_TOKEN)) throw new HttpError(401, 'admin token required');
    return handler(req);
  };
}

/** Twilio webhooks must carry a valid signature for the exact public URL. */
export function twilio(handler: (req: Req, businessId: string) => Promise<Res>): Handler {
  return async (req) => {
    const c = config();
    // Without Twilio signature checks these routes would accept anyone's POST; never allow that in production.
    if (c.MESSAGING_PROVIDER !== 'twilio' && c.NODE_ENV === 'production') throw new HttpError(403, 'texting is not configured');
    if (c.MESSAGING_PROVIDER === 'twilio') {
      const url = `${c.PUBLIC_BASE_URL}${req.path}${[...req.query].length ? `?${req.query}` : ''}`;
      if (!verifyTwilioSignature(c.TWILIO_AUTH_TOKEN!, url, req.body, req.headers['x-twilio-signature'] as string | undefined)) {
        throw new HttpError(403, 'invalid Twilio signature');
      }
    }
    const to = String(req.body.To ?? '');
    const businessId = await withSystem(async (tx) => (await tx.query<{ id: string | null }>(`select find_business_by_phone($1) as id`, [to])).rows[0].id);
    if (!businessId) return twiml();
    return handler(req, businessId);
  };
}

export const isHttps = () => config().PUBLIC_BASE_URL.startsWith('https://');
