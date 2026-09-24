import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyErasureReconciliation } from './verify-erasure-reconciliation.mjs';

const requestId = '00000000-0000-4000-8000-00000000f101';
const userId = '00000000-0000-4000-8000-00000000a101';
const now = Date.parse('2026-09-24T12:00:00Z');
const manifest = (status) => ({ version: 1, capturedAt: '2026-09-24T11:00:00Z', records: [
  { requestId, userId, status },
] });
const restored = (status, userStatus = 'deleted', userDeleted = false) => [
  { requestId, userId, status, userStatus, userDeleted },
];

test('recent ledger accepts a restored pending erasure only while access remains revoked', () => {
  assert.deepEqual(verifyErasureReconciliation(manifest('requested'), restored('requested'), now),
    { checked: 1, pending: 1 });
  assert.throws(() => verifyErasureReconciliation(manifest('requested'), restored('requested', 'active'), now));
});

test('a backup from before the erasure request cannot be promoted', () => {
  assert.throws(() => verifyErasureReconciliation(manifest('requested'), [], now));
});

test('a pending erasure cannot be revived as an active cancelled account', () => {
  assert.throws(() => verifyErasureReconciliation(manifest('requested'), restored('cancelled', 'active'), now));
});

test('a completed erasure cannot be revived by restoring an older database', () => {
  assert.deepEqual(verifyErasureReconciliation(manifest('completed'), restored('completed', 'deleted', true), now),
    { checked: 1, pending: 0 });
  assert.throws(() => verifyErasureReconciliation(manifest('completed'), restored('requested'), now));
  assert.throws(() => verifyErasureReconciliation(manifest('completed'), restored('completed', 'deleted', false), now));
});

test('missing or stale independent ledger fails closed', () => {
  assert.throws(() => verifyErasureReconciliation(null, restored('completed', 'deleted', true), now));
  assert.throws(() => verifyErasureReconciliation({ ...manifest('completed'), capturedAt: '2026-09-21T00:00:00Z' },
    restored('completed', 'deleted', true), now));
});

test('a cancellation is not silently converted back into a pending erasure', () => {
  assert.throws(() => verifyErasureReconciliation(manifest('cancelled'), restored('requested'), now));
});
