-- 002_auth: people who log in (the owner, later team members), their sessions,
-- and one-time codes for password resets and customer portal links.

create table users (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references businesses(id) on delete cascade,
  email          text not null unique,          -- global: one login per email
  phone          text,                          -- E.164, for reset codes and alerts
  name           text,
  role           text not null default 'owner' check (role in ('owner','staff')),
  password_hash  text not null,
  created_at     timestamptz not null default now(),
  last_login_at  timestamptz
);
alter table users enable row level security;
create policy tenant_isolation on users using (business_id = app_business_id()) with check (business_id = app_business_id());

-- Sessions are looked up before the tenant is known, so they live outside RLS and are
-- only reachable through the functions below. Tokens are stored hashed.
create table sessions (
  token_hash    text primary key,
  user_id       uuid not null references users(id) on delete cascade,
  business_id   uuid not null references businesses(id) on delete cascade,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  user_agent    text
);
create index sessions_user on sessions (user_id);

create table auth_codes (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references users(id) on delete cascade,
  purpose      text not null check (purpose in ('password_reset')),
  code_hash    text not null,
  expires_at   timestamptz not null,
  attempts     integer not null default 0,
  used_at      timestamptz,
  created_at   timestamptz not null default now()
);
create index auth_codes_user on auth_codes (user_id, purpose);

revoke all on sessions, auth_codes from public;

create or replace function auth_find_user(p_email text)
returns table (id uuid, business_id uuid, password_hash text, phone text, role text)
language sql stable security definer set search_path = public as $$
  select id, business_id, password_hash, phone, role from users where email = lower(p_email)
$$;

create or replace function auth_session(p_token_hash text)
returns table (user_id uuid, business_id uuid, role text, name text, email text)
language sql security definer set search_path = public as $$
  update sessions s set last_seen_at = now()
  from users u
  where s.token_hash = p_token_hash and s.expires_at > now() and u.id = s.user_id
  returning s.user_id, s.business_id, u.role, u.name, u.email
$$;

create or replace function auth_create_session(p_token_hash text, p_user uuid, p_days int, p_agent text)
returns void language sql security definer set search_path = public as $$
  insert into sessions (token_hash, user_id, business_id, expires_at, user_agent)
  select p_token_hash, u.id, u.business_id, now() + make_interval(days => p_days), left(p_agent, 300)
  from users u where u.id = p_user;
  update users set last_login_at = now() where id = p_user;
$$;

create or replace function auth_end_session(p_token_hash text)
returns void language sql security definer set search_path = public as $$
  delete from sessions where token_hash = p_token_hash
$$;

create or replace function auth_store_code(p_user uuid, p_purpose text, p_code_hash text, p_minutes int)
returns void language sql security definer set search_path = public as $$
  update auth_codes set used_at = now() where user_id = p_user and purpose = p_purpose and used_at is null;
  insert into auth_codes (user_id, purpose, code_hash, expires_at) values (p_user, p_purpose, p_code_hash, now() + make_interval(mins => p_minutes));
$$;

-- Checks a code: at most 5 attempts, single use, unexpired. Returns true once.
create or replace function auth_use_code(p_user uuid, p_purpose text, p_code_hash text)
returns boolean language plpgsql security definer set search_path = public as $$
declare c auth_codes%rowtype;
begin
  select * into c from auth_codes
   where user_id = p_user and purpose = p_purpose and used_at is null and expires_at > now()
   order by created_at desc limit 1 for update;
  if not found then return false; end if;
  if c.attempts >= 5 then return false; end if;
  if c.code_hash <> p_code_hash then
    update auth_codes set attempts = attempts + 1 where id = c.id;
    return false;
  end if;
  update auth_codes set used_at = now() where id = c.id;
  return true;
end $$;

-- Password change from a verified reset: also signs out every session.
create or replace function auth_set_password(p_user uuid, p_hash text)
returns void language sql security definer set search_path = public as $$
  update users set password_hash = p_hash where id = p_user;
  delete from sessions where user_id = p_user;
$$;
