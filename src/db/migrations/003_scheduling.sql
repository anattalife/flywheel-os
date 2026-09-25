-- 003_scheduling: opening hours, time off, recurring series, booking sources, and
-- magic links for the customer portal.

alter table services add column position integer not null default 0;
alter table services add column bookable_online boolean not null default true;

-- Weekly opening hours in the business's own timezone. Several ranges per day allowed.
create table business_hours (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references businesses(id) on delete cascade,
  weekday      smallint not null check (weekday between 0 and 6),   -- 0 = Sunday
  opens        time not null,
  closes       time not null check (closes > opens)
);
create index business_hours_business on business_hours (business_id, weekday);

create table time_off (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references businesses(id) on delete cascade,
  staff_id     uuid references staff(id) on delete cascade,
  starts_at    timestamptz not null,
  ends_at      timestamptz not null check (ends_at > starts_at),
  reason       text
);
create index time_off_business on time_off (business_id, starts_at);

-- A recurring arrangement ("every 2 weeks on Tuesdays at 10"). Individual visits are
-- generated ahead as bookings, so each can be moved or skipped on its own.
create table series (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references businesses(id) on delete cascade,
  customer_id     uuid not null references customers(id) on delete cascade,
  service_id      uuid references services(id),
  place_id        uuid references places(id),
  staff_id        uuid references staff(id),
  recurrence_key  text not null,
  interval_days   integer not null check (interval_days > 0),
  anchor_at       timestamptz not null,           -- the first visit; later ones keep its time of day
  duration_min    integer not null,
  price_cents     integer,
  inputs          jsonb not null default '{}',
  status          text not null default 'active' check (status in ('active','paused','ended')),
  paused_until    timestamptz,
  created_at      timestamptz not null default now()
);
create index series_business_status on series (business_id, status);

alter table bookings add column source text not null default 'owner' check (source in ('owner','online','portal','ai','series','import'));
alter table bookings add column skipped boolean not null default false;
alter table bookings add constraint bookings_series_fk foreign key (series_id) references series(id) on delete set null;
create unique index bookings_series_slot on bookings (series_id, starts_at) where series_id is not null;
create index bookings_business_status_starts on bookings (business_id, status, starts_at);

alter table series enable row level security;
create policy tenant_isolation on series using (business_id = app_business_id()) with check (business_id = app_business_id());
alter table business_hours enable row level security;
create policy tenant_isolation on business_hours using (business_id = app_business_id()) with check (business_id = app_business_id());
alter table time_off enable row level security;
create policy tenant_isolation on time_off using (business_id = app_business_id()) with check (business_id = app_business_id());

-- Customer portal magic links: the token in the link is the credential.
create table portal_tokens (
  token_hash   text primary key,
  business_id  uuid not null references businesses(id) on delete cascade,
  customer_id  uuid not null references customers(id) on delete cascade,
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now()
);
create index portal_tokens_customer on portal_tokens (customer_id);
revoke all on portal_tokens from public;

create or replace function portal_issue(p_token_hash text, p_business uuid, p_customer uuid, p_days int)
returns void language sql security definer set search_path = public as $$
  insert into portal_tokens (token_hash, business_id, customer_id, expires_at)
  select p_token_hash, c.business_id, c.id, now() + make_interval(days => p_days)
  from customers c where c.id = p_customer and c.business_id = p_business;
$$;

create or replace function portal_lookup(p_token_hash text)
returns table (business_id uuid, customer_id uuid)
language sql stable security definer set search_path = public as $$
  select business_id, customer_id from portal_tokens where token_hash = p_token_hash and expires_at > now()
$$;

-- The worker schedules daily upkeep for every business; this is the only
-- cross-tenant listing it needs, and it returns ids only.
create or replace function list_business_ids()
returns table (id uuid) language sql stable security definer set search_path = public as $$
  select id from businesses
$$;
