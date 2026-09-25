-- 001_core: the Owned Core. Every business-owned table carries business_id and is
-- protected by row-level security keyed on the per-transaction setting
-- app.business_id. The application connects as the non-owner role flywheel_app,
-- so RLS always applies to it; migrations run as the table owner.

create extension if not exists pgcrypto;

create or replace function app_business_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.business_id', true), '')::uuid
$$;

-- Businesses -----------------------------------------------------------------
create table businesses (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  pack_id         text not null,
  pack            jsonb not null,              -- resolved pack snapshot (defaults + owner overrides)
  timezone        text not null default 'America/Chicago',
  phone_number    text unique,                 -- E.164 business line (Twilio number)
  custom_domain   text unique,
  review_url      text,                        -- where review requests point
  settings        jsonb not null default '{}', -- AI provider choice, caps, quiet hours overrides
  api_key_hash    text unique,
  created_at      timestamptz not null default now()
);

-- Customers (called whatever the pack's vocabulary says) ----------------------
create table customers (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references businesses(id) on delete cascade,
  first_name        text,
  last_name         text,
  phone             text,                      -- E.164
  email             text,
  sms_consent       boolean not null default false,
  sms_consent_at    timestamptz,
  sms_consent_source text,                     -- 'web_form', 'inbound_text', 'import', 'verbal'
  sms_opted_out     boolean not null default false,  -- replied STOP: nothing is sent until START
  email_consent     boolean not null default false,
  status            text not null default 'lead' check (status in ('lead','active','lapsed','lost')),
  source            text,                      -- first touch, never overwritten
  source_detail     jsonb not null default '{}',
  tags              text[] not null default '{}',
  notes             text,
  last_visit_at     timestamptz,
  created_at        timestamptz not null default now(),
  unique (business_id, phone),
  unique (business_id, email)
);
create index customers_business_status on customers (business_id, status);

create table places (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references businesses(id) on delete cascade,
  customer_id  uuid references customers(id) on delete cascade,
  label        text,
  address      text,
  access_notes text,
  details      jsonb not null default '{}',     -- pack-defined fields (size, rooms, vehicle, pet...)
  created_at   timestamptz not null default now()
);

create table staff (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references businesses(id) on delete cascade,
  name         text not null,
  phone        text,
  role         text not null default 'provider',
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

create table services (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references businesses(id) on delete cascade,
  key          text not null,
  name         text not null,
  description  text,
  duration_min integer not null default 60,
  price_rule   jsonb not null,                  -- see packs/pricing.ts
  active       boolean not null default true,
  unique (business_id, key)
);

create table bookings (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references businesses(id) on delete cascade,
  customer_id     uuid not null references customers(id) on delete cascade,
  service_id      uuid references services(id),
  place_id        uuid references places(id),
  staff_id        uuid references staff(id),
  starts_at       timestamptz not null,
  ends_at         timestamptz not null,
  status          text not null default 'confirmed' check (status in ('requested','confirmed','completed','cancelled','no_show')),
  recurrence_key  text,                         -- pack recurrence option key, e.g. 'every_2_weeks'
  series_id       uuid,
  price_cents     integer,
  inputs          jsonb not null default '{}',  -- pricing inputs used for the quote
  notes           text,
  completed_at    timestamptz,
  created_at      timestamptz not null default now()
);
create index bookings_business_starts on bookings (business_id, starts_at);
create index bookings_customer on bookings (customer_id);

-- Every conversation, every channel -------------------------------------------
create table messages (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references businesses(id) on delete cascade,
  customer_id  uuid references customers(id) on delete cascade,
  direction    text not null check (direction in ('in','out')),
  channel      text not null check (channel in ('sms','email','voice','web','note')),
  body         text,
  kind         text not null default 'conversational' check (kind in ('conversational','transactional','marketing')),
  status       text not null default 'sent',
  provider_id  text,
  playbook     text,
  draft_id     uuid,                            -- set when the owner approved this message
  block_reason text,
  created_at   timestamptz not null default now()
);
create index messages_customer_created on messages (customer_id, created_at desc);

-- AI or playbook output waiting for the owner's approval
create table drafts (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references businesses(id) on delete cascade,
  customer_id  uuid not null references customers(id) on delete cascade,
  channel      text not null default 'sms',
  body         text not null,
  kind         text not null default 'conversational',
  playbook     text,
  reason       text,                            -- one line for the owner: why this draft exists
  status       text not null default 'pending' check (status in ('pending','approved','rejected','sent','blocked')),
  created_at   timestamptz not null default now(),
  decided_at   timestamptz
);
create index drafts_business_status on drafts (business_id, status);

create table payments (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references businesses(id) on delete cascade,
  customer_id  uuid references customers(id) on delete set null,
  booking_id   uuid references bookings(id) on delete set null,
  amount_cents integer not null,
  status       text not null check (status in ('pending','succeeded','failed','refunded')),
  provider     text not null default 'stripe',
  provider_id  text,
  failure_reason text,
  created_at   timestamptz not null default now()
);

create table reviews (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references businesses(id) on delete cascade,
  customer_id  uuid references customers(id) on delete set null,
  booking_id   uuid references bookings(id) on delete set null,
  platform     text not null default 'google',
  rating       integer check (rating between 1 and 5),
  body         text,
  reply        text,
  is_private_feedback boolean not null default false,
  created_at   timestamptz not null default now()
);

create table referrals (
  id                    uuid primary key default gen_random_uuid(),
  business_id           uuid not null references businesses(id) on delete cascade,
  referrer_id           uuid not null references customers(id) on delete cascade,
  code                  text not null,
  referred_customer_id  uuid references customers(id) on delete set null,
  status                text not null default 'open' check (status in ('open','converted','rewarded')),
  reward_cents          integer,
  created_at            timestamptz not null default now(),
  unique (business_id, code)
);

-- Coded answers that feed the Positioning loop
create table reasons (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references businesses(id) on delete cascade,
  customer_id  uuid references customers(id) on delete set null,
  kind         text not null check (kind in ('lost_quote','cancel','joined','feedback')),
  code         text not null,
  note         text,
  created_at   timestamptz not null default now()
);

-- Append-only event log ---------------------------------------------------------
create table events (
  id            bigserial primary key,
  business_id   uuid not null references businesses(id) on delete cascade,
  type          text not null,
  subject_type  text,
  subject_id    uuid,
  data          jsonb not null default '{}',
  occurred_at   timestamptz not null default now()
);
create index events_business_type_time on events (business_id, type, occurred_at desc);
create index events_subject on events (subject_id);

create or replace function events_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'events are append-only';
end $$;
create trigger events_no_update before update or delete on events
  for each row when (current_setting('app.allow_event_purge', true) is distinct from 'on')
  execute function events_append_only();

-- Durable job queue (not tenant-scoped: holds ids and small payloads only) --------
create table jobs (
  id           bigserial primary key,
  business_id  uuid references businesses(id) on delete cascade,
  type         text not null,
  payload      jsonb not null default '{}',
  run_at       timestamptz not null default now(),
  status       text not null default 'pending' check (status in ('pending','running','done','failed','cancelled')),
  attempts     integer not null default 0,
  max_attempts integer not null default 5,
  last_error   text,
  cancel_key   text,                            -- lets later events cancel scheduled steps
  dedupe_key   text unique,                     -- prevents double-scheduling the same step
  locked_until timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index jobs_due on jobs (status, run_at);
create index jobs_cancel_key on jobs (cancel_key) where status = 'pending';

-- Row-level security ------------------------------------------------------------
alter table businesses enable row level security;
create policy tenant_isolation on businesses
  using (id = app_business_id()) with check (id = app_business_id());

do $$
declare t text;
begin
  foreach t in array array['customers','places','staff','services','bookings','messages','drafts',
                           'payments','reviews','referrals','reasons','events'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy tenant_isolation on %I using (business_id = app_business_id()) with check (business_id = app_business_id())', t);
  end loop;
end $$;

-- Cross-tenant lookups the app needs before it knows the tenant. SECURITY DEFINER
-- runs as the owner (bypassing RLS) but only returns an id.
create or replace function find_business_by_phone(p text) returns uuid
language sql stable security definer set search_path = public as $$
  select id from businesses where phone_number = p
$$;
create or replace function find_business_by_domain(d text) returns uuid
language sql stable security definer set search_path = public as $$
  select id from businesses where custom_domain = lower(d)
$$;
create or replace function find_business_by_key_hash(h text) returns uuid
language sql stable security definer set search_path = public as $$
  select id from businesses where api_key_hash = h
$$;
