-- Returns the current active expense categories visible to a Telegram user.
-- This keeps the backend category catalogue data-driven and tenant-safe.
create or replace function public.get_telegram_active_expense_categories(p_telegram_user_id text)
returns table (slug varchar, name text)
language sql
stable
security definer
set search_path = public
as $$
  with telegram_user as (
    select ca.user_id
    from public.channel_accounts ca
    where ca.channel = 'telegram'
      and ca.external_account_id = p_telegram_user_id
      and ca.unlinked_at is null
  ), active_workspaces as (
    select wm.workspace_id
    from public.workspace_members wm
    join telegram_user tu on tu.user_id = wm.user_id
    where wm.status = 'active' and wm.removed_at is null
  )
  select c.slug, c.name
  from public.categories c
  where c.transaction_type = 'expense'
    and c.is_active
    and not c.is_archived
    and (c.workspace_id is null or c.workspace_id in (select workspace_id from active_workspaces))
  order by c.workspace_id nulls first, c.name;
$$;

revoke all on function public.get_telegram_active_expense_categories(text) from public, anon, authenticated;
grant execute on function public.get_telegram_active_expense_categories(text) to service_role;
