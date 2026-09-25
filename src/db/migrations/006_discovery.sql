-- 006_discovery: Google Business Profile connection, synced reviews and replies,
-- job photos, Business Profile posts, and AI-assistant visibility checks.

create table integrations (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references businesses(id) on delete cascade,
  provider       text not null check (provider in ('google')),
  credentials    text,                     -- encrypted with APP_SECRET (lib/crypto.ts)
  account        text,                     -- e.g. accounts/123
  location       text,                     -- e.g. locations/456
  location_title text,
  status         text not null default 'connected' check (status in ('connected','needs_location','error','disconnected')),
  connected_at   timestamptz not null default now(),
  last_sync_at   timestamptz,
  last_error     text,
  unique (business_id, provider)
);
alter table integrations enable row level security;
create policy tenant_isolation on integrations using (business_id = app_business_id()) with check (business_id = app_business_id());

alter table reviews add column external_id text;
alter table reviews add column reviewer_name text;
alter table reviews add column reply_draft text;
alter table reviews add column reply_status text not null default 'none' check (reply_status in ('none','drafted','posted','failed'));
alter table reviews add column replied_at timestamptz;
create unique index reviews_external on reviews (business_id, platform, external_id) where external_id is not null;

create table photos (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references businesses(id) on delete cascade,
  booking_id     uuid references bookings(id) on delete set null,
  customer_id    uuid references customers(id) on delete set null,
  storage_key    text not null,
  content_type   text not null,
  bytes          integer not null,
  public_ok      boolean not null default false,   -- the customer agreed to public use
  caption        text,
  created_at     timestamptz not null default now()
);
create index photos_business_created on photos (business_id, created_at desc);
alter table photos enable row level security;
create policy tenant_isolation on photos using (business_id = app_business_id()) with check (business_id = app_business_id());

create table gbp_posts (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  photo_id      uuid references photos(id) on delete set null,
  body          text not null,
  status        text not null default 'draft' check (status in ('draft','published','failed','rejected')),
  external_id   text,
  error         text,
  created_at    timestamptz not null default now(),
  published_at  timestamptz
);
alter table gbp_posts enable row level security;
create policy tenant_isolation on gbp_posts using (business_id = app_business_id()) with check (business_id = app_business_id());

create table ai_checks (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references businesses(id) on delete cascade,
  query        text not null,
  mentioned    boolean not null,
  excerpt      text,
  provider     text not null,
  created_at   timestamptz not null default now()
);
alter table ai_checks enable row level security;
create policy tenant_isolation on ai_checks using (business_id = app_business_id()) with check (business_id = app_business_id());

-- Media links carry a photo id; this finds its business before the tenant is known.
create or replace function photo_business(p_photo uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select business_id from photos where id = p_photo
$$;
