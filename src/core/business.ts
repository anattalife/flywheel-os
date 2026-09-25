import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { withTenant, type Tx } from '../db/pool.js';
import { hashKey, newApiKey } from '../lib/secrets.js';
import { toE164 } from '../lib/phone.js';
import { hydratePack, resolvePack } from '../packs/registry.js';
import type { Pack } from '../packs/schema.js';
import { emit } from './events.js';

export interface Business {
  id: string;
  name: string;
  timezone: string;
  phone_number: string | null;
  custom_domain: string | null;
  review_url: string | null;
  settings: Record<string, any>;
  pack: Pack;
  pack_id: string;
}

export interface CreateBusinessInput {
  name: string;
  pack_id?: string;
  custom_pack?: unknown;
  pack_overrides?: unknown;
  timezone?: string;
  phone_number?: string;
  custom_domain?: string;
  review_url?: string;
  settings?: Record<string, unknown>;
}

/** Create a business from a pack, seed its services, and return a one-time API key. */
export async function createBusiness(input: CreateBusinessInput) {
  const pack = resolvePack({ packId: input.pack_id ?? 'general-service', custom: input.custom_pack, overrides: input.pack_overrides });
  if (input.timezone) new Intl.DateTimeFormat('en-US', { timeZone: input.timezone }); // throws on unknown zones
  const id = randomUUID();
  const apiKey = newApiKey();
  const business = await withTenant(id, async (tx) => {
    const r = await tx.query<Business>(
      `insert into businesses (id, name, pack_id, pack, timezone, phone_number, custom_domain, review_url, settings, api_key_hash)
       values ($1, $2, $3, $4, coalesce($5, 'America/Chicago'), $6, lower($7), $8, $9, $10)
       returning id, name, pack_id, pack, timezone, phone_number, custom_domain, review_url, settings`,
      [id, input.name, pack.id, pack, input.timezone ?? null, toE164(input.phone_number) ?? null, input.custom_domain ?? null,
        input.review_url ?? null, input.settings ?? {}, hashKey(apiKey)],
    );
    for (const [i, s] of pack.services.entries()) {
      await tx.query(
        `insert into services (business_id, key, name, description, duration_min, price_rule, position) values ($1, $2, $3, $4, $5, $6, $7)`,
        [id, s.key, s.name, s.description, s.duration_min, s.price_rule, i],
      );
    }
    for (const hrs of pack.scheduling.default_hours) {
      await tx.query(`insert into business_hours (business_id, weekday, opens, closes) values ($1, $2, $3, $4)`, [id, hrs.weekday, hrs.opens, hrs.closes]);
    }
    await emit(tx, id, 'business.created', { type: 'business', id }, { pack_id: pack.id });
    return r.rows[0];
  });
  return { business, apiKey };
}

export async function loadBusiness(tx: Tx): Promise<Business> {
  const r = await tx.query<Business>(
    `select id, name, pack_id, pack, timezone, phone_number, custom_domain, review_url, settings from businesses where id = app_business_id()`,
  );
  if (!r.rows[0]) throw new Error('business not found for this tenant');
  return { ...r.rows[0], pack: hydratePack(r.rows[0].pack_id, r.rows[0].pack) };
}

/** Re-resolve the pack with new owner overrides (validated) and store the snapshot. */
export async function updatePackOverrides(tx: Tx, overrides: unknown) {
  const b = await loadBusiness(tx);
  const pack = resolvePack({ custom: b.pack, overrides });
  await tx.query(`update businesses set pack = $1 where id = app_business_id()`, [pack]);
  return pack;
}

export function links(b: Business) {
  const origin = b.custom_domain ? `https://${b.custom_domain}` : config().PUBLIC_BASE_URL;
  const site = b.custom_domain ? origin : `${origin}/site/${b.id}`;
  return { booking: `${site}/book`, review: b.review_url ?? site, site, origin };
}

/** Everything templates may reference. */
export function templateData(b: Business, customer?: Record<string, unknown>) {
  return { business: { name: b.name, tagline: b.settings?.tagline ?? b.name }, vocab: b.pack.vocabulary, links: links(b), customer: customer ?? {} };
}
