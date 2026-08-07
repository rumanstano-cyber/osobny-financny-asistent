-- Global deterministic categorisation rules. These are intentionally separate
-- from categories so rules can evolve without changing the category taxonomy.
create table public.category_rules (
  id uuid primary key default gen_random_uuid(),
  keyword text not null check (char_length(trim(keyword)) between 1 and 160),
  category_id uuid not null references public.categories(id) on delete restrict,
  match_type text not null default 'contains' check (match_type in ('contains', 'exact')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index category_rules_match_keyword_unique_idx
  on public.category_rules (match_type, lower(keyword));
create index category_rules_category_id_idx on public.category_rules (category_id);
create index category_rules_active_idx on public.category_rules (is_active) where is_active;

create trigger category_rules_set_updated_at
before update on public.category_rules
for each row execute function public.set_updated_at();

alter table public.category_rules enable row level security;

with seed_rules(keyword, category_slug) as (
  values
    ('unipetrol', 'auto'),
    ('slovnaft', 'auto'),
    ('shell', 'auto'),
    ('omv', 'auto'),
    ('nafta', 'auto'),
    ('benzín', 'auto'),
    ('diesel', 'auto'),
    ('autodiel', 'auto'),
    ('pneuservis', 'auto'),
    ('stk', 'auto'),
    ('tesco', 'potraviny'),
    ('lidl', 'potraviny'),
    ('kaufland', 'potraviny'),
    ('billa', 'potraviny'),
    ('coop', 'potraviny'),
    ('potraviny', 'potraviny'),
    ('pekáreň', 'potraviny'),
    ('kaviareň', 'restauracie'),
    ('espresso', 'restauracie'),
    ('gastro', 'restauracie'),
    ('reštaurácia', 'restauracie'),
    ('mcdonalds', 'restauracie'),
    ('pivo', 'restauracie'),
    ('obed', 'restauracie'),
    ('menu', 'restauracie'),
    ('pizzeria', 'restauracie'),
    ('wolt', 'restauracie'),
    ('bolt food', 'restauracie'),
    ('spp', 'byvanie'),
    ('zse', 'byvanie'),
    ('vse', 'byvanie'),
    ('vykurovanie', 'byvanie'),
    ('nájom', 'byvanie'),
    ('dr. max', 'zdravie'),
    ('benu', 'zdravie'),
    ('lekáreň', 'zdravie'),
    ('dm drogerie', 'drogeria'),
    ('teta', 'drogeria'),
    ('101 drogerie', 'drogeria'),
    ('notino', 'drogeria')
)
insert into public.category_rules (keyword, category_id, match_type)
select sr.keyword, c.id, 'contains'
from seed_rules sr
join public.categories c
  on c.slug = sr.category_slug
 and c.kind = 'system'
 and c.workspace_id is null
 and c.is_active
 and not c.is_archived
on conflict (match_type, lower(keyword)) do update
set category_id = excluded.category_id,
    is_active = true,
    updated_at = now();
