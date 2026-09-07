-- Dashboard totals must be calculated in PostgreSQL, not from a paginated
-- browser list. The function uses the workspace time zone for month bounds and
-- honours existing RLS because it is SECURITY INVOKER.
create or replace function public.get_current_workspace_dashboard_summary(p_workspace_id uuid)
returns table (
  income_minor bigint,
  expense_minor bigint,
  balance_minor bigint,
  receipt_count bigint,
  categories jsonb
)
language sql
stable
security invoker
set search_path = public
as $$
  with workspace_period as (
    select
      w.id,
      (date_trunc('month', now() at time zone w.time_zone) at time zone w.time_zone) as period_start,
      ((date_trunc('month', now() at time zone w.time_zone) + interval '1 month') at time zone w.time_zone) as period_end
    from public.workspaces w
    where w.id = p_workspace_id
      and w.deleted_at is null
  ),
  monthly_transactions as (
    select ft.id, ft.transaction_type, ft.amount_minor
    from public.financial_transactions ft
    join workspace_period wp on wp.id = ft.workspace_id
    where ft.status = 'confirmed'
      and ft.deleted_at is null
      and ft.occurred_at >= wp.period_start
      and ft.occurred_at < wp.period_end
  ),
  category_totals as (
    select
      coalesce(c.name, 'Ostatné') as name,
      coalesce(c.slug, 'ostatne') as slug,
      sum(mt.amount_minor)::bigint as amount_minor
    from monthly_transactions mt
    left join public.transaction_category_assignments tca
      on tca.transaction_id = mt.id and tca.valid_to is null
    left join public.categories c on c.id = tca.category_id
    where mt.transaction_type = 'expense'
    group by coalesce(c.name, 'Ostatné'), coalesce(c.slug, 'ostatne')
  )
  select
    coalesce(sum(mt.amount_minor) filter (where mt.transaction_type = 'income'), 0)::bigint as income_minor,
    coalesce(sum(mt.amount_minor) filter (where mt.transaction_type = 'expense'), 0)::bigint as expense_minor,
    (
      coalesce(sum(mt.amount_minor) filter (where mt.transaction_type = 'income'), 0)
      - coalesce(sum(mt.amount_minor) filter (where mt.transaction_type = 'expense'), 0)
    )::bigint as balance_minor,
    (
      select count(*)::bigint
      from public.ofa_receipts r
      where r.workspace_id = p_workspace_id and r.deleted_at is null
    ) as receipt_count,
    coalesce(
      (select jsonb_agg(jsonb_build_object('name', ct.name, 'amount_minor', ct.amount_minor) order by ct.amount_minor desc) from category_totals ct),
      '[]'::jsonb
    ) as categories
  from monthly_transactions mt;
$$;

revoke all on function public.get_current_workspace_dashboard_summary(uuid) from public, anon;
grant execute on function public.get_current_workspace_dashboard_summary(uuid) to authenticated, service_role;
