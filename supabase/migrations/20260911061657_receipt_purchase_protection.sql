-- Receipt originals are retained only after an explicit Telegram decision. The
-- financial transaction and OCR metadata always remain available independently.
alter table public.ofa_receipts
  add column if not exists archive_status varchar(32) not null default 'decision_pending',
  add column if not exists retention_until timestamptz,
  add column if not exists cleanup_claimed_at timestamptz,
  add column if not exists storage_deleted_at timestamptz;

-- Existing receipt originals predate the explicit choice. Preserve them rather
-- than silently scheduling deletion during rollout.
update public.ofa_receipts
set archive_status = 'archived'
where archive_status = 'decision_pending';

alter table public.ofa_receipts
  drop constraint if exists ofa_receipts_archive_status_check,
  add constraint ofa_receipts_archive_status_check check (
    archive_status in ('decision_pending', 'archived', 'pending_deletion', 'cleanup_claimed', 'storage_deleted')
  ),
  drop constraint if exists ofa_receipts_archive_retention_check,
  add constraint ofa_receipts_archive_retention_check check (
    (archive_status in ('decision_pending', 'pending_deletion', 'cleanup_claimed') and retention_until is not null and storage_deleted_at is null)
    or (archive_status = 'storage_deleted' and storage_deleted_at is not null)
    or (archive_status = 'archived' and retention_until is null and storage_deleted_at is null)
  );

create index if not exists ofa_receipts_storage_cleanup_idx
  on public.ofa_receipts (retention_until, created_at)
  where archive_status in ('decision_pending', 'pending_deletion');

create table public.receipt_purchase_protections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  receipt_id uuid not null references public.ofa_receipts(id) on delete restrict,
  transaction_id uuid not null references public.financial_transactions(id) on delete restrict,
  recipient_user_id uuid not null references public.ofa_users(id) on delete restrict,
  starts_on date not null,
  ends_on date not null,
  status varchar(24) not null default 'active' check (status in ('active', 'cancelled')),
  selected_at timestamptz not null default now(),
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (receipt_id),
  check (ends_on = (starts_on + interval '24 months')::date),
  check ((status = 'cancelled') = (cancelled_at is not null))
);

create index receipt_purchase_protections_due_idx
  on public.receipt_purchase_protections (ends_on, receipt_id)
  where status = 'active';
create index receipt_purchase_protections_workspace_idx
  on public.receipt_purchase_protections (workspace_id, ends_on desc);

create table public.receipt_purchase_protection_reminders (
  id uuid primary key default gen_random_uuid(),
  protection_id uuid not null references public.receipt_purchase_protections(id) on delete restrict,
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  recipient_user_id uuid not null references public.ofa_users(id) on delete restrict,
  milestone_days smallint not null check (milestone_days in (60, 30, 7)),
  scheduled_for date not null,
  status varchar(24) not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'cancelled')),
  attempt_count smallint not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  provider_message_id text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (protection_id, milestone_days)
);

create index receipt_purchase_protection_reminders_due_idx
  on public.receipt_purchase_protection_reminders (scheduled_for, next_attempt_at, created_at)
  where status in ('queued', 'sending');

create or replace function public.validate_receipt_purchase_protection_workspace()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
begin
  if not exists (
    select 1
    from public.ofa_receipts r
    join public.financial_transactions ft on ft.id = new.transaction_id
    where r.id = new.receipt_id
      and r.workspace_id = new.workspace_id
      and ft.workspace_id = new.workspace_id
      and r.uploaded_by_user_id = new.recipient_user_id
  ) then
    raise exception 'Receipt protection crosses a workspace or owner boundary' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.validate_receipt_purchase_protection_reminder_workspace()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
begin
  if not exists (
    select 1
    from public.receipt_purchase_protections p
    where p.id = new.protection_id
      and p.workspace_id = new.workspace_id
      and p.recipient_user_id = new.recipient_user_id
  ) then
    raise exception 'Receipt protection reminder crosses a workspace or recipient boundary' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger receipt_purchase_protections_validate_workspace
  before insert or update on public.receipt_purchase_protections
  for each row execute function public.validate_receipt_purchase_protection_workspace();

