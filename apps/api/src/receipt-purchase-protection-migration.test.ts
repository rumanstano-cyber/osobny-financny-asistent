import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../../../supabase/migrations/20260910203407_receipt_purchase_protection.sql', import.meta.url),
  'utf8',
);
const service = readFileSync(new URL('./receipt-purchase-protection.ts', import.meta.url), 'utf8');
const telegram = readFileSync(new URL('./telegram.ts', import.meta.url), 'utf8');

test('receipt migration keeps financial data while modelling archive lifecycle explicitly', () => {
  assert.match(migration, /archive_status in \('decision_pending', 'archived', 'pending_deletion', 'cleanup_claimed', 'storage_deleted'\)/u);
  assert.match(migration, /retention_until timestamptz/u);
  assert.match(migration, /storage_deleted_at timestamptz/u);
  assert.match(migration, /create table public\.receipt_purchase_protections/u);
  assert.match(migration, /unique \(receipt_id\)/u);
  assert.doesNotMatch(migration, /delete\s+from\s+public\.financial_transactions/iu);
});

test('receipt protection decision is serialized, scoped to its Telegram owner, and idempotent', () => {
  assert.match(migration, /for update of r/u);
  assert.match(migration, /r\.uploaded_by_user_id = v_user_id/u);
  assert.match(migration, /on conflict \(receipt_id\) do update/u);
  assert.match(migration, /archive_status = 'archived', retention_until = null/u);
  assert.match(migration, /archive_status = 'pending_deletion'/u);
  assert.match(migration, /interval '24 months'/u);
  assert.match(migration, /receipt\.purchase_protection_enabled/u);
  assert.match(migration, /receipt\.purchase_protection_declined/u);
});

test('cleanup only claims completed OCR records and deletes the storage object through the Storage API', () => {
  assert.match(migration, /not exists \(\s*select 1\s*from public\.receipt_ocr_runs/iu);
  assert.match(migration, /archive_status = 'cleanup_claimed'/u);
  assert.match(migration, /archive_status = 'storage_deleted'/u);
  assert.match(service, /storage\.from\('ofa-receipts'\)\.remove\(\[claim\.storage_key\]\)/u);
  assert.match(service, /complete_receipt_storage_deletion/u);
  assert.match(telegram, /\.eq\('archive_status', 'archived'\)/u);
  assert.doesNotMatch(migration, /delete\s+from\s+storage\.objects/iu);
});

test('reminders are durable, only scheduled at 60/30/7 days, and voiding cancels active tracking', () => {
  assert.match(migration, /milestone_days in \(60, 30, 7\)/u);
  assert.match(migration, /unique \(protection_id, milestone_days\)/u);
  assert.match(migration, /for update of reminder skip locked/u);
  assert.match(migration, /receipt\.purchase_protection_reminder_sent/u);
  assert.match(migration, /financial_transactions_cancel_receipt_purchase_protection/u);
  assert.match(migration, /receipt\.purchase_protection_cancelled_for_voided_transaction/u);
});

test('Telegram asks after successful receipt processing and production cron invokes protected maintenance', () => {
  assert.match(telegram, /Chceš tento doklad uložiť a sledovať zákonnú 2-ročnú ochranu nákupu\?/u);
  assert.match(telegram, /text\('ÁNO', receiptPurchaseProtectionCallbackData\(receipt\.id, true\)\)/u);
  assert.match(telegram, /text\('NIE', receiptPurchaseProtectionCallbackData\(receipt\.id, false\)\)/u);
  assert.match(migration, /receipt-purchase-protection-maintenance/u);
  assert.match(migration, /X-Internal-Cron-Secret/u);
  assert.match(migration, /enable row level security/u);
  assert.match(migration, /revoke all on function public\.decide_telegram_receipt_purchase_protection/u);
});
