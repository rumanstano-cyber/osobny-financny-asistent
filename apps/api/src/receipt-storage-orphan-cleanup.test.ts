import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  reconcileClaimedReceiptStorageOrphans,
  type ReceiptStorageOrphanClaim,
  type ReceiptStorageOrphanCleanupDependencies,
} from './receipt-storage-orphan-cleanup.js';

const migration = readFileSync(
  new URL('../../../supabase/migrations/20260920174112_add_receipt_storage_orphan_reconciler.sql', import.meta.url),
  'utf8',
);
const claim: ReceiptStorageOrphanClaim = {
  run_token: '00000000-0000-4000-8000-000000000001',
  storage_key: 'incoming/telegram/123-0123456789abcdef.jpg',
};

function dependencies(options: {
  claims?: ReceiptStorageOrphanClaim[];
  confirm?: () => boolean | Promise<boolean>;
  remove?: () => void | Promise<void>;
} = {}) {
  const removed: string[] = [];
  const completions: Array<{ runToken: string; deletedCount: number; errorCount: number }> = [];
  const value: ReceiptStorageOrphanCleanupDependencies = {
    claim: async () => options.claims ?? [claim],
    confirm: async () => options.confirm ? options.confirm() : true,
    remove: async (storageKey) => {
      await options.remove?.();
      removed.push(storageKey);
    },
    complete: async (runToken, deletedCount, errorCount) => {
      completions.push({ runToken, deletedCount, errorCount });
    },
  };
  return { value, removed, completions };
}

test('an old object confirmed as genuinely orphaned can be removed', async () => {
  const state = dependencies();
  const result = await reconcileClaimedReceiptStorageOrphans(state.value);
  assert.deepEqual(result, { claimed: 1, deleted: 1, skipped: 0, errors: 0 });
  assert.deepEqual(state.removed, [claim.storage_key]);
  assert.equal(state.completions[0]?.deletedCount, 1);
});

for (const reason of ['stored_files link', 'queued job', 'running job', 'object below minimum age']) {
  test(`an object with ${reason} is never removed`, async () => {
    const state = dependencies({ confirm: () => false });
    const result = await reconcileClaimedReceiptStorageOrphans(state.value);
    assert.deepEqual(result, { claimed: 1, deleted: 0, skipped: 1, errors: 0 });
    assert.deepEqual(state.removed, []);
  });
}

test('verification uncertainty fails closed without deleting the object', async () => {
  const state = dependencies({ confirm: () => { throw new Error('database unavailable'); } });
  const result = await reconcileClaimedReceiptStorageOrphans(state.value);
  assert.deepEqual(result, { claimed: 1, deleted: 0, skipped: 0, errors: 1 });
  assert.deepEqual(state.removed, []);
  assert.equal(state.completions[0]?.errorCount, 1);
});

test('repeated cleanup is idempotent after the candidate is gone', async () => {
  let first = true;
  const state = dependencies();
  state.value.claim = async () => first ? (first = false, [claim]) : [];
  const firstResult = await reconcileClaimedReceiptStorageOrphans(state.value);
  const secondResult = await reconcileClaimedReceiptStorageOrphans(state.value);
  assert.equal(firstResult.deleted, 1);
  assert.deepEqual(secondResult, { claimed: 0, deleted: 0, skipped: 0, errors: 0 });
  assert.deepEqual(state.removed, [claim.storage_key]);
});

test('a global cleanup lease prevents two concurrent runs from claiming objects', async () => {
  let leased = false;
  const state = dependencies();
  state.value.claim = async () => {
    if (leased) return [];
    leased = true;
    return [claim];
  };
  const [first, second] = await Promise.all([
    reconcileClaimedReceiptStorageOrphans(state.value),
    reconcileClaimedReceiptStorageOrphans(state.value),
  ]);
  assert.equal(first.deleted + second.deleted, 1);
  assert.deepEqual(state.removed, [claim.storage_key]);
});

test('migration enforces age, linkage, active-job, lease and least-privilege guards', () => {
  assert.match(migration, /minimum_age >= interval '24 hours'/u);
  assert.match(migration, /storage_object\.created_at < pg_catalog\.now\(\) - p_minimum_age/u);
  assert.match(migration, /not exists \(\s*select 1\s*from public\.stored_files[\s\S]*stored_file\.storage_key = p_storage_key/iu);
  assert.match(migration, /job\.status in \('queued', 'running'\)/u);
  assert.match(migration, /job\.payload->>'updateId'/u);
  assert.match(migration, /for update/u);
  assert.match(migration, /lease_expires_at > pg_catalog\.now\(\)/u);
  assert.match(migration, /p_limit > 50/u);
  assert.match(migration, /p_limit is null/u);
  assert.match(migration, /security definer\s+set search_path = ''/u);
  assert.match(migration, /enable row level security/u);
  assert.match(migration, /grant execute on function public\.claim_receipt_storage_orphan_cleanup[\s\S]*to service_role/u);
  assert.doesNotMatch(migration, /delete\s+from\s+storage\.objects/iu);
});
