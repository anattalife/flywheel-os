-- 010_security: database-backed limits on password reset codes, so restarts or
-- several app processes can't reset them.

-- At most 3 codes per user per hour. Returns false (and stores nothing) past that.
drop function if exists auth_store_code(uuid, text, text, int);
create function auth_store_code(p_user uuid, p_purpose text, p_code_hash text, p_minutes int)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from auth_codes where user_id = p_user and purpose = p_purpose and created_at > now() - interval '1 hour') >= 3 then
    return false;
  end if;
  update auth_codes set used_at = now() where user_id = p_user and purpose = p_purpose and used_at is null;
  insert into auth_codes (user_id, purpose, code_hash, expires_at) values (p_user, p_purpose, p_code_hash, now() + make_interval(mins => p_minutes));
  return true;
end $$;

-- Checks a code: at most 5 attempts per code and 10 wrong guesses per user per day, single use, unexpired.
create or replace function auth_use_code(p_user uuid, p_purpose text, p_code_hash text)
returns boolean language plpgsql security definer set search_path = public as $$
declare c auth_codes%rowtype;
begin
  if (select coalesce(sum(attempts), 0) from auth_codes where user_id = p_user and purpose = p_purpose and created_at > now() - interval '24 hours') >= 10 then
    return false;
  end if;
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
