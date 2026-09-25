import { config } from '../config.js';
import { closePool } from '../db/pool.js';
import { runDueJobs } from './runner.js';
import { scheduleDaily } from './scheduler.js';
import { alertOperator, heartbeat, log, systemHealth } from '../core/ops.js';

let stopping = false;
async function loop() {
  console.log('worker started');
  let lastDaily = 0, lastBeat = 0, lastWatch = 0;
  while (!stopping) {
    try {
      if (Date.now() - lastBeat > 30_000) { await heartbeat('worker', { pid: process.pid }); lastBeat = Date.now(); }
      if (Date.now() - lastDaily > 10 * 60_000) { await scheduleDaily(); lastDaily = Date.now(); }
      if (Date.now() - lastWatch > 5 * 60_000) {
        lastWatch = Date.now();
        const h = await systemHealth();
        if (!h.ok) await alertOperator('queue', h.problems.join('; '));
      }
      const ran = await runDueJobs();
      if (ran === 0) await new Promise((r) => setTimeout(r, config().WORKER_POLL_MS));
    } catch (e) {
      log('error', 'worker loop error', { error: (e as Error).message });
      await alertOperator('worker', `worker loop error: ${(e as Error).message}`).catch(() => {});
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  await closePool();
  console.log('worker stopped');
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { stopping = true; });
void loop();
