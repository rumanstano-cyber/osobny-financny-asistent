-- A user-reported warranty duration extends the existing protection record.
-- It is intentionally scoped to the most recently selected protection and is
-- available only to the service-role Telegram backend.
alter table public.receipt_purchase_protections
  add column if not exists warranty_duration_months smallint not null default 24
    check (warranty_duration_months between 1 and 240),
  add column if not exists warranty_duration_source varchar(24) not null default 'baseline'
    check (warranty_duration_source in ('baseline', 'user_reported'));

alter table public.receipt_purchase_protections
  drop constraint if exists receipt_purchase_protections_check,
  drop constraint if exists receipt_purchase_protections_ends_on_check,
  drop constraint if exists receipt_purchase_protections_duration_matches_end_check,
  add constraint receipt_purchase_protections_duration_matches_end_check check (
    ends_on = (starts_on + make_interval(months => warranty_duration_months))::date
  );

create or replace function public.update_telegram_receipt_purchase_protection_duration(
  p_telegram_user_id text,
  p_warranty_duration_months integer
)
returns table (
  protection_id uuid,
  warranty_duration_months smallint,
  protection_ends_on date,
  was_changed boolean
)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_user_id uuid;
  v_protection public.receipt_purchase_protections%rowtype;
  v_previous_end_date date;
  v_end_date date;
  v_changed boolean := false;
begin
  if p_warranty_duration_months is null or p_warranty_duration_months < 25 or p_warranty_duration_months > 240 then
    return;
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

  select p.*
  into v_protection
  from public.receipt_purchase_protections p
  join public.ofa_receipts r on r.id = p.receipt_id
  join public.financial_transactions ft on ft.id = p.transaction_id
  where p.recipient_user_id = v_user_id
    and p.status = 'active'
    and p.selected_at >= now() - interval '24 hours'
    and r.archive_status = 'archived'
    and r.deleted_at is null
    and ft.status = 'confirmed'
    and ft.deleted_at is null
  order by p.selected_at desc, p.id desc
  limit 1
  for update of p;

  if not found then
    return;
  end if;

  v_previous_end_date := v_protection.ends_on;
  v_end_date := (v_protection.starts_on + make_interval(months => p_warranty_duration_months))::date;
  v_changed := v_protection.warranty_duration_months is distinct from p_warranty_duration_months;

  if v_changed then
    update public.receipt_purchase_protections
    set warranty_duration_months = p_warranty_duration_months,
        warranty_duration_source = 'user_reported',
        ends_on = v_end_date
    where id = v_protection.id;

    update public.receipt_purchase_protection_reminders
    set scheduled_for = v_end_date - reminder.milestone_days,
        status = 'queued',
        attempt_count = 0,
        next_attempt_at = now(),
        claimed_at = null,
        sent_at = null,
        provider_message_id = null,
        last_error = null
    where reminder.protection_id = v_protection.id
      and reminder.milestone_days in (60, 30, 7)
      and reminder.status <> 'sent';

    insert into public.receipt_purchase_protection_reminders (
      protection_id, workspace_id, recipient_user_id, milestone_days, scheduled_for
    )
    select v_protection.id, v_protection.workspace_id, v_protection.recipient_user_id, milestone.day_count, v_end_date - milestone.day_count
    from unnest(array[60, 30, 7]) as milestone(day_count)
    where v_end_date - milestone.day_count >= (now() at time zone 'Europe/Bratislava')::date
      and not exists (
        select 1
        from public.receipt_purchase_protection_reminders existing_reminder
        where existing_reminder.protection_id = v_protection.id
          and existing_reminder.milestone_days = milestone.day_count
      );

    insert into public.audit_events (
      workspace_id, actor_user_id, actor_type, action, entity_type, entity_id, before_data, after_data, metadata
    ) values (
      v_protection.workspace_id,
      v_user_id,
      'user',
      'receipt.purchase_protection_duration_updated',
      'receipt_purchase_protection',
      v_protection.id,
      jsonb_build_object('warranty_duration_months', v_protection.warranty_duration_months, 'ends_on', v_previous_end_date),
      jsonb_build_object('warranty_duration_months', p_warranty_duration_months, 'ends_on', v_end_date),
      jsonb_build_object('channel', 'telegram', 'source', 'user_reported')
    );
  end if;

  return query select v_protection.id, p_warranty_duration_months::smallint, v_end_date, v_changed;
end;
$$;

revoke all on function public.update_telegram_receipt_purchase_protection_duration(text, integer) from public, anon, authenticated;
grant execute on function public.update_telegram_receipt_purchase_protection_duration(text, integer) to service_role;
