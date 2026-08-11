-- Web authentication and dashboard access.
-- Browser clients use a Supabase publishable key; all tenant data remains gated
-- by the authenticated user's active workspace membership.

alter table public.ofa_users
  add column if not exists auth_user_id uuid references auth.users(id) on delete set null;

create unique index if not exists ofa_users_auth_user_id_key
  on public.ofa_users (auth_user_id) where auth_user_id is not null;

create table public.telegram_link_codes (
  id uuid primary key default gen_random_uuid(),
  target_user_id uuid not null references public.ofa_users(id) on delete cascade,
  code_hash bytea not null unique check (octet_length(code_hash) = 32),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_by_user_id uuid references public.ofa_users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (expires_at > created_at),
  check (consumed_at is null or consumed_at <= expires_at)
);
create index telegram_link_codes_target_active_idx
  on public.telegram_link_codes (target_user_id, expires_at desc)
  where consumed_at is null;
alter table public.telegram_link_codes enable row level security;

-- SECURITY DEFINER is necessary because these helpers read the RLS-protected
-- membership table. Both functions derive identity solely from auth.uid().
create or replace function public.current_ofa_user_id()
returns uuid
language sql
stable
security definer
set search_path = public, auth
as $$
  select u.id
  from public.ofa_users u
  where u.auth_user_id = auth.uid()
    and u.status = 'active'
    and u.deleted_at is null
  limit 1;
$$;

create or replace function public.is_current_user_workspace_member(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = p_workspace_id
      and wm.user_id = public.current_ofa_user_id()
      and wm.status = 'active'
      and wm.removed_at is null
  );
$$;

revoke all on function public.current_ofa_user_id() from public, anon;
revoke all on function public.is_current_user_workspace_member(uuid) from public, anon;
grant execute on function public.current_ofa_user_id() to authenticated, service_role;
grant execute on function public.is_current_user_workspace_member(uuid) to authenticated, service_role;

create or replace function public.handle_new_web_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_workspace_id uuid;
begin
  insert into public.ofa_users (id, auth_user_id, display_name, email)
  values (
    new.id,
    new.id,
    nullif(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'), ''),
    new.email
  );

  insert into public.workspaces (name, workspace_type, base_currency_code, time_zone, created_by_user_id)
  values (coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), 'Môj rozpočet'), 'personal', 'EUR', 'Europe/Bratislava', new.id)
  returning id into v_workspace_id;

  insert into public.workspace_members (workspace_id, user_id, role, status, joined_at)
  values (v_workspace_id, new.id, 'owner', 'active', now());

  insert into public.auth_identities (user_id, provider, provider_subject, verified_at)
  values (new.id, 'email', new.id::text, case when new.email_confirmed_at is null then null else now() end)
  on conflict (provider, provider_subject) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_web_auth_user();

-- Safely creates profiles/workspaces for any Auth users that existed before this
-- migration. New users are handled by the trigger above.
insert into public.ofa_users (id, auth_user_id, display_name, email)
select
  au.id,
  au.id,
  nullif(coalesce(au.raw_user_meta_data ->> 'full_name', au.raw_user_meta_data ->> 'name'), ''),
  au.email
from auth.users au
where not exists (select 1 from public.ofa_users u where u.auth_user_id = au.id);

with created_workspaces as (
  insert into public.workspaces (name, workspace_type, base_currency_code, time_zone, created_by_user_id)
  select coalesce(nullif(u.display_name, ''), 'Môj rozpočet'), 'personal', 'EUR', u.time_zone, u.id
  from public.ofa_users u
  where u.auth_user_id is not null
    and not exists (
      select 1 from public.workspace_members wm
      where wm.user_id = u.id and wm.status = 'active' and wm.removed_at is null
    )
  returning id, created_by_user_id
)
insert into public.workspace_members (workspace_id, user_id, role, status, joined_at)
select id, created_by_user_id, 'owner', 'active', now()
from created_workspaces;

insert into public.auth_identities (user_id, provider, provider_subject, verified_at)
select u.id, 'email', au.id::text, case when au.email_confirmed_at is null then null else now() end
from auth.users au
join public.ofa_users u on u.auth_user_id = au.id
on conflict (provider, provider_subject) do nothing;

