-- Searchable receipt line items make it possible to find an original receipt
-- later for a warranty claim. The storage object itself remains private; the
-- trusted backend generates a short-lived signed URL only after authorization.
create table public.receipt_line_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  receipt_id uuid not null references public.ofa_receipts(id) on delete restrict,
  line_number smallint not null check (line_number > 0),
  item_name text not null check (char_length(trim(item_name)) between 1 and 500),
  quantity numeric(12,3) check (quantity is null or quantity > 0),
  unit_amount_minor bigint check (unit_amount_minor is null or unit_amount_minor >= 0),
  total_amount_minor bigint check (total_amount_minor is null or total_amount_minor >= 0),
  currency_code char(3) not null references public.currencies(code),
  raw_text text,
  created_at timestamptz not null default now(),
  unique (receipt_id, line_number)
);

create index receipt_line_items_workspace_receipt_idx
  on public.receipt_line_items (workspace_id, receipt_id);
create index receipt_line_items_name_trgm_idx
  on public.receipt_line_items using gin (item_name gin_trgm_ops);

create or replace function public.validate_receipt_line_item_workspace()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not exists (
    select 1
    from public.ofa_receipts r
    where r.id = new.receipt_id
      and r.workspace_id = new.workspace_id
      and r.deleted_at is null
  ) then
    raise exception 'Receipt line item must belong to the receipt workspace' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger receipt_line_items_validate_workspace
  before insert or update on public.receipt_line_items
  for each row execute function public.validate_receipt_line_item_workspace();

alter table public.receipt_line_items enable row level security;

create policy "members can view receipt line items"
  on public.receipt_line_items for select to authenticated
  using ((select public.is_current_user_workspace_member(workspace_id)));

grant select on public.receipt_line_items to authenticated;

-- The Telegram backend is the only caller. It determines the Telegram identity
-- server-side and restricts every result to workspaces where that identity is an
-- active member. This function is deliberately not exposed to anon/authenticated.
create or replace function public.search_telegram_receipts_for_claim(
  p_telegram_user_id text,
  p_query text,
  p_limit integer default 5
)
returns table (
  receipt_id uuid,
  merchant_name text,
  receipt_date date,
  total_amount_minor bigint,
  currency_code char(3),
  storage_key text,
  content_type varchar,
  matched_item_name text,
  match_score real
)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  with search_input as (
    select nullif(lower(trim(p_query)), '') as term
  ),
  requester as (
    select ca.user_id
    from public.channel_accounts ca
    join public.ofa_users u on u.id = ca.user_id
    where ca.channel = 'telegram'
      and ca.external_account_id = p_telegram_user_id
      and ca.unlinked_at is null
      and u.status = 'active'
      and u.deleted_at is null
    limit 1
  ),
  accessible_workspaces as (
    select wm.workspace_id
    from public.workspace_members wm
    join requester requester on requester.user_id = wm.user_id
    join public.workspaces w on w.id = wm.workspace_id
    where wm.status = 'active'
      and wm.removed_at is null
      and w.deleted_at is null
  ),
  candidates as (
    select
      r.id as receipt_id,
      r.merchant_name,
      r.receipt_date,
      r.total_amount_minor,
      r.currency_code,
      sf.storage_key,
      sf.content_type,
      item.item_name as matched_item_name,
      greatest(
        case
          when lower(coalesce(r.merchant_name, '')) = input.term then 1.0
          when lower(coalesce(r.merchant_name, '')) like '%' || input.term || '%' then 0.95
          else similarity(lower(coalesce(r.merchant_name, '')), input.term)
        end,
        coalesce(item.match_score, 0),
        case
          when to_tsvector('simple', coalesce(r.ocr_text, '')) @@ websearch_to_tsquery('simple', input.term) then 0.70
          else 0
        end
      )::real as match_score
    from public.ofa_receipts r
    join accessible_workspaces aw on aw.workspace_id = r.workspace_id
    join public.stored_files sf on sf.id = r.file_id and sf.deleted_at is null
    cross join search_input input
    left join lateral (
      select
        li.item_name,
        case
          when lower(li.item_name) = input.term then 1.0
          when lower(li.item_name) like '%' || input.term || '%' then 0.95
          else similarity(lower(li.item_name), input.term)
        end::real as match_score
      from public.receipt_line_items li
      where li.receipt_id = r.id
      order by match_score desc, li.line_number asc
      limit 1
    ) item on true
    where input.term is not null
      and r.status = 'completed'
      and r.deleted_at is null
      and (
        lower(coalesce(r.merchant_name, '')) like '%' || input.term || '%'
        or similarity(lower(coalesce(r.merchant_name, '')), input.term) >= 0.20
        or coalesce(item.match_score, 0) >= 0.20
        or to_tsvector('simple', coalesce(r.ocr_text, '')) @@ websearch_to_tsquery('simple', input.term)
      )
  )
  select *
  from candidates
  order by match_score desc, receipt_date desc nulls last, receipt_id desc
  limit least(greatest(coalesce(p_limit, 5), 1), 10);
$$;

create or replace function public.get_telegram_receipt_for_claim(
  p_telegram_user_id text,
  p_receipt_id uuid
)
returns table (
  receipt_id uuid,
  merchant_name text,
  receipt_date date,
  total_amount_minor bigint,
  currency_code char(3),
  storage_key text,
  content_type varchar,
  matched_item_name text
)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  with requester as (
    select ca.user_id
    from public.channel_accounts ca
    join public.ofa_users u on u.id = ca.user_id
    where ca.channel = 'telegram'
      and ca.external_account_id = p_telegram_user_id
      and ca.unlinked_at is null
      and u.status = 'active'
      and u.deleted_at is null
    limit 1
  )
  select
    r.id,
    r.merchant_name,
    r.receipt_date,
    r.total_amount_minor,
    r.currency_code,
    sf.storage_key,
    sf.content_type,
    null::text as matched_item_name
  from public.ofa_receipts r
  join public.stored_files sf on sf.id = r.file_id and sf.deleted_at is null
  join public.workspace_members wm on wm.workspace_id = r.workspace_id
  join requester requester on requester.user_id = wm.user_id
  join public.workspaces w on w.id = r.workspace_id
  where r.id = p_receipt_id
    and r.status = 'completed'
    and r.deleted_at is null
    and wm.status = 'active'
    and wm.removed_at is null
    and w.deleted_at is null;
$$;

revoke all on function public.search_telegram_receipts_for_claim(text, text, integer) from public, anon, authenticated;
revoke all on function public.get_telegram_receipt_for_claim(text, uuid) from public, anon, authenticated;
grant execute on function public.search_telegram_receipts_for_claim(text, text, integer) to service_role;
grant execute on function public.get_telegram_receipt_for_claim(text, uuid) to service_role;
