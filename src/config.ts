import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
  // App connects as the non-owner role so row-level security always applies.
  DATABASE_URL: z.string().default('postgres://flywheel_app:flywheel_app@localhost:5432/flywheel'),
  // Migrations run as the owner role.
  MIGRATION_DATABASE_URL: z.string().optional(),
  APP_DB_PASSWORD: z.string().optional(),
  DATABASE_SSL: z.enum(['off', 'require']).default('off'),
  ADMIN_TOKEN: z.string().min(16).default('dev-admin-token-change-me'),
  // Signs links in texts (pay, receipt) and encrypts stored secrets. Long and random in production.
  APP_SECRET: z.string().min(32).default('dev-app-secret-change-me-dev-app-secret-change-me'),

  // Rented pipes
  MESSAGING_PROVIDER: z.enum(['twilio', 'dev']).default('dev'),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_MESSAGING_SERVICE_SID: z.string().optional(),
  PAYMENTS_PROVIDER: z.enum(['stripe', 'dev']).default('dev'),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  // Platform default AI; each business can override in settings.ai
  AI_PROVIDER: z.enum(['anthropic', 'openai_compatible', 'none']).default('none'),
  AI_MODEL: z.string().default('claude-sonnet-5'),
  AI_FAST_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  AI_BASE_URL: z.string().optional(),      // for openai_compatible (OpenAI, Gemini, Ollama, ...)
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_COMPATIBLE_API_KEY: z.string().optional(),

  // Email (Amazon SES). EMAIL_FROM must be a verified sender in SES.
  EMAIL_PROVIDER: z.enum(['ses', 'dev']).default('dev'),
  EMAIL_FROM: z.string().default('hello@example.com'),
  SES_REGION: z.string().default('us-east-1'),
  SES_ACCESS_KEY_ID: z.string().optional(),
  SES_SECRET_ACCESS_KEY: z.string().optional(),
  ALLOW_SIGNUP: z.enum(['true', 'false']).default('false'),

  // File storage for job photos: local disk, or an S3-compatible bucket (Lightsail object storage).
  STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
  STORAGE_DIR: z.string().default('./data/uploads'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_ENDPOINT: z.string().url().optional(),

  // Google Business Profile (OAuth client from Google Cloud console; API access must be approved by Google)
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  // Operator alerts (the person running the server): errors, a stalled worker, a backed-up queue.
  ALERT_PHONE: z.string().optional(),
  ALERT_FROM_PHONE: z.string().optional(),
  ALERT_EMAIL: z.string().optional(),
  MONITOR_TOKEN: z.string().min(16).optional(),

  WORKER_POLL_MS: z.coerce.number().default(1000),
});

export type Config = z.infer<typeof schema>;
let cached: Config | undefined;
export function config(): Config {
  if (!cached) {
    cached = schema.parse(process.env);
    if (cached.NODE_ENV === 'production') {
      for (const k of ['ADMIN_TOKEN', 'APP_SECRET'] as const) {
        if (/change-me/i.test(cached[k]) || cached[k].length < 32) throw new Error(`${k} must be set to a long random value (32+ characters) in production`);
      }
      if (cached.MESSAGING_PROVIDER === 'twilio' && !cached.TWILIO_AUTH_TOKEN) throw new Error('TWILIO_AUTH_TOKEN is required to verify Twilio webhooks');
    }
  }
  return cached;
}
export function resetConfigForTests() { cached = undefined; }
