-- Technical record of privacy information shown to an account. It is not
-- legal consent and does not change any existing account or financial row.
create unique index if not exists user_consents_privacy_notice_version_key
  on public.user_consents (user_id, consent_type, policy_version)
  where consent_type = 'privacy_notice_ack';

create or replace function public.has_my_privacy_notice_ack(p_version text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_consents consent
    where consent.user_id = public.current_ofa_user_id()
      and consent.consent_type = 'privacy_notice_ack'
      and consent.policy_version = p_version
      and consent.granted = true
      and consent.withdrawn_at is null
  );
$$;

create or replace function public.acknowledge_my_privacy_notice(p_version text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := public.current_ofa_user_id();
begin
  if v_user_id is null or p_version is null or p_version !~ '^[a-zA-Z0-9._-]{1,32}$' then
    raise exception 'Verified active account and valid version required' using errcode = '42501';
  end if;
  insert into public.user_consents (user_id, consent_type, policy_version, granted, evidence)
  values (v_user_id, 'privacy_notice_ack', p_version, true, '{"channel":"web"}'::jsonb)
  on conflict (user_id, consent_type, policy_version)
    where consent_type = 'privacy_notice_ack'
  do nothing;
  return true;
end;
$$;

revoke all on function public.has_my_privacy_notice_ack(text) from public, anon, service_role;
revoke all on function public.acknowledge_my_privacy_notice(text) from public, anon, service_role;
grant execute on function public.has_my_privacy_notice_ack(text) to authenticated;
grant execute on function public.acknowledge_my_privacy_notice(text) to authenticated;
