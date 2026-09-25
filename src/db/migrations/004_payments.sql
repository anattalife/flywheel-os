-- 004_payments: invoices customers pay, saved cards, refunds, and a ledger of
-- Stripe events already handled (webhooks can arrive more than once).

alter table customers add column stripe_customer_id text;
alter table customers add column default_payment_method text;
alter table customers add column card_brand text;
alter table customers add column card_last4 text;

create table invoices (
  id                 uuid primary key default gen_random_uuid(),
  business_id        uuid not null references businesses(id) on delete cascade,
  customer_id        uuid not null references customers(id) on delete cascade,
  booking_id         uuid references bookings(id) on delete set null,
  number             integer not null,
  description        text not null,
  amount_cents       integer not null check (amount_cents >= 0),
  refunded_cents     integer not null default 0,
  status             text not null default 'open' check (status in ('open','paid','failed','void','refunded')),
  payment_intent_id  text,
  failure_reason     text,
  attempts           integer not null default 0,
  paid_at            timestamptz,
  created_at         timestamptz not null default now(),
  unique (business_id, number)
);
create unique index invoices_booking on invoices (booking_id) where booking_id is not null and status <> 'void';
create index invoices_business_status on invoices (business_id, status);
alter table invoices enable row level security;
create policy tenant_isolation on invoices using (business_id = app_business_id()) with check (business_id = app_business_id());

alter table payments add column invoice_id uuid references invoices(id) on delete set null;
alter table payments add column kind text not null default 'charge' check (kind in ('charge','refund'));
alter table payments drop constraint payments_status_check;
alter table payments add constraint payments_status_check check (status in ('pending','succeeded','failed','refunded','requires_action'));
create unique index payments_provider_kind on payments (provider_id, kind) where provider_id is not null;

create table stripe_events (
  id          text primary key,
  type        text not null,
  received_at timestamptz not null default now()
);

-- Pay and receipt links in texts carry an invoice id; this finds its business.
create or replace function invoice_business(p_invoice uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select business_id from invoices where id = p_invoice
$$;

alter table payments add column method text not null default 'card' check (method in ('card','cash','check','other'));
