-- 008_channels: email as a second channel, photos in texts, and delivery results.

alter table messages add column subject text;
alter table messages add column media_urls text[] not null default '{}';
alter table messages add column error_code text;
alter table messages add column delivered_at timestamptz;
create index messages_provider on messages (provider_id) where provider_id is not null;

-- Delivery callbacks name the message, not the business; this finds the business.
create or replace function message_business_by_provider(p_provider_id text)
returns uuid language sql stable security definer set search_path = public as $$
  select business_id from messages where provider_id = p_provider_id limit 1
$$;

create or replace function customer_business(p_customer uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select business_id from customers where id = p_customer
$$;
