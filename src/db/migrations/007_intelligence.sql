-- 007_intelligence: AI-proposed actions on drafts, the owner's morning brief,
-- owner text commands awaiting a YES, and saved insights.

alter table drafts add column action jsonb;

alter table users add column notify_brief boolean not null default true;
alter table users add column brief_hour smallint not null default 7 check (brief_hour between 0 and 23);

create table owner_commands (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references businesses(id) on delete cascade,
  user_id      uuid not null references users(id) on delete cascade,
  summary      text not null,
  action       jsonb not null,
  status       text not null default 'pending' check (status in ('pending','done','cancelled','expired')),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '15 minutes'
);
alter table owner_commands enable row level security;
create policy tenant_isolation on owner_commands using (business_id = app_business_id()) with check (business_id = app_business_id());

create table insights (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  kind          text not null,
  period_start  timestamptz not null,
  period_end    timestamptz not null,
  body          jsonb not null,
  created_at    timestamptz not null default now()
);
create index insights_business_kind on insights (business_id, kind, created_at desc);
alter table insights enable row level security;
create policy tenant_isolation on insights using (business_id = app_business_id()) with check (business_id = app_business_id());
