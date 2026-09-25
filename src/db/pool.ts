import pg from 'pg';
import { config } from '../config.js';

export type Tx = pg.PoolClient;
let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    const c = config();
    pool = new pg.Pool({
      connectionString: c.DATABASE_URL,
      max: 10,
      ssl: c.DATABASE_SSL === 'require' ? { rejectUnauthorized: true } : undefined,
    });
  }
  return pool;
}

export async function closePool() {
  await pool?.end();
  pool = undefined;
}

async function inTransaction<T>(setup: (tx: Tx) => Promise<void>, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    await setup(client);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Run fn inside a transaction scoped to one business. RLS limits every query to it. */
export function withTenant<T>(businessId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return inTransaction(async (tx) => {
    await tx.query(`select set_config('app.business_id', $1, true)`, [businessId]);
  }, fn);
}

/** Transaction with no tenant: can only see the job queue and call lookup functions. */
export function withSystem<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return inTransaction(async () => {}, fn);
}
