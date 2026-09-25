import type { Tx } from '../db/pool.js';
import { toE164 } from '../lib/phone.js';
import { upsertCustomer } from './customers.js';

export interface ImportRow { first_name?: string; last_name?: string; phone?: string; email?: string; notes?: string; last_visit?: string }

/** A small RFC 4180 CSV parser: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', q = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

const HEADERS: [keyof ImportRow | 'full_name', RegExp][] = [
  ['first_name', /^(first|first ?name|given ?name)$/i],
  ['last_name', /^(last|last ?name|surname|family ?name)$/i],
  ['full_name', /^(name|full ?name|client|customer|contact)$/i],
  ['phone', /^(phone|mobile|cell|cell ?phone|mobile ?phone|phone ?number|tel|telephone)$/i],
  ['email', /^(email|e-?mail|email ?address)$/i],
  ['notes', /^(notes?|comments?)$/i],
  ['last_visit', /^(last ?(visit|service|appointment|job|clean|class|booking)( ?date)?)$/i],
];

/** Turn a spreadsheet export into rows, recognizing common column names. */
export function rowsFromCsv(text: string): ImportRow[] {
  const [header, ...data] = parseCsv(text);
  if (!header) return [];
  const map = header.map((h) => HEADERS.find(([, re]) => re.test(h.trim()))?.[0] ?? null);
  return data.map((cells) => {
    const r: ImportRow & { full_name?: string } = {};
    cells.forEach((v, i) => { const k = map[i]; if (k && v.trim()) (r as Record<string, string>)[k] = v.trim(); });
    if (r.full_name && !r.first_name) {
      const [first, ...rest] = r.full_name.split(/\s+/);
      r.first_name = first; r.last_name ||= rest.join(' ') || undefined;
    }
    delete r.full_name;
    return r;
  });
}

/** Contacts exported from a phone (.vcf). */
export function rowsFromVcard(text: string): ImportRow[] {
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  return unfolded.split(/BEGIN:VCARD/i).slice(1).map((card) => {
    const r: ImportRow = {};
    for (const line of card.split(/\r?\n/)) {
      const [keyPart, ...rest] = line.split(':');
      const value = rest.join(':').trim();
      const key = keyPart.split(';')[0].toUpperCase();
      if (key === 'N' && value) { const [last, first] = value.split(';'); r.first_name ||= first || undefined; r.last_name ||= last || undefined; }
      if (key === 'FN' && value && !r.first_name) { const [first, ...l] = value.split(/\s+/); r.first_name = first; r.last_name ||= l.join(' ') || undefined; }
      if (key === 'TEL' && value && (!r.phone || /CELL|MOBILE/i.test(keyPart))) r.phone = value;
      if (key === 'EMAIL' && value && !r.email) r.email = value;
      if (key === 'NOTE' && value) r.notes = value.replace(/\\n/g, '\n');
    }
    return r;
  }).filter((r) => r.first_name || r.phone || r.email);
}

/**
 * Add imported customers. Consent to text is recorded only when the owner says how
 * these people agreed; otherwise they can be texted only after they reach out.
 */
export async function importCustomers(tx: Tx, businessId: string, rows: ImportRow[], consent: 'verbal' | 'written' | 'none') {
  const out = { created: 0, updated: 0, skipped: 0, errors: [] as string[] };
  for (const [i, r] of rows.entries()) {
    const phone = r.phone ? toE164(r.phone) : null;
    if (r.phone && !phone && !r.email) { out.skipped++; out.errors.push(`Row ${i + 2}: phone "${r.phone}" isn't a US number`); continue; }
    if (!phone && !r.email && !r.first_name) { out.skipped++; continue; }
    await tx.query('savepoint imp');
    try {
      const { customer, created } = await upsertCustomer(tx, businessId, {
        first_name: r.first_name, last_name: r.last_name, phone, email: r.email?.toLowerCase() || null, notes: r.notes,
        sms_consent: consent !== 'none' && !!phone, consent_source: consent !== 'none' ? consent : undefined, source: 'import',
      });
      const last = r.last_visit ? new Date(r.last_visit) : null;
      if (last && !Number.isNaN(last.getTime()) && last < new Date()) {
        await tx.query(`update customers set last_visit_at = greatest(coalesce(last_visit_at, $2), $2), status = case when status = 'lead' then 'active' else status end where id = $1`, [customer.id, last]);
      }
      created ? out.created++ : out.updated++;
      await tx.query('release savepoint imp');
    } catch (e) {
      await tx.query('rollback to savepoint imp');
      out.skipped++; out.errors.push(`Row ${i + 2}: ${(e as Error).message}`);
    }
  }
  return out;
}
