-- Keep weekly scheduled deliveries idempotent per workspace and closed week.
create unique index if not exists report_deliveries_weekly_summary_period_unique_idx
  on public.report_deliveries (workspace_id, period_start)
  where report_type = 'weekly_summary';
