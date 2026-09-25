import { config } from '../config.js';
import { email } from '../adapters/email/index.js';
import { messaging } from '../adapters/messaging/index.js';
import { withSystem } from '../db/pool.js';

/** One JSON line per event, easy to search in Lightsail or any log tool. */
export function log(level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
  if (level === 'error') console.error(line); else console.log(line);
}

/**
 * Tell the operator something is wrong, by text and/or email, at most once per
 * `everyMin` minutes for each kind of problem.
 */
export async function alertOperator(kind: string, message: string, everyMin = 30) {
  const c = config();
  if (!c.ALERT_PHONE && !c.ALERT_EMAIL) return false;
  const fresh = await withSystem(async (tx) => (await tx.query(
    `insert into alerts_sent (kind, sent_at) values ($1, now())
     on conflict (kind) do update set sent_at = now() where alerts_sent.sent_at < now() - make_interval(mins => $2)
     returning kind`, [kind, everyMin])).rowCount);
  if (!fresh) return false;
  const body = `Flywheel alert (${kind}): ${message}`.slice(0, 600);
  try {
    if (c.ALERT_PHONE) await messaging().sendSms({ from: c.ALERT_FROM_PHONE ?? '', to: c.ALERT_PHONE, body });
    if (c.ALERT_EMAIL) await email().send({ from: c.EMAIL_FROM, to: c.ALERT_EMAIL, subject: `Flywheel alert: ${kind}`, text: body });
  } catch (e) {
    log('error', 'alert delivery failed', { kind, error: (e as Error).message });
  }
  return true;
}

export async function heartbeat(name: string, info: Record<string, unknown> = {}) {
  await withSystem((tx) => tx.query(`insert into heartbeats (name, at, info) values ($1, now(), $2) on conflict (name) do update set at = now(), info = excluded.info`, [name, info]));
}

export async function systemHealth() {
  return withSystem(async (tx) => {
    const q = (await tx.query<{ due: number; oldest_due_seconds: number; failed_24h: number; running: number }>(`select * from queue_stats()`)).rows[0];
    const hb = (await tx.query<{ name: string; age: number }>(`select name, extract(epoch from now() - at)::int as age from heartbeats`)).rows;
    const worker = hb.find((h) => h.name === 'worker');
    const problems: string[] = [];
    if (!worker || worker.age > 300) problems.push(worker ? `worker silent for ${Math.round(worker.age / 60)} min` : 'worker has never checked in');
    if (q.oldest_due_seconds > 600) problems.push(`queue backed up: oldest waiting job ${Math.round(q.oldest_due_seconds / 60)} min`);
    if (q.failed_24h > 20) problems.push(`${q.failed_24h} jobs failed in the last 24 hours`);
    return { ok: problems.length === 0, problems, queue: q, worker_seconds_ago: worker?.age ?? null };
  });
}
