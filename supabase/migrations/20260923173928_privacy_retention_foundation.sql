-- Privacy retention foundation. This migration changes no existing user data.
-- Maintenance is bounded and is invoked by the existing protected maintenance route.

alter table public.ofa_receipts
  drop constraint if exists ofa_receipts_archive_retention_check,
  add constraint ofa_receipts_archive_retention_check check (
    (archive_status in ('decision_pending', 'pending_deletion', 'cleanup_claimed') and retention_until is not null and storage_deleted_at is null)
    or (archive_status = 'storage_deleted' and storage_deleted_at is not null)
    or (archive_status = 'archived' and storage_deleted_at is null)
  );

-- For non-warranty receipts, normalize only the deadline. Physical cleanup
-- remains a separate, bounded maintenance action and never runs in migration.
update public.ofa_receipts receipt
set retention_until = receipt.created_at + interval '7 days'
where receipt.archive_status in ('decision_pending', 'pending_deletion')
  and receipt.retention_until is distinct from receipt.created_at + interval '7 days';

create or replace function public.cap_non_warranty_receipt_retention()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.archive_status in ('decision_pending', 'pending_deletion') then
    new.retention_until := least(
      coalesce(new.retention_until, new.created_at + interval '7 days'),
      new.created_at + interval '7 days'
    );
  end if;
  return new;
end;
$$;

drop trigger if exists ofa_receipts_cap_non_warranty_retention on public.ofa_receipts;
create trigger ofa_receipts_cap_non_warranty_retention
  before insert or update of archive_status, retention_until on public.ofa_receipts
  for each row execute function public.cap_non_warranty_receipt_retention();

-- Recompute on every accepted change, not only when the user first selects YES.
create or replace function public.sync_receipt_protection_retention()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    update public.ofa_receipts receipt
    set retention_until = ((new.ends_on + interval '6 months')::date::timestamp at time zone 'Europe/Bratislava')
    where receipt.id = new.receipt_id
      and receipt.archive_status = 'archived'
      and receipt.storage_deleted_at is null;
  elsif new.ends_on is distinct from old.ends_on then
    if exists (
      select 1 from public.ofa_receipts receipt
      where receipt.id = new.receipt_id
        and receipt.archive_status in ('cleanup_claimed', 'storage_deleted')
    ) then
      raise exception 'Receipt cleanup has started; protection duration cannot be changed' using errcode = '55000';
    end if;
    update public.ofa_receipts receipt
    set retention_until = ((new.ends_on + interval '6 months')::date::timestamp at time zone 'Europe/Bratislava')
    where receipt.id = new.receipt_id
      and receipt.archive_status = 'archived'
      and receipt.storage_deleted_at is null;
  end if;
  return new;
end;
$$;

drop trigger if exists receipt_protection_sync_retention on public.receipt_purchase_protections;
create trigger receipt_protection_sync_retention
  after insert or update of ends_on on public.receipt_purchase_protections
  for each row execute function public.sync_receipt_protection_retention();

-- Existing archived receipts are not scheduled for deletion blindly. Only
-- those with an explicit protection get a computed deadline.
update public.ofa_receipts receipt
set retention_until = ((protection.ends_on + interval '6 months')::date::timestamp at time zone 'Europe/Bratislava')
from public.receipt_purchase_protections protection
where protection.receipt_id = receipt.id
  and receipt.archive_status = 'archived'
  and receipt.retention_until is distinct from ((protection.ends_on + interval '6 months')::date::timestamp at time zone 'Europe/Bratislava');

create index if not exists ofa_receipts_archived_retention_idx
  on public.ofa_receipts (retention_until, id)
  where archive_status = 'archived' and retention_until is not null;

