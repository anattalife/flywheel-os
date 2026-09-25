-- 005_retention: customer health, referral codes and account credit.

alter table customers add column health_score integer check (health_score between 0 and 100);
alter table customers add column health_reasons text[] not null default '{}';
alter table customers add column health_updated_at timestamptz;
alter table customers add column referral_code text;
create unique index customers_referral_code on customers (business_id, referral_code) where referral_code is not null;
create index customers_health on customers (business_id, health_score);

alter table referrals add column friend_credit_cents integer;
alter table referrals add column reward_granted_at timestamptz;
create unique index referrals_referred on referrals (business_id, referred_customer_id) where referred_customer_id is not null;
alter table referrals drop constraint referrals_business_id_code_key;

-- Positive rows grant credit, negative rows spend it on an invoice.
create table credits (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  customer_id   uuid not null references customers(id) on delete cascade,
  amount_cents  integer not null check (amount_cents <> 0),
  reason        text not null,
  referral_id   uuid references referrals(id) on delete set null,
  invoice_id    uuid references invoices(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index credits_customer on credits (customer_id);
alter table credits enable row level security;
create policy tenant_isolation on credits using (business_id = app_business_id()) with check (business_id = app_business_id());
