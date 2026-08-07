-- Retire the obsolete system category while preserving immutable assignment
-- history. Current assignments are closed and replaced by Restaurants.
do $$
declare
  v_coffee_category_id uuid;
  v_restaurants_category_id uuid;
begin
  select c.id into v_coffee_category_id
  from public.categories c
  where c.kind = 'system' and c.slug = 'kava' and c.workspace_id is null;

  select c.id into v_restaurants_category_id
  from public.categories c
  where c.kind = 'system' and c.slug = 'restauracie' and c.workspace_id is null;

  if v_restaurants_category_id is null then
    raise exception 'System category restauracie is required';
  end if;

  if v_coffee_category_id is null then
    return;
  end if;

  with closed_assignments as (
    update public.transaction_category_assignments tca
    set valid_to = now()
    where tca.category_id = v_coffee_category_id
      and tca.valid_to is null
    returning tca.transaction_id, tca.confidence, tca.assigned_by_user_id
  )
  insert into public.transaction_category_assignments (
    transaction_id,
    category_id,
    source,
    confidence,
    reason,
    assigned_by_user_id,
    valid_from
  )
  select
    ca.transaction_id,
    v_restaurants_category_id,
    'system',
    ca.confidence,
    'System category consolidation: Káva → Reštaurácie',
    ca.assigned_by_user_id,
    now()
  from closed_assignments ca;

  update public.categories c
  set is_active = false,
      is_archived = true,
      archived_at = coalesce(c.archived_at, now()),
      updated_at = now()
  where c.id = v_coffee_category_id;
end;
$$;
