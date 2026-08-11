-- Telegram onboarding: a user must provide an e-mail address before the bot
-- accepts financial messages, receipts, reports, or account-linking commands.
-- The production identity table is public.ofa_users; legacy public.users is not
-- used by the Telegram backend and is intentionally left untouched.

create or replace function public.ensure_telegram_email_profile(
  p_telegram_user_id text,
  p_display_name text
)
returns table (user_id uuid, email text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_email citext;
  v_workspace_id uuid;
begin
  if nullif(trim(p_telegram_user_id), '') is null then
    raise exception 'Telegram user id is required';
  end if;

  select ca.user_id into v_user_id
  from public.channel_accounts ca
  where ca.channel = 'telegram'
    and ca.external_account_id = p_telegram_user_id
    and ca.unlinked_at is null
  for update;

  if v_user_id is null then
    v_user_id := gen_random_uuid();
    insert into public.ofa_users (id, display_name, last_seen_at)
    values (v_user_id, nullif(trim(p_display_name), ''), now());
    insert into public.auth_identities (user_id, provider, provider_subject, verified_at)
    values (v_user_id, 'telegram', p_telegram_user_id, now());
    insert into public.workspaces (name, workspace_type, base_currency_code, time_zone, created_by_user_id)
    values ('Môj rozpočet', 'personal', 'EUR', 'Europe/Bratislava', v_user_id)
    returning id into v_workspace_id;
    insert into public.workspace_members (workspace_id, user_id, role, status, joined_at)
    values (v_workspace_id, v_user_id, 'owner', 'active', now());
    insert into public.channel_accounts (user_id, channel, external_account_id, external_username)
    values (v_user_id, 'telegram', p_telegram_user_id, nullif(trim(p_display_name), ''));
  else
    update public.ofa_users
    set display_name = coalesce(nullif(trim(p_display_name), ''), display_name), last_seen_at = now()
    where id = v_user_id;
  end if;

  select u.email into v_email from public.ofa_users u where u.id = v_user_id;
  return query select v_user_id, v_email::text;
end;
$$;

create or replace function public.set_telegram_user_email(
  p_telegram_user_id text,
  p_display_name text,
  p_email text
)
returns table (user_id uuid, email text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_email text := lower(trim(p_email));
begin
  if v_email is null or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Invalid e-mail address';
  end if;

  select ep.user_id into v_user_id
  from public.ensure_telegram_email_profile(p_telegram_user_id, p_display_name) ep;

  update public.ofa_users
  set email = v_email, last_seen_at = now()
  where id = v_user_id;

  return query select v_user_id, v_email;
end;
$$;

revoke all on function public.ensure_telegram_email_profile(text, text) from public, anon, authenticated;
revoke all on function public.set_telegram_user_email(text, text, text) from public, anon, authenticated;
grant execute on function public.ensure_telegram_email_profile(text, text) to service_role;
grant execute on function public.set_telegram_user_email(text, text, text) to service_role;
