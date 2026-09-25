import { z } from 'zod';
import { HttpError, RateLimiter, cookie } from '../../lib/http.js';
import { confirmPasswordReset, getSession, login, logout, requestPasswordReset, SESSION_DAYS } from '../../core/auth.js';
import { isHttps, parse, router, SESSION_COOKIE } from '../context.js';

/** Sign-in forms post JSON from the app; refusing other types stops cross-site forms (login CSRF). */
function jsonOnly(req: { headers: Record<string, unknown> }) {
  if (!String(req.headers['content-type'] ?? '').includes('application/json')) throw new HttpError(415, 'send JSON');
}

const loginLimiter = new RateLimiter(10, 15 * 60_000);
const resetLimiter = new RateLimiter(5, 15 * 60_000);

router.add('POST', '/auth/login', async (req) => {
  jsonOnly(req);
  const { email, password } = parse(z.object({ email: z.string().email(), password: z.string().min(1) }), req.body);
  if (!loginLimiter.allow(`ip:${req.ip}`) || !loginLimiter.allow(`email:${email.toLowerCase()}`)) {
    throw new HttpError(429, 'Too many sign-in attempts. Wait 15 minutes and try again.');
  }
  const r = await login(email, password, String(req.headers['user-agent'] ?? ''));
  if (!r) throw new HttpError(401, 'That email and password don’t match.');
  return {
    json: { user: { name: r.session.name, email: r.session.email, role: r.session.role } },
    headers: { 'set-cookie': cookie(SESSION_COOKIE, r.token, { maxAgeSec: SESSION_DAYS * 86400, secure: isHttps() }) },
  };
});

router.add('POST', '/auth/logout', async (req) => {
  if (req.cookies[SESSION_COOKIE]) await logout(req.cookies[SESSION_COOKIE]);
  return { json: { ok: true }, headers: { 'set-cookie': cookie(SESSION_COOKIE, '', { maxAgeSec: 0, secure: isHttps() }) } };
});

router.add('GET', '/auth/me', async (req) => {
  const s = await getSession(req.cookies[SESSION_COOKIE] ?? '');
  if (!s) throw new HttpError(401, 'not signed in');
  return { json: { user: { name: s.name, email: s.email, role: s.role }, business_id: s.businessId } };
});

router.add('POST', '/auth/reset/request', async (req) => {
  jsonOnly(req);
  const { email } = parse(z.object({ email: z.string().email() }), req.body);
  if (!resetLimiter.allow(`ip:${req.ip}`)) throw new HttpError(429, 'Too many requests. Try again later.');
  await requestPasswordReset(email).catch((e) => console.error('reset request failed', e));
  return { json: { ok: true, message: 'If that email has an account with a phone number, we just texted it a code.' } };
});

router.add('POST', '/auth/reset/confirm', async (req) => {
  jsonOnly(req);
  const b = parse(z.object({ email: z.string().email(), code: z.string().regex(/^\d{6}$/, 'the code is 6 digits'), password: z.string() }), req.body);
  if (!resetLimiter.allow(`confirm:${b.email.toLowerCase()}`)) throw new HttpError(429, 'Too many attempts. Request a new code later.');
  const ok = await confirmPasswordReset(b.email, b.code, b.password);
  if (!ok) throw new HttpError(400, 'That code is wrong or expired. Request a new one.');
  return { json: { ok: true } };
});