create trigger receipt_purchase_protection_reminders_validate_workspace
  before insert or update on public.receipt_purchase_protection_reminders
  for each row execute function public.validate_receipt_purchase_protection_reminder_workspace();

create trigger receipt_purchase_protections_set_updated_at
  before update on public.receipt_purchase_protections
  for each row execute function public.set_updated_at();

create trigger receipt_purchase_protection_reminders_set_updated_at
  before update on public.receipt_purchase_protection_reminders
  for each row execute function public.set_updated_at();

alter table public.receipt_purchase_protections enable row level security;
alter table public.receipt_purchase_protection_reminders enable row level security;

create policy "members can view receipt purchase protections"
  on public.receipt_purchase_protections for select to authenticated
  using ((select public.is_current_user_workspace_member(workspace_id)));

grant select on public.receipt_purchase_protections to authenticated;

-- This backend-only RPC is the single state transition for Telegram choices.
-- It serializes decisions on the receipt row, so repeated callbacks cannot
-- create duplicate tracking or accidentally downgrade an archived document.
create or replace function public.decide_telegram_receipt_purchase_protection(
  p_telegram_user_id text,
  p_receipt_id uuid,
  p_keep_receipt boolean,
  p_retention_hours integer
)
returns table (
  archive_status varchar,
  protection_status varchar,
  protection_ends_on date,
  was_changed boolean
)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_receipt public.ofa_receipts%rowtype;
  v_file public.stored_files%rowtype;
  v_transaction public.financial_transactions%rowtype;
  v_user_id uuid;
  v_start_date date;
  v_end_date date;
  v_protection_id uuid;
  v_changed boolean := false;
  v_protection_status varchar(24);
