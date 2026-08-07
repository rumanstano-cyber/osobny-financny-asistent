-- More than one API instance may receive the monthly cron tick. A partial
-- unique index makes report generation idempotent per workspace and month.
create unique index report_deliveries_monthly_summary_period_unique_idx
  on public.report_deliveries (workspace_id, period_start)
  where report_type = 'monthly_summary';
