import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import { config } from '../config.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Apply pending migrations as the owner role, then grant the app role what it needs. */
export async function migrate(connectionString = config().MIGRATION_DATABASE_URL ?? config().DATABASE_URL) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
    const done = new Set((await client.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name));
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await readFile(path.join(dir, f), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [f]);
        await client.query('commit');
        console.log(`migrated ${f}`);
      } catch (e) {
        await client.query('rollback');
        throw new Error(`migration ${f} failed: ${(e as Error).message}`);
      }
    }
    const pw = config().APP_DB_PASSWORD;
    if (pw) {
      const exists = await client.query(`select 1 from pg_roles where rolname = 'flywheel_app'`);
      const quoted = `'${pw.replace(/'/g, "''")}'`;
      await client.query(exists.rowCount ? `alter role flywheel_app with login password ${quoted}` : `create role flywheel_app with login password ${quoted}`);
    }
    await client.query(`
      do $$ begin
        if exists (select 1 from pg_roles where rolname = 'flywheel_app') then
          grant usage on schema public to flywheel_app;
          grant select, insert, update, delete on all tables in schema public to flywheel_app;
          grant usage, select on all sequences in schema public to flywheel_app;
          grant execute on all functions in schema public to flywheel_app;
          revoke insert, update, delete on schema_migrations from flywheel_app;
          -- Sessions and one-time codes are reachable only through the auth_* functions.
          if to_regclass('public.sessions') is not null then
            revoke all on sessions, auth_codes from flywheel_app;
          end if;
          if to_regclass('public.portal_tokens') is not null then
            revoke all on portal_tokens from flywheel_app;
          end if;
        end if;
      end $$;`);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  migrate().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
}
