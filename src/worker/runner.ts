import { withSystem, withTenant, type Tx } from '../db/pool.js';
import { alertOperator, log } from '../core/ops.js';
import { loadBusiness } from '../core/business.js';
import { loadEvent } from '../core/events.js';
import { claimJob, completeJob, deferJob, enqueue, failJob, type Job } from '../core/jobs.js';
import { DeferJob, deliverMessage } from '../core/messaging.js';
import { PLAYBOOKS, playbookByKey } from '../playbooks/index.js';
import { extendAllSeries } from '../core/scheduling.js';
import { scheduleWinBacks, scoreHealth } from '../core/retention.js';
import { checkAiVisibility, draftProfilePost, syncGoogleReviews } from '../core/discovery.js';
import { addLocalDays, localParts, zonedTime } from '../lib/tz.js';
import { dailyBrief, reasonsSummary } from '../core/intelligence.js';
import { messaging } from '../adapters/messaging/index.js';
import type { Business } from '../core/business.js';

/** Queue each owner's next morning brief at their chosen hour, in the business's timezone. */
async function scheduleBriefs(tx: Tx, business: Business, now: Date) {
  const users = (await tx.query<{ id: string; brief_hour: number }>(`select id, brief_hour from users where notify_brief and phone is not null`)).rows;
  for (const u of users) {
    const today = localParts(now, business.timezone).date;
    let at = zonedTime(today, `${String(u.brief_hour).padStart(2, '0')}:00`, business.timezone);
    if (at <= now) at = zonedTime(addLocalDays(today, 1), `${String(u.brief_hour).padStart(2, '0')}:00`, business.timezone);
    await enqueue(tx, business.id, 'owner_brief', { user_id: u.id }, { runAt: at, dedupeKey: `brief:${u.id}:${at.toISOString().slice(0, 13)}` });
  }
}

type Handler = (tx: Tx, job: Job, now: Date) => Promise<void>;

const handlers: Record<string, Handler> = {
  /** Fan an event out to each enabled playbook as its own job, so one failure can't block the others. */
  async dispatch_event(tx, job) {
    const event = await loadEvent(tx, job.payload.event_id as string);
    if (!event) return;
    const business = await loadBusiness(tx);
    for (const pb of PLAYBOOKS) {
      if (!pb.on.includes(event.type)) continue;
      if (!business.pack.playbooks[pb.key]?.enabled) continue;
      await enqueue(tx, business.id, 'run_playbook', { playbook: pb.key, event_id: event.id }, { dedupeKey: `pb:${pb.key}:${event.id}` });
    }
  },

  async run_playbook(tx, job, now) {
    const pb = playbookByKey(job.payload.playbook as string);
    const event = await loadEvent(tx, job.payload.event_id as string);
    if (!pb || !event) return;
    const business = await loadBusiness(tx);
    if (!business.pack.playbooks[pb.key]?.enabled) return;
    await pb.handle({ tx, business, now }, event);
  },

  async playbook_step(tx, job, now) {
    const pb = playbookByKey(job.payload.playbook as string);
    const step = pb?.steps?.[job.payload.step as string];
    if (!pb || !step) throw new Error(`unknown playbook step ${job.payload.playbook}.${job.payload.step}`);
    const business = await loadBusiness(tx);
    if (!business.pack.playbooks[pb.key]?.enabled) return;
    await step({ tx, business, now }, job.payload);
  },

  deliver_message: deliverMessage,

  /** The owner's morning text. */
  async owner_brief(tx, job, now) {
    const user = (await tx.query<{ phone: string | null; notify_brief: boolean }>(`select phone, notify_brief from users where id = $1`, [job.payload.user_id])).rows[0];
    if (!user?.phone || !user.notify_brief) return;
    const business = await loadBusiness(tx);
    await messaging().sendSms({ from: business.phone_number ?? '', to: user.phone, body: await dailyBrief(tx, business, now) });
  },

  /** Once a day per business: keep recurring plans filled ahead. */
  async daily_maintenance(tx, _job, now) {
    const business = await loadBusiness(tx);
    const local = localParts(now, business.timezone);
    // Each task runs in its own savepoint, so one failing (say, Google is down) doesn't undo the rest.
    const tasks: [string, boolean, () => Promise<unknown>][] = [
      ['extend recurring plans', true, () => extendAllSeries(tx, business, now)],
      ['score customer health', true, () => scoreHealth(tx, business, now)],
      ['queue win-backs', true, () => scheduleWinBacks(tx, business, now)],
      ['sync Google reviews', true, () => syncGoogleReviews(tx, business)],
      ['draft a Business Profile post', business.pack.playbooks.profile_posts.enabled && local.weekday === business.pack.playbooks.profile_posts.weekday, () => draftProfilePost(tx, business)],
      ['check AI assistant visibility', local.day === 1, () => checkAiVisibility(tx, business)],
      ['schedule the morning brief', true, () => scheduleBriefs(tx, business, now)],
      ['summarize reasons', local.day === 1, () => reasonsSummary(tx, business, 90, now)],
    ];
    for (const [name, due, run] of tasks) {
      if (!due) continue;
      await tx.query('savepoint task');
      try { await run(); await tx.query('release savepoint task'); }
      catch (e) { await tx.query('rollback to savepoint task'); log('warn', 'daily task failed', { task: name, business: business.id, error: (e as Error).message }); }
    }
  },
};

async function runJob(job: Job, now: Date) {
  const handler = handlers[job.type];
  try {
    if (!handler) throw new Error(`no handler for job type ${job.type}`);
    if (!job.business_id) throw new Error('job has no business');
    await withTenant(job.business_id, async (tx) => {
      try {
        await handler(tx, job, now);
        await completeJob(tx, job.id);
      } catch (e) {
        if (e instanceof DeferJob) await deferJob(tx, job, e.until);
        else throw e;
      }
    });
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    log('error', 'job failed', { job: job.id, type: job.type, business: job.business_id, attempt: job.attempts, error: err.message });
    await withSystem((tx) => failJob(tx, job, err, now));
    if (job.attempts >= job.max_attempts) await alertOperator(`job:${job.type}`, `${job.type} gave up after ${job.attempts} tries: ${err.message}`).catch(() => {});
  }
}

/** Run every job that is due at `now`. Returns how many ran. The clock is injectable for tests. */
export async function runDueJobs(opts: { now?: Date; limit?: number } = {}): Promise<number> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 500;
  let ran = 0;
  while (ran < limit) {
    const job = await withSystem((tx) => claimJob(tx, now));
    if (!job) break;
    await runJob(job, now);
    ran++;
  }
  return ran;
}
