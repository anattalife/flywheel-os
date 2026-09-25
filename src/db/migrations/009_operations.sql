-- 009_operations: worker heartbeats for monitoring, and alert rate limiting.

create table heartbeats (
  name  text primary key,
  at    timestamptz not null default now(),
  info  jsonb not null default '{}'
);

create table alerts_sent (
  kind     text primary key,
  sent_at  timestamptz not null default now()
);

-- Queue health across all businesses, for the monitoring endpoint. Numbers only.
create or replace function queue_stats()
returns table (due integer, oldest_due_seconds integer, failed_24h integer, running integer)
language sql stable security definer set search_path = public as $$
  select
    (select count(*)::int from jobs where status = 'pending' and run_at <= now()),
    (select coalesce(extract(epoch from now() - min(run_at)), 0)::int from jobs where status = 'pending' and run_at <= now()),
    (select count(*)::int from jobs where status = 'failed' and updated_at > now() - interval '24 hours'),
    (select count(*)::int from jobs where status = 'running')
$$;

-- Deleting a whole business: the only place events may be removed.
create or replace function purge_business(p_business uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform set_config('app.allow_event_purge', 'on', true);
  delete from jobs where business_id = p_business;
  delete from sessions where business_id = p_business;
  delete from portal_tokens where business_id = p_business;
  delete from businesses where id = p_business;
end $$;