begin
  if p_retention_hours is null or p_retention_hours < 1 or p_retention_hours > 24 * 90 then
    raise exception 'p_retention_hours must be between 1 and 2160' using errcode = '22023';
  end if;

  select ca.user_id
  into v_user_id
  from public.channel_accounts ca
  join public.ofa_users u on u.id = ca.user_id
  where ca.channel = 'telegram'
    and ca.external_account_id = p_telegram_user_id
    and ca.unlinked_at is null
    and u.status = 'active'
    and u.deleted_at is null
  limit 1;

  if v_user_id is null then
    return;
  end if;

  select r.*
  into v_receipt
  from public.ofa_receipts r
  join public.receipt_transaction_links rtl on rtl.receipt_id = r.id and rtl.unlinked_at is null
  join public.workspace_members wm on wm.workspace_id = r.workspace_id
  where r.id = p_receipt_id
    and r.status = 'completed'
    and r.deleted_at is null
    and r.uploaded_by_user_id = v_user_id
    and wm.user_id = v_user_id
    and wm.status = 'active'
    and wm.removed_at is null
  order by rtl.created_at asc
  limit 1
  for update of r;

  if not found then
    return;
  end if;

  select sf.*
  into v_file
  from public.stored_files sf
  where sf.id = v_receipt.file_id;

  select ft.*
  into v_transaction
  from public.financial_transactions ft
  join public.receipt_transaction_links rtl on rtl.transaction_id = ft.id and rtl.unlinked_at is null
  where rtl.receipt_id = v_receipt.id
  order by rtl.created_at asc
  limit 1
  for update of ft;

  if v_file.id is null or v_transaction.id is null then
    return;
  end if;

  if p_keep_receipt then
    if v_receipt.archive_status in ('storage_deleted', 'cleanup_claimed') or v_file.deleted_at is not null then
      return query select v_receipt.archive_status, null::varchar, null::date, false;
      return;
    end if;

    if v_receipt.archive_status <> 'archived' then
      update public.ofa_receipts
      set archive_status = 'archived', retention_until = null, cleanup_claimed_at = null
      where id = v_receipt.id;
      v_changed := true;
    end if;

    v_start_date := coalesce(v_receipt.receipt_date, (v_transaction.occurred_at at time zone 'Europe/Bratislava')::date);
    v_end_date := (v_start_date + interval '24 months')::date;

    insert into public.receipt_purchase_protections (
      workspace_id, receipt_id, transaction_id, recipient_user_id, starts_on, ends_on, status, cancelled_at
    ) values (
      v_receipt.workspace_id,
      v_receipt.id,
      v_transaction.id,
      v_user_id,
      v_start_date,
      v_end_date,
      case when v_transaction.status = 'confirmed' and v_transaction.deleted_at is null then 'active' else 'cancelled' end,
      case when v_transaction.status = 'confirmed' and v_transaction.deleted_at is null then null else now() end
    )
    on conflict (receipt_id) do update
      set status = case
            when public.receipt_purchase_protections.status = 'cancelled' then 'cancelled'
            else public.receipt_purchase_protections.status
          end
    returning id, status into v_protection_id, v_protection_status;

    if v_protection_status = 'active' then
      insert into public.receipt_purchase_protection_reminders (
        protection_id, workspace_id, recipient_user_id, milestone_days, scheduled_for
      )
      select v_protection_id, v_receipt.workspace_id, v_user_id, milestone.day_count, v_end_date - milestone.day_count
      from unnest(array[60, 30, 7]) as milestone(day_count)
      where v_end_date - milestone.day_count >= (now() at time zone 'Europe/Bratislava')::date
      on conflict (protection_id, milestone_days) do nothing;
    end if;

    if v_changed then
      insert into public.audit_events (
        workspace_id, actor_user_id, actor_type, action, entity_type, entity_id, after_data, metadata
      ) values (
        v_receipt.workspace_id,
        v_user_id,
        'user',
        'receipt.purchase_protection_enabled',
        'ofa_receipt',
        v_receipt.id,
        jsonb_build_object('archive_status', 'archived', 'protection_ends_on', v_end_date),
        jsonb_build_object('channel', 'telegram', 'transaction_id', v_transaction.id)
      );
    end if;

    return query select 'archived'::varchar, v_protection_status, v_end_date, v_changed;
    return;
  end if;

  if v_receipt.archive_status = 'archived' then
    return query select 'archived'::varchar, null::varchar, null::date, false;
    return;
  end if;

  if v_receipt.archive_status in ('storage_deleted', 'cleanup_claimed') or v_file.deleted_at is not null then
    return query select v_receipt.archive_status, null::varchar, null::date, false;
    return;
  end if;

  if v_receipt.archive_status = 'decision_pending' then
    update public.ofa_receipts
    set archive_status = 'pending_deletion',
        retention_until = now() + make_interval(hours => p_retention_hours),
        cleanup_claimed_at = null
    where id = v_receipt.id;
    v_changed := true;

    insert into public.audit_events (
      workspace_id, actor_user_id, actor_type, action, entity_type, entity_id, after_data, metadata
    ) values (
      v_receipt.workspace_id,
      v_user_id,
      'user',
      'receipt.purchase_protection_declined',
      'ofa_receipt',
      v_receipt.id,
      jsonb_build_object('archive_status', 'pending_deletion'),
      jsonb_build_object('channel', 'telegram', 'retention_hours', p_retention_hours)
    );
  end if;

  return query select 'pending_deletion'::varchar, null::varchar, null::date, v_changed;
end;
$$;

create or replace function public.claim_receipt_storage_deletions(p_limit integer default 50)
returns table (receipt_id uuid, storage_key text)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'p_limit must be between 1 and 200' using errcode = '22023';
  end if;

  return query
  with candidate as (
    select r.id
    from public.ofa_receipts r
    join public.stored_files sf on sf.id = r.file_id and sf.deleted_at is null
    where (
        (r.archive_status in ('decision_pending', 'pending_deletion') and r.retention_until <= now())
        or (r.archive_status = 'cleanup_claimed' and r.cleanup_claimed_at < now() - interval '15 minutes')
      )
      and r.status = 'completed'
      and r.deleted_at is null
      and not exists (
        select 1
        from public.receipt_ocr_runs ocr
        where ocr.receipt_id = r.id
          and ocr.status in ('queued', 'running')
      )
    order by r.retention_until, r.id
    for update of r skip locked
    limit p_limit
  ), claimed as (
    update public.ofa_receipts r
    set archive_status = 'cleanup_claimed', cleanup_claimed_at = now()
    from candidate c
    where r.id = c.id
    returning r.id, r.file_id
  )
  select c.id, sf.storage_key
  from claimed c
  join public.stored_files sf on sf.id = c.file_id;