create or replace function public.create_telegram_link_code()
returns table (code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_user_id uuid := public.current_ofa_user_id();
  v_code text := upper(encode(gen_random_bytes(5), 'hex'));
  v_expires_at timestamptz := now() + interval '15 minutes';
begin
  if v_user_id is null then
    raise exception 'Authenticated OFA profile not found';
  end if;

  update public.telegram_link_codes
  set expires_at = now()
  where target_user_id = v_user_id and consumed_at is null and expires_at > now();

  insert into public.telegram_link_codes (target_user_id, code_hash, expires_at)
  values (v_user_id, digest(v_code, 'sha256'), v_expires_at);

  return query select v_code, v_expires_at;
end;
$$;

-- Called only by the trusted Telegram backend. A code is never stored in clear
-- text and can be consumed once within 15 minutes.
create or replace function public.consume_telegram_link_code(
  p_telegram_user_id text,
  p_display_name text,
  p_code text
)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_link public.telegram_link_codes%rowtype;
  v_telegram_user_id uuid;
  v_web_auth_user_id uuid;
  v_telegram_auth_user_id uuid;
  v_workspace_id uuid;
begin
  select * into v_link
  from public.telegram_link_codes
  where code_hash = digest(upper(trim(p_code)), 'sha256')
    and consumed_at is null
    and expires_at > now()
  for update;

  if v_link.id is null then
    raise exception 'Pairing code is invalid or expired';
  end if;

  select auth_user_id into v_web_auth_user_id
  from public.ofa_users
  where id = v_link.target_user_id and status = 'active' and deleted_at is null
  for update;

  if v_web_auth_user_id is null then
    raise exception 'Web account is not active';
  end if;

  select ca.user_id into v_telegram_user_id
  from public.channel_accounts ca
  where ca.channel = 'telegram'
    and ca.external_account_id = p_telegram_user_id
    and ca.unlinked_at is null
  for update;

  if v_telegram_user_id is null then
    v_telegram_user_id := gen_random_uuid();
    insert into public.ofa_users (id, display_name)
    values (v_telegram_user_id, nullif(p_display_name, ''));
    insert into public.auth_identities (user_id, provider, provider_subject, verified_at)
    values (v_telegram_user_id, 'telegram', p_telegram_user_id, now());
    insert into public.workspaces (name, workspace_type, base_currency_code, time_zone, created_by_user_id)
    values ('Môj rozpočet', 'personal', 'EUR', 'Europe/Bratislava', v_telegram_user_id)
    returning id into v_workspace_id;
    insert into public.workspace_members (workspace_id, user_id, role, status, joined_at)
    values (v_workspace_id, v_telegram_user_id, 'owner', 'active', now());
    insert into public.channel_accounts (user_id, channel, external_account_id, external_username)
    values (v_telegram_user_id, 'telegram', p_telegram_user_id, nullif(p_display_name, ''));
  end if;

  select auth_user_id into v_telegram_auth_user_id
  from public.ofa_users where id = v_telegram_user_id for update;

  if v_telegram_auth_user_id is not null and v_telegram_auth_user_id <> v_web_auth_user_id then
    raise exception 'This Telegram account is already linked to another web account';
  end if;

  if v_telegram_user_id <> v_link.target_user_id then
    -- The temporary empty profile and its workspace are retired, not deleted.
    update public.workspaces set deleted_at = now()
    where created_by_user_id = v_link.target_user_id and deleted_at is null;
    update public.workspace_members set status = 'removed', removed_at = now()
    where user_id = v_link.target_user_id and status = 'active';
    update public.auth_identities set user_id = v_telegram_user_id
    where user_id = v_link.target_user_id and provider = 'email';
    update public.ofa_users set auth_user_id = null, status = 'deleted', deleted_at = now()
    where id = v_link.target_user_id;
  end if;

  update public.ofa_users
  set auth_user_id = v_web_auth_user_id, updated_at = now()
  where id = v_telegram_user_id;

  update public.telegram_link_codes
  set consumed_at = now(), consumed_by_user_id = v_telegram_user_id
  where id = v_link.id;

  return v_telegram_user_id;
end;
$$;

revoke all on function public.create_telegram_link_code() from public, anon;
revoke all on function public.consume_telegram_link_code(text, text, text) from public, anon, authenticated;
grant execute on function public.create_telegram_link_code() to authenticated, service_role;
grant execute on function public.consume_telegram_link_code(text, text, text) to service_role;

create policy "users can view their own profile"
  on public.ofa_users for select to authenticated
  using (id = public.current_ofa_user_id());

create policy "members can view their workspaces"
  on public.workspaces for select to authenticated
  using (public.is_current_user_workspace_member(id) and deleted_at is null);

create policy "members can view workspace memberships"
  on public.workspace_members for select to authenticated
  using (public.is_current_user_workspace_member(workspace_id));

create policy "users can view their identities"
  on public.auth_identities for select to authenticated
  using (user_id = public.current_ofa_user_id());

create policy "users can view their active channel accounts"
  on public.channel_accounts for select to authenticated
  using (user_id = public.current_ofa_user_id() and unlinked_at is null);

create policy "members can view available categories"
  on public.categories for select to authenticated
  using (workspace_id is null or public.is_current_user_workspace_member(workspace_id));

create policy "members can view transactions"
  on public.financial_transactions for select to authenticated
  using (public.is_current_user_workspace_member(workspace_id) and deleted_at is null);

create policy "members can view transaction category history"
  on public.transaction_category_assignments for select to authenticated
  using (exists (
    select 1 from public.financial_transactions ft
    where ft.id = transaction_category_assignments.transaction_id
      and public.is_current_user_workspace_member(ft.workspace_id)
      and ft.deleted_at is null
  ));

create policy "members can view receipts"
  on public.ofa_receipts for select to authenticated
  using (public.is_current_user_workspace_member(workspace_id) and deleted_at is null);

create policy "members can view receipt file metadata"
  on public.stored_files for select to authenticated
  using (public.is_current_user_workspace_member(workspace_id) and deleted_at is null);

grant select on public.ofa_users, public.workspaces, public.workspace_members,
  public.auth_identities, public.channel_accounts, public.categories,
  public.financial_transactions, public.transaction_category_assignments,
  public.ofa_receipts, public.stored_files to authenticated;
