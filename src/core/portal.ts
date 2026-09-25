import { createHash, randomBytes } from 'node:crypto';
import { withSystem, type Tx } from '../db/pool.js';
import { links, type Business } from './business.js';

export const PORTAL_DAYS = 60;
const sha = (v: string) => createHash('sha256').update(v).digest('hex');

/** A private link for one customer to manage their bookings. The token is the key. */
export async function portalLink(tx: Tx, business: Business, customerId: string): Promise<string> {
  const token = randomBytes(24).toString('base64url');
  await tx.query(`select portal_issue($1, $2, $3, $4)`, [sha(token), business.id, customerId, PORTAL_DAYS]);
  return `${links(business).origin}/m/${token}`;
}

export async function resolvePortalToken(token: string): Promise<{ businessId: string; customerId: string } | null> {
  if (!/^[\w-]{20,64}$/.test(token)) return null;
  const r = await withSystem(async (tx) => (await tx.query<{ business_id: string; customer_id: string }>(`select * from portal_lookup($1)`, [sha(token)])).rows[0]);
  return r ? { businessId: r.business_id, customerId: r.customer_id } : null;
}
