import { Pack, type PackInput } from './schema.js';
import { generalService } from './general-service.js';

const builtIn: Record<string, PackInput> = { [generalService.id]: generalService };

export function listPacks() {
  return Object.values(builtIn).map((p) => ({ id: p.id, name: p.name, description: p.description ?? '' }));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-merge overrides onto a base. Arrays replace rather than merge. */
export function deepMerge<T>(base: T, overrides: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(overrides)) return (overrides === undefined ? base : overrides) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(overrides)) out[k] = k in out ? deepMerge(out[k], v) : v;
  return out as T;
}

/**
 * Resolve a pack for a business: a built-in pack id plus owner overrides, or a
 * completely custom pack. Always validated, so a bad override fails loudly.
 */
export function resolvePack(source: { packId?: string; custom?: unknown; overrides?: unknown }): Pack {
  let base: unknown;
  if (source.custom) base = source.custom;
  else {
    const found = source.packId ? builtIn[source.packId] : undefined;
    if (!found) throw new Error(`unknown pack: ${source.packId}`);
    base = found;
  }
  return Pack.parse(deepMerge(base, source.overrides ?? {}));
}

/**
 * Fill a stored pack snapshot with anything newer versions of its base pack added
 * (new playbooks, templates, settings), keeping every value the owner already has.
 */
export function hydratePack(packId: string, stored: unknown): Pack {
  const base = builtIn[packId] ?? builtIn['general-service'];
  return Pack.parse(deepMerge(base, stored));
}
