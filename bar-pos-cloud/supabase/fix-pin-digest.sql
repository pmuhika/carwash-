-- Fix PIN login: function digest(text, unknown) does not exist
-- Run once in Supabase → SQL Editor

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pgcrypto;

create or replace function public.resolve_pin_login(p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_hash_sha text;
  v_hash_b64 text;
  v_count int;
  v_email text;
  v_name text;
  v_role text;
  v_pin text := trim(p_pin);
begin
  if v_pin is null or length(v_pin) < 4 then
    raise exception 'Enter a valid PIN';
  end if;

  v_hash_sha := encode(
    extensions.digest(convert_to(v_pin, 'UTF8'), 'sha256'::text),
    'hex'
  );
  v_hash_b64 := encode(convert_to(v_pin, 'UTF8'), 'base64');

  select count(*) into v_count
  from public.profiles
  where active = true
    and pin_hash is not null
    and (pin_hash = v_hash_sha or pin_hash = v_hash_b64);

  if v_count = 0 then
    raise exception 'Invalid PIN';
  end if;
  if v_count > 1 then
    raise exception 'PIN is not unique. Ask admin to set a unique PIN.';
  end if;

  select coalesce(nullif(login_email, ''), email_from_auth), full_name, role
  into v_email, v_name, v_role
  from (
    select p.login_email, p.full_name, p.role,
           (select u.email from auth.users u where u.id = p.id) as email_from_auth
    from public.profiles p
    where p.active = true
      and p.pin_hash is not null
      and (p.pin_hash = v_hash_sha or p.pin_hash = v_hash_b64)
    limit 1
  ) x;

  if v_email is null or v_email = '' then
    raise exception 'Account has no login email. Ask admin to recreate the user.';
  end if;

  return jsonb_build_object(
    'email', v_email,
    'full_name', v_name,
    'role', v_role
  );
end;
$$;

grant execute on function public.resolve_pin_login(text) to anon, authenticated;
