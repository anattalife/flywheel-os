// Loaded before every test file: points the app at a fresh test database.
import pg from 'pg';

const admin = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://postgres@localhost:5432/postgres';
const base = new URL(admin);
const dbName = process.env.TEST_DATABASE_NAME ?? 'flywheel_test';

Object.assign(process.env, {
  NODE_ENV: 'test',
  MIGRATION_DATABASE_URL: `${base.protocol}//${base.username}${base.password ? ':' + base.password : ''}@${base.host}/${dbName}`,
  DATABASE_URL: `${base.protocol}//flywheel_app:test@${base.host}/${dbName}`,
  APP_DB_PASSWORD: 'test',
  MESSAGING_PROVIDER: 'dev',
  PAYMENTS_PROVIDER: 'dev',
  AI_PROVIDER: 'none',
  ADMIN_TOKEN: 'test-admin-token-123456',
  PUBLIC_BASE_URL: 'https://app.example.test',
});

const client = new pg.Client({ connectionString: admin });
await client.connect();
await client.query(`drop database if exists ${dbName} with (force)`);
await client.query(`create database ${dbName}`);
await client.end();

const { migrate } = await import('../src/db/migrate.js');
const log = console.log;
console.log = () => {};
await migrate();
console.log = log;
