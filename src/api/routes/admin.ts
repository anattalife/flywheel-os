import { z } from 'zod';
import { withTenant } from '../../db/pool.js';
import { HttpError } from '../../lib/http.js';
import { createUser } from '../../core/auth.js';
import { createBusiness } from '../../core/business.js';
import { admin, parse, router, zodMessage } from '../context.js';

const CreateBusiness = z.object({
  name: z.string().min(1).max(120),
  pack_id: z.string().optional(),
  custom_pack: z.unknown().optional(),
  pack_overrides: z.unknown().optional(),
  timezone: z.string().optional(),
  phone_number: z.string().optional(),
  custom_domain: z.string().optional(),
  review_url: z.string().url().optional(),
  settings: z.record(z.unknown()).optional(),
  owner: z.object({
    email: z.string().email(), password: z.string(), name: z.string().optional(),
    phone: z.string().regex(/^\+[1-9]\d{7,14}$/, 'use E.164 format, e.g. +15125550100').optional(),
  }).optional(),
});

router.add('POST', '/admin/businesses', admin(async (req) => {
  const input = parse(CreateBusiness, req.body);
  try {
    const { business, apiKey } = await createBusiness(input);
    if (input.owner) {
      const o = input.owner;
      await withTenant(business.id, (tx) => createUser(tx, business.id, { ...o, role: 'owner' }));
    }
    return { status: 201, json: { business, api_key: apiKey, note: 'Store the API key now. It is shown only once.' } };
  } catch (e) {
    if (e instanceof z.ZodError) throw new HttpError(400, `invalid pack: ${zodMessage(e)}`);
    throw e;
  }
}));
