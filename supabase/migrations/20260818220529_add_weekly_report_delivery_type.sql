-- The enum change must be committed before its new value can be used by an
-- index predicate, so the matching index is intentionally in the next migration.
alter type public.report_type add value if not exists 'weekly_summary';
