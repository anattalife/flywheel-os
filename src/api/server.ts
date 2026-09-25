import { config } from '../config.js';
import { closePool } from '../db/pool.js';
import { createApp } from './app.js';

const server = createApp();
server.listen(config().PORT, () => console.log(`api listening on :${config().PORT}`));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close(async () => { await closePool(); process.exit(0); });
  });
}