end;
$$;

create or replace function public.complete_receipt_storage_deletion(
  p_receipt_id uuid,
  p_succeeded boolean,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_receipt public.ofa_receipts%rowtype;
begin
  select * into v_receipt
  from public.ofa_receipts
  where id = p_receipt_id
  for update;

  if not found or v_receipt.archive_status <> 'cleanup_claimed' then
    return;
  end if;

  if p_succeeded then
    update public.ofa_receipts
    set archive_status = 'storage_deleted', storage_deleted_at = now(), cleanup_claimed_at = null
    where id = v_receipt.id;
    update public.stored_files
    set deleted_at = now()
    where id = v_receipt.file_id and deleted_at is null;
    insert into public.audit_events (
      workspace_id, actor_type, action, entity_type, entity_id, after_data
    ) values (
      v_receipt.workspace_id,
      'system',
      'receipt.storage_deleted_after_retention',
      'ofa_receipt',
      v_receipt.id,
      jsonb_build_object('archive_status', 'storage_deleted')
    );
  else
    update public.ofa_receipts
    set archive_status = 'pending_deletion', cleanup_claimed_at = null
    where id = v_receipt.id;
    insert into public.audit_events (
      workspace_id, actor_type, action, entity_type, entity_id, metadata
    ) values (
      v_receipt.workspace_id,
      'system',
      'receipt.storage_deletion_failed',
      'ofa_receipt',
      v_receipt.id,
      jsonb_build_object('error', left(coalesce(p_error, 'unknown'), 500))
    );
  end if;
end;
$$;

create or replace function public.claim_due_receipt_purchase_protection_reminders(p_limit integer default 100)
returns table (reminder_id uuid, telegram_user_id text, milestone_days smallint)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'p_limit must be between 1 and 200' using errcode = '22023';
  end if;

  return query
  with candidate as (
    select reminder.id
    from public.receipt_purchase_protection_reminders reminder
    join public.receipt_purchase_protections protection on protection.id = reminder.protection_id
    join public.ofa_receipts receipt on receipt.id = protection.receipt_id
    join public.financial_transactions ft on ft.id = protection.transaction_id
    where (
        (reminder.status = 'queued' and reminder.next_attempt_at <= now())
        or (reminder.status = 'sending' and reminder.claimed_at < now() - interval '15 minutes')
      )
      and reminder.scheduled_for <= (now() at time zone 'Europe/Bratislava')::date
      and protection.status = 'active'
      and receipt.archive_status = 'archived'
      and receipt.deleted_at is null
      and ft.status = 'confirmed'
      and ft.deleted_at is null
      and exists (
        select 1
        from public.channel_accounts account
        where account.user_id = reminder.recipient_user_id
          and account.channel = 'telegram'
          and account.unlinked_at is null
      )
    order by reminder.scheduled_for, reminder.created_at
    for update of reminder skip locked
    limit p_limit
  ), claimed as (
    update public.receipt_purchase_protection_reminders reminder
    set status = 'sending', claimed_at = now(), attempt_count = reminder.attempt_count + 1
    from candidate c
    where reminder.id = c.id
    returning reminder.id, reminder.recipient_user_id, reminder.milestone_days
  )
  select claimed.id, account.external_account_id, claimed.milestone_days
  from claimed
  join lateral (
    select ca.external_account_id
    from public.channel_accounts ca
    where ca.user_id = claimed.recipient_user_id
      and ca.channel = 'telegram'
      and ca.unlinked_at is null
    order by ca.created_at desc
    limit 1
  ) account on true;
end;
$$;

create or replace function public.complete_receipt_purchase_protection_reminder(
  p_reminder_id uuid,
  p_succeeded boolean,
  p_provider_message_id text default null,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_reminder public.receipt_purchase_protection_reminders%rowtype;
begin
  select * into v_reminder
  from public.receipt_purchase_protection_reminders
  where id = p_reminder_id
  for update;

  if not found or v_reminder.status <> 'sending' then
    return;
  end if;

  if p_succeeded then
    update public.receipt_purchase_protection_reminders
    set status = 'sent', sent_at = now(), provider_message_id = nullif(trim(p_provider_message_id), ''), last_error = null
    where id = v_reminder.id;
    insert into public.audit_events (
      workspace_id, actor_type, action, entity_type, entity_id, metadata
    ) values (
      v_reminder.workspace_id,
      'system',
      'receipt.purchase_protection_reminder_sent',
      'receipt_purchase_protection_reminder',
      v_reminder.id,
      jsonb_build_object('milestone_days', v_reminder.milestone_days)
    );
  elsif v_reminder.attempt_count >= 5 then
    update public.receipt_purchase_protection_reminders
    set status = 'failed', last_error = left(coalesce(p_error, 'unknown'), 2000)
    where id = v_reminder.id;
  else
    update public.receipt_purchase_protection_reminders
    set status = 'queued',
        next_attempt_at = now() + make_interval(mins => v_reminder.attempt_count * 5),
        last_error = left(coalesce(p_error, 'unknown'), 2000)
    where id = v_reminder.id;
  end if;
end;
$$;

-- A voided financial transaction must never leave an active protection that can
-- generate reminders. The receipt itself remains archived when the user chose it.
create or replace function public.cancel_receipt_purchase_protection_for_voided_transaction()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
begin
  if new.status = 'voided' and old.status is distinct from 'voided' then
    with cancelled as (
      update public.receipt_purchase_protections
      set status = 'cancelled', cancelled_at = now()
      where transaction_id = new.id and status = 'active'
      returning id, workspace_id
    )
    insert into public.audit_events (
      workspace_id, actor_type, action, entity_type, entity_id, metadata
    )
    select
      workspace_id,
      'system',
      'receipt.purchase_protection_cancelled_for_voided_transaction',
      'receipt_purchase_protection',
      id,
      jsonb_build_object('transaction_id', new.id)
    from cancelled;

    update public.receipt_purchase_protection_reminders reminder
    set status = 'cancelled'
    from public.receipt_purchase_protections protection
    where reminder.protection_id = protection.id
      and protection.transaction_id = new.id
      and reminder.status in ('queued', 'sending');
  end if;
  return new;
end;
$$;

create trigger financial_transactions_cancel_receipt_purchase_protection
  after update of status on public.financial_transactions
  for each row execute function public.cancel_receipt_purchase_protection_for_voided_transaction();

revoke all on function public.decide_telegram_receipt_purchase_protection(text, uuid, boolean, integer) from public, anon, authenticated;
revoke all on function public.claim_receipt_storage_deletions(integer) from public, anon, authenticated;
revoke all on function public.complete_receipt_storage_deletion(uuid, boolean, text) from public, anon, authenticated;
revoke all on function public.claim_due_receipt_purchase_protection_reminders(integer) from public, anon, authenticated;
revoke all on function public.complete_receipt_purchase_protection_reminder(uuid, boolean, text, text) from public, anon, authenticated;

grant execute on function public.decide_telegram_receipt_purchase_protection(text, uuid, boolean, integer) to service_role;
grant execute on function public.claim_receipt_storage_deletions(integer) to service_role;
grant execute on function public.complete_receipt_storage_deletion(uuid, boolean, text) to service_role;
grant execute on function public.claim_due_receipt_purchase_protection_reminders(integer) to service_role;
grant execute on function public.complete_receipt_purchase_protection_reminder(uuid, boolean, text, text) to service_role;

-- Production uses Supabase Cron and Vault-protected credentials to invoke the
-- API worker. Local development runs the same maintenance loop in-process.
create extension if not exists pg_net;
create extension if not exists pg_cron with schema pg_catalog;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'weekly_report_api_base_url') then
    raise exception 'Missing Vault secret weekly_report_api_base_url';
  end if;
  if not exists (select 1 from vault.secrets where name = 'weekly_report_internal_cron_secret') then
    raise exception 'Missing Vault secret weekly_report_internal_cron_secret';
  end if;
end;
$$;

select cron.schedule(
  'receipt-purchase-protection-maintenance',
  '7 * * * *',
  $cron$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'weekly_report_api_base_url')
        || '/internal/receipt-purchase-protection/run',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-Internal-Cron-Secret', (select decrypted_secret from vault.decrypted_secrets where name = 'weekly_report_internal_cron_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 120000
    );
  $cron$
);