-- The original ordinary receipt claim also reclaims stale cleanup_claimed
-- receipts. Exclude every protected receipt from that path: a protected claim
-- must always be rechecked against its latest warranty end date.
create or replace function public.claim_receipt_storage_deletions(p_limit integer default 50)
returns table (receipt_id uuid, storage_key text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'Invalid cleanup limit' using errcode = '22023';
  end if;
  return query
  with candidate as (
    select receipt.id
    from public.ofa_receipts receipt
    join public.stored_files file on file.id = receipt.file_id and file.deleted_at is null
    where (
      (receipt.archive_status in ('decision_pending', 'pending_deletion') and receipt.retention_until <= pg_catalog.now())
      or (receipt.archive_status = 'cleanup_claimed' and receipt.cleanup_claimed_at < pg_catalog.now() - interval '15 minutes')
    )
      and receipt.status = 'completed'
      and receipt.deleted_at is null
      and not exists (
        select 1 from public.receipt_purchase_protections protection
        where protection.receipt_id = receipt.id
      )
      and exists (
        select 1 from public.receipt_transaction_links link
        join public.financial_transactions transaction on transaction.id = link.transaction_id
        where link.receipt_id = receipt.id
          and transaction.status in ('confirmed', 'voided')
      )
      and not exists (
        select 1 from public.receipt_ocr_runs run
        where run.receipt_id = receipt.id and run.status in ('queued', 'running')
      )
    order by receipt.retention_until, receipt.id
    for update of receipt skip locked
    limit p_limit
  ), claimed as (
    update public.ofa_receipts receipt
    set archive_status = 'cleanup_claimed', cleanup_claimed_at = pg_catalog.now()
    from candidate where receipt.id = candidate.id
    returning receipt.id, receipt.file_id
  )
  select claimed.id, file.storage_key
  from claimed join public.stored_files file on file.id = claimed.file_id;
end;
$$;

revoke all on function public.claim_receipt_storage_deletions(integer) from public, anon, authenticated;
grant execute on function public.claim_receipt_storage_deletions(integer) to service_role;

create or replace function public.claim_expired_warranty_receipt_deletions(p_limit integer default 25)
returns table (receipt_id uuid, storage_key text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 25 then
    raise exception 'Invalid cleanup limit' using errcode = '22023';
  end if;
  return query
  with candidate as (
    select receipt.id
    from public.ofa_receipts receipt
    join public.receipt_purchase_protections protection on protection.receipt_id = receipt.id
    join public.stored_files file on file.id = receipt.file_id and file.deleted_at is null
    where (
        receipt.archive_status = 'archived'
        or (receipt.archive_status = 'cleanup_claimed'
            and receipt.cleanup_claimed_at < pg_catalog.now() - interval '15 minutes')
      )
      and receipt.status = 'completed'
      and receipt.deleted_at is null
      and receipt.retention_until is not null
      and receipt.retention_until <= pg_catalog.now()
      and receipt.retention_until = ((protection.ends_on + interval '6 months')::date::timestamp at time zone 'Europe/Bratislava')
      and not exists (
        select 1 from public.receipt_ocr_runs run
        where run.receipt_id = receipt.id and run.status in ('queued', 'running')
      )
      and not exists (
        select 1 from public.receipt_purchase_protection_reminders reminder
        where reminder.protection_id = protection.id and reminder.status in ('queued', 'sending')
      )
    order by receipt.retention_until, receipt.id
    for update of receipt skip locked
    limit p_limit
  ), claimed as (
    update public.ofa_receipts receipt
    set archive_status = 'cleanup_claimed', cleanup_claimed_at = pg_catalog.now()
    from candidate where receipt.id = candidate.id
    returning receipt.id, receipt.file_id
  )
  select claimed.id, file.storage_key
  from claimed join public.stored_files file on file.id = claimed.file_id;
end;
$$;

-- A crash after Storage deletion but before metadata cleanup is retried here.
-- Only rows already confirmed as storage_deleted are eligible.
create or replace function public.purge_expired_receipt_extraction(p_limit integer default 25)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_receipt_id uuid;
  v_count integer := 0;
begin
  if p_limit is null or p_limit < 1 or p_limit > 25 then
    raise exception 'Invalid cleanup limit' using errcode = '22023';
  end if;
  for v_receipt_id in
    select receipt.id from public.ofa_receipts receipt
    where (
        (receipt.archive_status = 'storage_deleted' and receipt.storage_deleted_at is not null)
        or (
          receipt.archive_status in ('decision_pending', 'pending_deletion', 'cleanup_claimed')
          and receipt.retention_until <= pg_catalog.now()
          and exists (
            select 1 from public.receipt_transaction_links link
            join public.financial_transactions transaction on transaction.id = link.transaction_id
            where link.receipt_id = receipt.id and transaction.status in ('confirmed', 'voided')
          )
          and not exists (
            select 1 from public.receipt_ocr_runs run
            where run.receipt_id = receipt.id and run.status in ('queued', 'running')
          )
        )
      )
      and (
        receipt.ocr_text is not null
        or exists (select 1 from public.receipt_line_items item where item.receipt_id = receipt.id)
        or exists (select 1 from public.receipt_ocr_runs run where run.receipt_id = receipt.id)
        or exists (select 1 from public.receipt_purchase_protections protection where protection.receipt_id = receipt.id)
      )
    order by receipt.storage_deleted_at, receipt.id
    for update of receipt skip locked
    limit p_limit
  loop
    delete from public.receipt_line_items item where item.receipt_id = v_receipt_id;
    delete from public.receipt_ocr_runs run where run.receipt_id = v_receipt_id;
    if exists (
      select 1 from public.ofa_receipts receipt
      where receipt.id = v_receipt_id and receipt.archive_status = 'storage_deleted'
    ) then
      delete from public.receipt_purchase_protection_reminders reminder
      using public.receipt_purchase_protections protection
      where reminder.protection_id = protection.id and protection.receipt_id = v_receipt_id;
      delete from public.receipt_purchase_protections protection where protection.receipt_id = v_receipt_id;
    end if;
    update public.ofa_receipts receipt set ocr_text = null where receipt.id = v_receipt_id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- An open incident can be explicitly held until its review deadline. This
-- does not affect transaction_events, which remain tied to the transaction.
alter table public.audit_events add column if not exists retention_hold_until timestamptz;

-- The existing append-only trigger must remain strict for application roles.
-- Only a trusted SECURITY DEFINER cleanup transaction may remove expired
-- records, and only while its local cleanup flag is set.
create or replace function public.deny_event_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
     and current_user = 'postgres'
     and pg_catalog.current_setting('ofa.privacy_cleanup', true) = 'on' then
    return old;
  end if;
  raise exception 'Append-only table: % operations are not allowed', tg_table_name;
end;
$$;

create or replace function public.cleanup_privacy_metadata(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_jobs integer;
  v_codes integer;
  v_snapshots integer;
  v_reports integer;
  v_audits integer;
  v_reminders integer;
  v_messages integer;
  v_requests integer;
  v_consents integer;
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'Invalid cleanup limit' using errcode = '22023';
  end if;

  with candidates as (
    select id from public.async_jobs
    where status in ('completed', 'failed', 'cancelled')
      and coalesce(completed_at, created_at) < pg_catalog.now() - interval '30 days'
    order by coalesce(completed_at, created_at), id
    for update skip locked limit p_limit
  ), deleted as (delete from public.async_jobs job using candidates where job.id = candidates.id returning job.id)
  select count(*) into v_jobs from deleted;

  with candidates as (
    select id from public.telegram_link_codes
    where (consumed_at is null and expires_at < pg_catalog.now() - interval '24 hours')
       or (consumed_at is not null and consumed_at < pg_catalog.now() - interval '24 hours')
    order by created_at, id for update skip locked limit p_limit
  ), deleted as (delete from public.telegram_link_codes code using candidates where code.id = candidates.id returning code.id)
  select count(*) into v_codes from deleted;

  with candidates as (
    select id from public.report_deliveries
    where created_at < pg_catalog.now() - interval '30 days'
      and status in ('sent', 'failed', 'cancelled')
      and data_snapshot <> '{}'::jsonb
    order by created_at, id for update skip locked limit p_limit
  ), updated as (
    update public.report_deliveries delivery set data_snapshot = '{}'::jsonb
    from candidates where delivery.id = candidates.id returning delivery.id
  ) select count(*) into v_snapshots from updated;

  with candidates as (
    select id from public.report_deliveries
    where created_at < pg_catalog.now() - interval '12 months'
      and status in ('sent', 'failed', 'cancelled')
    order by created_at, id for update skip locked limit p_limit
  ), deleted as (delete from public.report_deliveries delivery using candidates where delivery.id = candidates.id returning delivery.id)
  select count(*) into v_reports from deleted;

  perform pg_catalog.set_config('ofa.privacy_cleanup', 'on', true);

  with candidates as (
    select id from public.audit_events
    where occurred_at < pg_catalog.now() - interval '12 months'
      and (retention_hold_until is null or retention_hold_until < pg_catalog.now())
    order by occurred_at, id for update skip locked limit p_limit
  ), deleted as (delete from public.audit_events event using candidates where event.id = candidates.id returning event.id)
  select count(*) into v_audits from deleted;

  perform pg_catalog.set_config('ofa.privacy_cleanup', 'off', true);

  with candidates as (
    select id from public.receipt_purchase_protection_reminders
    where status in ('sent', 'failed', 'cancelled')
      and coalesce(sent_at, updated_at) < pg_catalog.now() - interval '12 months'
    order by coalesce(sent_at, updated_at), id for update skip locked limit p_limit
  ), deleted as (delete from public.receipt_purchase_protection_reminders reminder using candidates where reminder.id = candidates.id returning reminder.id)
  select count(*) into v_reminders from deleted;

  with candidates as (
    select id from public.channel_messages
    where created_at < pg_catalog.now() - interval '30 days'
    order by created_at, id for update skip locked limit p_limit
  ), deleted as (delete from public.channel_messages message using candidates where message.id = candidates.id returning message.id)
  select count(*) into v_messages from deleted;

  with candidates as (
    select request.id from public.gdpr_requests request
    where request.status in ('completed', 'rejected', 'cancelled')
      and request.completed_at < pg_catalog.now() - interval '12 months'
    order by request.completed_at, request.id for update skip locked limit p_limit
  ), deleted as (
    delete from public.gdpr_requests request using candidates
    where request.id = candidates.id returning request.id
  ) select count(*) into v_requests from deleted;

  with candidates as (
    select consent.id from public.user_consents consent
    join public.ofa_users app_user on app_user.id = consent.user_id
    where app_user.status = 'deleted'
      and app_user.deleted_at < pg_catalog.now() - interval '12 months'
    order by app_user.deleted_at, consent.id
    for update of consent skip locked limit p_limit
  ), deleted as (
    delete from public.user_consents consent using candidates
    where consent.id = candidates.id returning consent.id
  ) select count(*) into v_consents from deleted;

  return pg_catalog.jsonb_build_object(
    'jobs', v_jobs, 'pairing_codes', v_codes, 'report_snapshots', v_snapshots,
    'report_records', v_reports, 'audit_events', v_audits,
    'reminder_records', v_reminders, 'message_records', v_messages,
    'gdpr_requests', v_requests, 'privacy_acknowledgements', v_consents
  );
end;
$$;

revoke all on function public.claim_expired_warranty_receipt_deletions(integer) from public, anon, authenticated;
revoke all on function public.purge_expired_receipt_extraction(integer) from public, anon, authenticated;
revoke all on function public.cleanup_privacy_metadata(integer) from public, anon, authenticated;
grant execute on function public.claim_expired_warranty_receipt_deletions(integer) to service_role;
grant execute on function public.purge_expired_receipt_extraction(integer) to service_role;
grant execute on function public.cleanup_privacy_metadata(integer) to service_role;
