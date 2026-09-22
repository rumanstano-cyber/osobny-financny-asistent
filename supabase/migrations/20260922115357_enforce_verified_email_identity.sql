-- Keep the existing web authorization model, but require the authoritative
-- Supabase Auth record to have a confirmed email before it can resolve to an
-- application user. All dashboard RLS policies and Telegram link-code minting
-- already depend on this helper, so this closes those paths centrally without
-- changing any user, workspace or financial data.
create or replace function public.current_ofa_user_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.id
  from public.ofa_users u
  join auth.users auth_user on auth_user.id = u.auth_user_id
  where u.auth_user_id = auth.uid()
    and auth_user.email_confirmed_at is not null
    and u.status = 'active'
    and u.deleted_at is null
  limit 1;
$$;

-- CREATE OR REPLACE preserves ACLs, but repeat the intended boundary
-- explicitly so future migration order cannot broaden this web-session helper.
revoke all on function public.current_ofa_user_id() from public, anon, service_role;
grant execute on function public.current_ofa_user_id() to authenticated;
