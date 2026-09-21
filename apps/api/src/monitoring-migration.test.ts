import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../../../supabase/migrations/20260921114740_add_operational_watchdog_snapshot.sql', import.meta.url),
  'utf8',
);

test('watchdog snapshot is read-only, privacy-minimised and service-role only', () => {
  assert.match(migration, /create or replace function public\.get_operational_watchdog_snapshot\(\)/u);
  assert.match(migration, /security definer\s+set search_path = ''/u);
  assert.match(migration, /revoke all on function public\.get_operational_watchdog_snapshot\(\) from public, anon, authenticated/u);
  assert.match(migration, /grant execute on function public\.get_operational_watchdog_snapshot\(\) to service_role/u);
  assert.doesNotMatch(migration, /\b(insert|update|delete|truncate|drop)\b/iu);
  assert.doesNotMatch(migration, /payload|last_error|data_snapshot|external_account_id/iu);
});

test('watchdog snapshot covers terminal work and critical cron liveness without user data', () => {
  assert.match(migration, /public\.async_jobs[\s\S]*?status = 'failed'/u);
  assert.match(migration, /public\.report_deliveries[\s\S]*?status = 'failed'/u);
  assert.match(migration, /public\.receipt_purchase_protection_reminders[\s\S]*?status = 'failed'/u);
  assert.match(migration, /cron\.job_run_details/u);
  assert.match(migration, /recent_failure_count >= 2/u);
  assert.match(migration, /extensions\.digest/u);
  assert.doesNotMatch(migration, /merchant|email|telegram_user|workspace_id|recipient_user_id/iu);
});
