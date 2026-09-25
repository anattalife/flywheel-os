import { DevMessagingAdapter } from '../src/adapters/messaging/dev.js';
import { setMessagingAdapter } from '../src/adapters/messaging/index.js';
import { createBusiness, type CreateBusinessInput } from '../src/core/business.js';
import { withSystem, withTenant, type Tx } from '../src/db/pool.js';
import { runDueJobs } from '../src/worker/runner.js';

let counter = 0;

export async function newBusiness(input: Partial<CreateBusinessInput> = {}) {
  counter++;
  const phone = `+1555010${String(1000 + counter).slice(-4)}`;
  const { business, apiKey } = await createBusiness({ name: `Test Co ${counter}`, phone_number: phone, timezone: 'America/Chicago', review_url: 'https://g.page/r/test', ...input });
  return { business, apiKey, id: business.id, phone: business.phone_number! };
}

/** New empty outbox, and a clean queue so work left over from earlier tests can't leak in. */
export async function freshOutbox() {
  await withSystem((tx) => tx.query(`update jobs set status = 'cancelled' where status in ('pending','running')`));
  const dev = new DevMessagingAdapter();
  setMessagingAdapter(dev);
  return dev.outbox;
}

export const tenant = <T>(id: string, fn: (tx: Tx) => Promise<T>) => withTenant(id, fn);

/** A time that is inside business hours in America/Chicago (15:00 local), `daysFromNow` ahead. */
export function daytime(daysFromNow = 0): Date {
  const d = new Date();
  d.setUTCHours(20, 0, 0, 0); // 15:00 CDT / 14:00 CST
  // Always in the future, so jobs created "now" are already due at this time.
  if (d.getTime() < Date.now() + 60_000) d.setTime(d.getTime() + 86_400_000);
  return new Date(d.getTime() + daysFromNow * 86_400_000);
}

/** A fixed-offset timezone in which the current moment is 23:00 local (quiet hours). */
export function timezoneWhereItIsLateNight(): string {
  let offset = (23 - new Date().getUTCHours() + 24) % 24; // hours ahead of UTC
  if (offset > 14) offset -= 24;
  // Etc/GMT zones use inverted signs: Etc/GMT-5 is UTC+5.
  return offset === 0 ? 'Etc/GMT' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`;
}

/** Run jobs until the queue is idle at `now` (jobs can enqueue more jobs). */
export async function settle(now = daytime()) {
  let total = 0;
  for (let i = 0; i < 20; i++) {
    const ran = await runDueJobs({ now });
    total += ran;
    if (ran === 0) break;
  }
  return total;
}
