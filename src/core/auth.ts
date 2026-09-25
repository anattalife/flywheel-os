import { createHash, randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { messaging } from '../adapters/messaging/index.js';
import { withSystem, withTenant, type Tx } from '../db/pool.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number, opts: object) => Promise<Buffer>;
const N = 16384, R = 8, P = 1, KEYLEN = 64;
export const SESSION_DAYS = 30;
export const MIN_PASSWORD = 10;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return timingSafeEqual(key, expected);
}

// Used when the email is unknown, so a failed login takes the same time either way.
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');

const sha = (v: string) => createHash('sha256').update(v).digest('hex');

export function checkPasswordStrength(pw: string): string | null {
  if (pw.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (/^(.)\1+$/.test(pw)) return 'Use more than one repeated character.';
  return null;
}

export async function createUser(tx: Tx, businessId: string, u: { email: string; password: string; name?: string; phone?: string | null; role?: 'owner' | 'staff' }) {
  const weak = checkPasswordStrength(u.password);
  if (weak) throw Object.assign(new Error(weak), { status: 400 });
  const r = await tx.query<{ id: string }>(
    `insert into users (business_id, email, phone, name, role, password_hash) values ($1, lower($2), $3, $4, $5, $6) returning id`,
    [businessId, u.email.trim(), u.phone ?? null, u.name ?? null, u.role ?? 'owner', await hashPassword(u.password)],
  ).catch((e) => {
    if (e.code === '23505') throw Object.assign(new Error('That email already has an account.'), { status: 409 });
    throw e;
  });
  return r.rows[0].id;
}

export interface SessionInfo { userId: string; businessId: string; role: 'owner' | 'staff'; name: string | null; email: string }

export async function login(email: string, password: string, userAgent = ''): Promise<{ token: string; session: SessionInfo } | null> {
  const user = await withSystem(async (tx) => (await tx.query<{ id: string; business_id: string; password_hash: string }>(
    `select id, business_id, password_hash from auth_find_user($1)`, [email.trim()])).rows[0]);
  const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) return null;
  const token = randomBytes(32).toString('base64url');
  await withSystem((tx) => tx.query(`select auth_create_session($1, $2, $3, $4)`, [sha(token), user.id, SESSION_DAYS, userAgent]));
  const session = await getSession(token);
  return session ? { token, session } : null;
}

export async function getSession(token: string): Promise<SessionInfo | null> {
  if (!token) return null;
  const r = await withSystem(async (tx) => (await tx.query<{ user_id: string; business_id: string; role: 'owner' | 'staff'; name: string | null; email: string }>(
    `select * from auth_session($1)`, [sha(token)])).rows[0]);
  return r ? { userId: r.user_id, businessId: r.business_id, role: r.role, name: r.name, email: r.email } : null;
}

export async function logout(token: string) {
  await withSystem((tx) => tx.query(`select auth_end_session($1)`, [sha(token)]));
}

/**
 * Send a 6-digit reset code by text to the phone on the account. Always reports
 * success, so the form can't be used to discover which emails have accounts.
 */
export async function requestPasswordReset(email: string) {
  const user = await withSystem(async (tx) => (await tx.query<{ id: string; business_id: string; phone: string | null }>(
    `select id, business_id, phone from auth_find_user($1)`, [email.trim()])).rows[0]);
  if (!user?.phone) return;
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const stored = await withSystem(async (tx) => (await tx.query<{ ok: boolean }>(`select auth_store_code($1, 'password_reset', $2, 15) as ok`, [user.id, sha(`${user.id}:${code}`)])).rows[0].ok);
  if (!stored) return; // three codes this hour already: don't text the owner again
  const from = await withTenant(user.business_id, async (tx) => (await tx.query<{ phone_number: string | null }>(`select phone_number from businesses where id = app_business_id()`)).rows[0]?.phone_number ?? '');
  await messaging().sendSms({ from, to: user.phone, body: `Your Flywheel reset code is ${code}. It expires in 15 minutes. If you didn't ask for it, ignore this text.` });
}

export async function confirmPasswordReset(email: string, code: string, newPassword: string): Promise<boolean> {
  const weak = checkPasswordStrength(newPassword);
  if (weak) throw Object.assign(new Error(weak), { status: 400 });
  const user = await withSystem(async (tx) => (await tx.query<{ id: string }>(`select id from auth_find_user($1)`, [email.trim()])).rows[0]);
  if (!user) return false;
  const ok = await withSystem(async (tx) => (await tx.query<{ ok: boolean }>(`select auth_use_code($1, 'password_reset', $2) as ok`, [user.id, sha(`${user.id}:${code.trim()}`)])).rows[0].ok);
  if (!ok) return false;
  const hash = await hashPassword(newPassword);
  await withSystem((tx) => tx.query(`select auth_set_password($1, $2)`, [user.id, hash]));
  return true;
}
