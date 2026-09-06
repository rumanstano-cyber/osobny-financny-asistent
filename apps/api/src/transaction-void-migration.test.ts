import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../../../supabase/migrations/20260906191013_harden_telegram_last_transaction_void.sql', import.meta.url),
  'utf8',
);
const reports = readFileSync(new URL('./reports.ts', import.meta.url), 'utf8');
const dashboard = readFileSync(new URL('../../../apps/web/src/components/Dashboard.tsx', import.meta.url), 'utf8');

test('void migration locks and voids only the current last transaction', () => {
  assert.match(migration, /order by ft\.created_at desc, ft\.id desc\s+limit 1\s+for update/iu);
  assert.match(migration, /v_transaction\.id <> p_transaction_id/iu);
  assert.match(migration, /set status = 'voided'/iu);
  assert.doesNotMatch(migration, /delete\s+from\s+public\.financial_transactions/iu);
});

test('void migration preserves both transaction and workspace audit evidence', () => {
  assert.match(migration, /insert into public\.transaction_events/iu);
  assert.match(migration, /insert into public\.audit_events/iu);
  assert.match(migration, /'transaction\.voided_from_telegram'/u);
  assert.match(migration, /'amount_minor', v_transaction\.amount_minor/iu);
});

test('reports and dashboard explicitly exclude voided transactions', () => {
  assert.match(reports, /\.eq\('status', 'confirmed'\)/u);
  assert.match(reports, /\.is\('deleted_at', null\)/u);
  assert.match(dashboard, /\.eq\('status', 'confirmed'\)/u);
});
