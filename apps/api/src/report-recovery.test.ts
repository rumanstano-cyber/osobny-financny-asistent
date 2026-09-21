import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../../../supabase/migrations/20260920220406_harden_report_and_reminder_recovery.sql', import.meta.url),
  'utf8',
);
const reports = readFileSync(new URL('./reports.ts', import.meta.url), 'utf8');
const reminders = readFileSync(new URL('./receipt-purchase-protection.ts', import.meta.url), 'utf8');
const weeklyUniqueIndex = readFileSync(
  new URL('../../../supabase/migrations/20260904211900_prevent_duplicate_weekly_reports.sql', import.meta.url),
  'utf8',
);
const monthlyUniqueIndex = readFileSync(
  new URL('../../../supabase/migrations/20260808000000_prevent_duplicate_monthly_reports.sql', import.meta.url),
  'utf8',
);

test('stale queued or generated report deliveries are reclaimed under a 15 minute lease', () => {
  assert.match(migration, /create or replace function public\.claim_scheduled_report_delivery/u);
  assert.match(migration, /p_lease_interval interval default interval '15 minutes'/u);
  assert.match(migration, /v_delivery\.claimed_at >= pg_catalog\.now\(\) - p_lease_interval[\s\S]*?return;/u);
  assert.match(migration, /set status = 'generated'[\s\S]*?claimed_at = pg_catalog\.now\(\)[\s\S]*?attempt_count = delivery\.attempt_count \+ 1/u);
});

test('a non-expired report lease cannot be reclaimed concurrently', () => {
  assert.match(migration, /from public\.report_deliveries delivery[\s\S]*?for update;/u);
  assert.match(migration, /v_delivery\.status = 'generated'[\s\S]*?v_delivery\.claimed_at >= pg_catalog\.now\(\) - p_lease_interval[\s\S]*?return;/u);
});

test('report recovery is bounded and exhausted work becomes terminal failed', () => {
  assert.match(migration, /max_attempts smallint not null default 5/u);
  assert.match(migration, /v_delivery\.attempt_count >= v_delivery\.max_attempts[\s\S]*?set status = 'failed'/u);
  assert.match(migration, /when 1 then interval '15 minutes'[\s\S]*?when 2 then interval '30 minutes'[\s\S]*?when 3 then interval '60 minutes'[\s\S]*?else interval '120 minutes'/u);
  assert.match(migration, /if v_delivery\.attempt_count >= v_delivery\.max_attempts then[\s\S]*?set status = 'failed'/u);
});

test('successful report channels remain durable and are checked before retry', () => {
  assert.match(reports, /isReportChannelDelivered\(delivery\.dataSnapshot, telegramChannel\)/u);
  assert.match(reports, /markChannelDelivered\(delivery, telegramChannel\)/u);
  assert.match(reports, /\.eq\('status', 'generated'\)/u);
});

