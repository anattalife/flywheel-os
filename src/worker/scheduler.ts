import { withSystem } from '../db/pool.js';
import { enqueue } from '../core/jobs.js';

/**
 * Queue each business's daily upkeep once per UTC day (de-duplicated, so calling
 * this often is harmless). Upkeep extends recurring plans and runs time-based checks.
 */
export async function scheduleDaily(now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  await withSystem(async (tx) => {
    const ids = (await tx.query<{ id: string }>(`select id from list_business_ids()`)).rows;
    for (const { id } of ids) await enqueue(tx, id, 'daily_maintenance', { day }, { dedupeKey: `daily:${id}:${day}` });
  });
}
