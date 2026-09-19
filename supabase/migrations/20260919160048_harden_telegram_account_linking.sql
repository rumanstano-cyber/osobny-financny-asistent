-- Harden the existing web <-> Telegram linking flow without changing financial data.
-- Existing unconsumed codes are expired because their former 40-bit entropy is not
-- sufficient for a production account-linking credential.
update public.telegram_link_codes
set expires_at = greatest(created_at + interval '1 microsecond', pg_catalog.clock_timestamp())
where consumed_at is null
  and expires_at > pg_catalog.clock_timestamp();

create or replace function public.current_ofa_user_id()
returns uuid
language sql
stable
security definer
set search_path = ''
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
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members wm
    join public.workspaces w on w.id = wm.workspace_id
    where wm.workspace_id = p_workspace_id
      and wm.user_id = public.current_ofa_user_id()
      and wm.status = 'active'
      and wm.removed_at is null
      and w.deleted_at is null
  );
$$;

create or replace function public.create_telegram_link_code()
returns table (code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := public.current_ofa_user_id();
  -- 128 bits of CSPRNG entropy, returned once and persisted only as SHA-256.
  v_code text := pg_catalog.upper(pg_catalog.encode(extensions.gen_random_bytes(16), 'hex'));
  v_expires_at timestamptz := pg_catalog.clock_timestamp() + interval '15 minutes';
begin
  if v_user_id is null then
    raise exception 'Linking request cannot be completed';
  end if;

  -- Serialise code generation for one account so concurrent requests cannot
  -- leave more than one usable code.
  perform 1
  from public.ofa_users u
  where u.id = v_user_id
    and u.status = 'active'
    and u.deleted_at is null
  for update;
  if not found then
    raise exception 'Linking request cannot be completed';
  end if;

  if not exists (
    select 1
    from public.workspace_members wm
    join public.workspaces w on w.id = wm.workspace_id
    where wm.user_id = v_user_id
      and wm.status = 'active'
      and wm.removed_at is null
      and w.deleted_at is null
  ) then
    raise exception 'Linking request cannot be completed';
  end if;

  update public.telegram_link_codes
  set expires_at = greatest(created_at + interval '1 microsecond', pg_catalog.clock_timestamp())
  where target_user_id = v_user_id
    and consumed_at is null
    and expires_at > pg_catalog.clock_timestamp();

  insert into public.telegram_link_codes (target_user_id, code_hash, expires_at)
  values (v_user_id, extensions.digest(v_code, 'sha256'), v_expires_at);

  return query select v_code, v_expires_at;
end;
$$;

create or replace function public.consume_telegram_link_code(
  p_telegram_user_id text,
  p_display_name text,
  p_code text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_link public.telegram_link_codes%rowtype;
  v_channel_account_id uuid;
  v_channel_unlinked_at timestamptz;
  v_telegram_user_id uuid;
  v_web_auth_user_id uuid;
  v_telegram_auth_user_id uuid;
  v_workspace_id uuid;
  v_affected integer;
begin
  -- Telegram IDs come from the verified webhook context in the API. Reject
  -- malformed values here as a second server-side boundary.
  if p_telegram_user_id is null
     or p_telegram_user_id !~ '^[0-9]{1,20}$'
     or p_code is null
     or pg_catalog.btrim(p_code) !~ '^[0-9A-Fa-f]{32}$' then
    raise exception 'Linking request cannot be completed';
  end if;

  select link.* into v_link
  from public.telegram_link_codes link
  where link.code_hash = extensions.digest(pg_catalog.upper(pg_catalog.btrim(p_code)), 'sha256')
    and link.consumed_at is null
    and link.expires_at > pg_catalog.clock_timestamp()
  for update;

  if v_link.id is null then
    raise exception 'Linking request cannot be completed';
  end if;

  select u.auth_user_id into v_web_auth_user_id
  from public.ofa_users u
  where u.id = v_link.target_user_id
    and u.status = 'active'
    and u.deleted_at is null
  for update;

  if v_web_auth_user_id is null then
    raise exception 'Linking request cannot be completed';
  end if;

  select wm.workspace_id into v_workspace_id
  from public.workspace_members wm
  join public.workspaces w on w.id = wm.workspace_id
  where wm.user_id = v_link.target_user_id
    and wm.status = 'active'
    and wm.removed_at is null
    and w.deleted_at is null
  order by wm.created_at, wm.workspace_id
  limit 1
  for update of wm, w;

  if v_workspace_id is null then
    raise exception 'Linking request cannot be completed';
  end if;

  -- A web account may have at most one currently active Telegram identity.
  -- This prevents a second Telegram account from replacing an existing link.
  if exists (
    select 1
    from public.channel_accounts ca
    where ca.user_id = v_link.target_user_id
      and ca.channel = 'telegram'
      and ca.unlinked_at is null
      and ca.external_account_id <> p_telegram_user_id
  ) then
    raise exception 'Linking request cannot be completed';
  end if;

  -- Include historical rows so a legitimate relink reuses the same identity.
  -- The unconditional unique constraint on (channel, external_account_id) stays
  -- authoritative and prevents duplicate Telegram identities.
  select ca.id, ca.user_id, ca.unlinked_at
  into v_channel_account_id, v_telegram_user_id, v_channel_unlinked_at
  from public.channel_accounts ca
  where ca.channel = 'telegram'
    and ca.external_account_id = p_telegram_user_id
  for update;

  if v_telegram_user_id is null then
    v_telegram_user_id := extensions.gen_random_uuid();
    insert into public.ofa_users (id, display_name)
    values (v_telegram_user_id, nullif(p_display_name, ''));
    insert into public.auth_identities (user_id, provider, provider_subject, verified_at)
    values (v_telegram_user_id, 'telegram', p_telegram_user_id, pg_catalog.clock_timestamp());
    insert into public.workspaces (name, workspace_type, base_currency_code, time_zone, created_by_user_id)
    values ('Môj rozpočet', 'personal', 'EUR', 'Europe/Bratislava', v_telegram_user_id)
    returning id into v_workspace_id;
    insert into public.workspace_members (workspace_id, user_id, role, status, joined_at)
    values (v_workspace_id, v_telegram_user_id, 'owner', 'active', pg_catalog.clock_timestamp());
    insert into public.channel_accounts (user_id, channel, external_account_id, external_username)
    values (v_telegram_user_id, 'telegram', p_telegram_user_id, nullif(p_display_name, ''))
    returning id into v_channel_account_id;
  else
    -- An unlink is not an account reset. A suspended/deleted user or a user
    -- without an active workspace cannot be revived through pairing.
    perform 1
    from public.ofa_users u
    where u.id = v_telegram_user_id
      and u.status = 'active'
      and u.deleted_at is null
    for update;
    if not found then
      raise exception 'Linking request cannot be completed';
    end if;

    select wm.workspace_id into v_workspace_id
    from public.workspace_members wm
    join public.workspaces w on w.id = wm.workspace_id
    where wm.user_id = v_telegram_user_id
      and wm.status = 'active'
      and wm.removed_at is null
      and w.deleted_at is null
    order by wm.created_at, wm.workspace_id
    limit 1
    for update of wm, w;
    if v_workspace_id is null then
      raise exception 'Linking request cannot be completed';
    end if;
  end if;

  select u.auth_user_id into v_telegram_auth_user_id
  from public.ofa_users u
  where u.id = v_telegram_user_id
  for update;

  if v_telegram_auth_user_id is not null and v_telegram_auth_user_id <> v_web_auth_user_id then
    raise exception 'Linking request cannot be completed';
  end if;

  if v_telegram_user_id <> v_link.target_user_id then
    -- Retire only the temporary web profile. No financial, receipt, warranty or
    -- audit rows are deleted; referential history remains intact.
    update public.workspaces w
    set deleted_at = pg_catalog.clock_timestamp()
    where w.created_by_user_id = v_link.target_user_id
      and w.deleted_at is null;
    update public.workspace_members wm
    set status = 'removed', removed_at = pg_catalog.clock_timestamp()
    where wm.user_id = v_link.target_user_id
      and wm.status = 'active';
    update public.auth_identities ai
    set user_id = v_telegram_user_id
    where ai.user_id = v_link.target_user_id
      and ai.provider = 'email';
    update public.ofa_users u
    set auth_user_id = null,
        status = 'deleted',
        deleted_at = pg_catalog.clock_timestamp(),
        updated_at = pg_catalog.clock_timestamp()
    where u.id = v_link.target_user_id;
  end if;

  update public.ofa_users u
  set auth_user_id = v_web_auth_user_id,
      updated_at = pg_catalog.clock_timestamp()
  where u.id = v_telegram_user_id
    and u.status = 'active'
    and u.deleted_at is null;
  if not found then
    raise exception 'Linking request cannot be completed';
  end if;

  update public.channel_accounts ca
  set unlinked_at = null,
      linked_at = case when v_channel_unlinked_at is null then ca.linked_at else pg_catalog.clock_timestamp() end,
      external_username = coalesce(nullif(p_display_name, ''), ca.external_username),
      updated_at = pg_catalog.clock_timestamp()
  where ca.id = v_channel_account_id
    and ca.user_id = v_telegram_user_id;
  if not found then
    raise exception 'Linking request cannot be completed';
  end if;

  -- Final compare-and-set is the single-use guarantee even after lock waits.
  update public.telegram_link_codes link
  set consumed_at = pg_catalog.clock_timestamp(),
      consumed_by_user_id = v_telegram_user_id
  where link.id = v_link.id
    and link.consumed_at is null
    and link.expires_at > pg_catalog.clock_timestamp();
  get diagnostics v_affected = row_count;
  if v_affected <> 1 then
    raise exception 'Linking request cannot be completed';
  end if;

  insert into public.audit_events (
    workspace_id,
    actor_user_id,
    actor_type,
    action,
    entity_type,
    entity_id,
    metadata
  ) values (
    v_workspace_id,
    v_telegram_user_id,
    'user',
    case when v_channel_unlinked_at is null then 'telegram_account_linked' else 'telegram_account_relinked' end,
    'channel_account',
    v_channel_account_id,
    pg_catalog.jsonb_build_object('channel', 'telegram')
  );

  return v_telegram_user_id;
end;
$$;

-- SECURITY DEFINER functions are not public APIs by default. Only the web
-- session may mint a code; only the trusted backend may consume it.
revoke all on function public.current_ofa_user_id() from public, anon;
revoke all on function public.is_current_user_workspace_member(uuid) from public, anon;
revoke all on function public.create_telegram_link_code() from public, anon;
revoke all on function public.consume_telegram_link_code(text, text, text) from public, anon, authenticated;
grant execute on function public.current_ofa_user_id() to authenticated;
grant execute on function public.is_current_user_workspace_member(uuid) to authenticated;
grant execute on function public.create_telegram_link_code() to authenticated;
grant execute on function public.consume_telegram_link_code(text, text, text) to service_role;
