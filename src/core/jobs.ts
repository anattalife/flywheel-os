import type { Tx } from '../db/pool.js';

export interface Job {
  id: string;
  business_id: string | null;
  type: string;
  payload: Record<string, unknown>;
  run_at: Date;
  attempts: number;
  max_attempts: number;
}

export interface EnqueueOptions {
  runAt?: Date;
  cancelKey?: string;
  dedupeKey?: string;
  maxAttempts?: number;
}

/** Schedule durable work. Survives restarts; runs when due. */
export async function enqueue(tx: Tx, businessId: string | null, type: string, payload: Record<string, unknown>, opts: EnqueueOptions = {}) {
  const r = await tx.query<{ id: string }>(
    `insert into jobs (business_id, type, payload, run_at, cancel_key, dedupe_key, max_attempts)
     values ($1, $2, $3, coalesce($4, now()), $5, $6, coalesce($7, 5))
     on conflict (dedupe_key) do nothing
     returning id`,
    [businessId, type, payload, opts.runAt ?? null, opts.cancelKey ?? null, opts.dedupeKey ?? null, opts.maxAttempts ?? null],
  );
  return r.rows[0]?.id ?? null;
}

/** Cancel every pending job sharing a cancel key (e.g. follow-ups once the lead replies). */
export async function cancelJobs(tx: Tx, cancelKey: string): Promise<number> {
  const r = await tx.query(`update jobs set status = 'cancelled', updated_at = now() where cancel_key = $1 and status = 'pending'`, [cancelKey]);
  return r.rowCount ?? 0;
}

/** Claim one due job. SKIP LOCKED lets many workers share the queue safely. */
export async function claimJob(tx: Tx, now: Date): Promise<Job | null> {
  const r = await tx.query<Job>(
    `update jobs set status = 'running', attempts = attempts + 1, locked_until = $1::timestamptz + interval '5 minutes', updated_at = now()
     where id = (
       select id from jobs
       where (status = 'pending' and run_at <= $1) or (status = 'running' and locked_until < $1)
       order by run_at
       for update skip locked
       limit 1)
     returning id, business_id, type, payload, run_at, attempts, max_attempts`,
    [now],
  );
  return r.rows[0] ?? null;
}

export async function completeJob(tx: Tx, id: string) {
  await tx.query(`update jobs set status = 'done', locked_until = null, updated_at = now() where id = $1`, [id]);
}

/** Retry with exponential backoff, or mark failed once attempts run out. */
export async function failJob(tx: Tx, job: Job, err: Error, now: Date) {
  const giveUp = job.attempts >= job.max_attempts;
  const backoffSec = Math.min(3600, 30 * 2 ** (job.attempts - 1));
  await tx.query(
    `update jobs set status = $2, last_error = $3, run_at = $4, locked_until = null, updated_at = now() where id = $1`,
    [job.id, giveUp ? 'failed' : 'pending', err.message.slice(0, 2000), new Date(now.getTime() + backoffSec * 1000)],
  );
}

/** Move a job to a later time without counting it as an attempt (quiet hours). */
export async function deferJob(tx: Tx, job: Job, until: Date) {
  await tx.query(`update jobs set status = 'pending', run_at = $2, attempts = attempts - 1, locked_until = null, updated_at = now() where id = $1`, [job.id, until]);
}