test('report retry rechecks active user, workspace and Telegram access before sending', () => {
  assert.match(reports, /assertActiveUserWorkspaceAccess\(membership\.user_id, workspace\.id\)/u);
  assert.match(reports, /assertTelegramPrincipalAccess\(account\.external_account_id, \{ workspaceId: workspace\.id \}\)/u);
  assert.match(reports, /revokedUserIds\.add\(membership\.user_id\)/u);
  assert.match(reports, /p_cancelled: cancelled/u);
  assert.match(reports, /cancelInaccessibleReportDeliveries\('monthly_summary'\)/u);
  assert.match(reports, /cancelInaccessibleReportDeliveries\('weekly_summary'\)/u);
  assert.match(migration, /create or replace function public\.cancel_inaccessible_scheduled_report_deliveries/u);
  assert.match(migration, /not exists \([\s\S]*?membership\.status = 'active'[\s\S]*?app_user\.status = 'active'/u);
  assert.match(migration, /set status = 'cancelled'/u);
});

test('stale warranty reminders recover only while attempts remain', () => {
  assert.match(migration, /reminder\.status = 'sending' and reminder\.claimed_at < pg_catalog\.now\(\) - interval '15 minutes'/u);
  assert.match(migration, /where reminder\.attempt_count < 5/u);
  assert.match(migration, /for update of reminder skip locked/u);
  assert.match(reminders, /assertTelegramPrincipalAccess\(claim\.telegram_user_id\)/u);
});

test('an exhausted stale warranty reminder becomes terminal failed', () => {
  assert.match(migration, /with exhausted as \([\s\S]*?set status = 'failed'/u);
  assert.match(migration, /reminder\.attempt_count >= 5/u);
  assert.match(migration, /Reminder worker lease expired after final attempt/u);
  assert.doesNotMatch(migration, /where reminder\.attempt_count <= 5/u);
});

test('weekly catch-up is bounded to Monday 08:00 through 20:00 Bratislava time', () => {
  assert.match(migration, /'weekly-financial-report-bratislava'[\s\S]*?'\*\/30 \* \* \* \*'/u);
  assert.match(migration, /extract\(isodow from local_time\) = 1/u);
  assert.match(migration, /extract\(hour from local_time\) between 8 and 19/u);
  assert.match(migration, /extract\(hour from local_time\) = 20[\s\S]*?extract\(minute from local_time\) = 0/u);
});

test('monthly catch-up is bounded to days one and two from 08:00 through 20:00 Bratislava time', () => {
  assert.match(migration, /'monthly-financial-report-bratislava'[\s\S]*?'0 \* \* \* \*'/u);
  assert.match(migration, /extract\(day from local_time\) in \(1, 2\)/u);
  assert.match(migration, /extract\(hour from local_time\) between 8 and 20/u);
});

test('unfinished reports become terminal after their bounded catch-up window', () => {
  assert.match(migration, /create or replace function public\.finalize_expired_scheduled_report_deliveries/u);
  assert.match(migration, /delivery\.period_end \+ interval '21 hours' <= pg_catalog\.now\(\)/u);
  assert.match(migration, /delivery\.period_end \+ interval '45 hours' <= pg_catalog\.now\(\)/u);
  assert.match(migration, /set status = 'failed'[\s\S]*?attempt_count = delivery\.max_attempts/u);
  assert.match(migration, /select public\.finalize_expired_scheduled_report_deliveries\(\);/u);
});

test('catch-up keeps existing period uniqueness and cannot create duplicate reports', () => {
  assert.match(weeklyUniqueIndex, /unique index[\s\S]*?workspace_id, period_start[\s\S]*?weekly_summary/u);
  assert.match(monthlyUniqueIndex, /unique index[\s\S]*?workspace_id, period_start[\s\S]*?monthly_summary/u);
  assert.match(migration, /insert into public\.report_deliveries[\s\S]*?on conflict do nothing/u);
  assert.match(migration, /for update;/u);
});

test('new recovery RPCs are service-role only and use an empty search path', () => {
  assert.match(migration, /claim_scheduled_report_delivery[\s\S]*?security definer[\s\S]*?set search_path = ''/u);
  assert.match(migration, /complete_scheduled_report_delivery[\s\S]*?security definer[\s\S]*?set search_path = ''/u);
  assert.match(migration, /revoke all on function public\.claim_scheduled_report_delivery[\s\S]*?from public, anon, authenticated/u);
  assert.match(migration, /grant execute on function public\.claim_scheduled_report_delivery[\s\S]*?to service_role/u);
  assert.match(migration, /revoke all on function public\.complete_scheduled_report_delivery[\s\S]*?from public, anon, authenticated/u);
  assert.match(migration, /grant execute on function public\.complete_scheduled_report_delivery[\s\S]*?to service_role/u);
  assert.match(migration, /cancel_inaccessible_scheduled_report_deliveries[\s\S]*?security definer[\s\S]*?set search_path = ''/u);
  assert.match(migration, /revoke all on function public\.cancel_inaccessible_scheduled_report_deliveries[\s\S]*?from public, anon, authenticated/u);
  assert.match(migration, /grant execute on function public\.cancel_inaccessible_scheduled_report_deliveries[\s\S]*?to service_role/u);
  assert.match(migration, /finalize_expired_scheduled_report_deliveries[\s\S]*?security definer[\s\S]*?set search_path = ''/u);
  assert.match(migration, /revoke all on function public\.finalize_expired_scheduled_report_deliveries\(\)[\s\S]*?from public, anon, authenticated/u);
  assert.match(migration, /grant execute on function public\.finalize_expired_scheduled_report_deliveries\(\)[\s\S]*?to service_role/u);
});

test('recovery migration is append-only for customer and financial records', () => {
  assert.doesNotMatch(migration, /delete\s+from\s+public\.(?:financial_transactions|ofa_receipts|ofa_users|workspaces)/iu);
  assert.doesNotMatch(migration, /drop\s+(?:table|column)/iu);
});
