import assert from 'node:assert/strict';
import test from 'node:test';
import { acknowledgeErasureManifest, createErasureManifest } from './backup-erasure-reconciliation.mjs';

const requestId = '00000000-0000-4000-8000-00000000f101';
const userId = '00000000-0000-4000-8000-00000000a101';

function response(value, status = 200) {
  return { ok: status === 200, status, json: async () => value };
}

test('a backup captures only minimal erasure identifiers and status', async () => {
  const calls = [];
  const manifest = await createErasureManifest('https://example.supabase.co', 'test-only-key',
    async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return response([{
        request_id: requestId, user_id: userId, request_status: 'requested',
        requested_at: '2026-09-01T00:00:00Z', due_at: '2026-10-01T00:00:00Z',
        completed_at: null, email: 'must-not-be-exported@example.invalid',
      }]);
    });
  assert.equal(manifest.records.length, 1);
  assert.equal(JSON.stringify(manifest).includes('must-not-be-exported'), false);
  assert.equal(calls[0].url.endsWith('/rpc/list_erasure_reconciliation_snapshot'), true);
});

test('an acknowledged backup includes only still-pending request IDs', async () => {
  const bodies = [];
  const manifest = { version: 1, capturedAt: new Date().toISOString(), records: [
    { requestId, status: 'requested' },
    { requestId: '00000000-0000-4000-8000-00000000f102', status: 'cancelled' },
  ] };
  const count = await acknowledgeErasureManifest('https://example.supabase.co', 'test-only-key', manifest,
    async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return response(1);
    });
  assert.equal(count, 1);
  assert.deepEqual(bodies[0].p_request_ids, [requestId]);
});

test('RPC failure prevents acknowledging an unverified backup', async () => {
  const manifest = { version: 1, capturedAt: new Date().toISOString(), records: [{ requestId, status: 'requested' }] };
  await assert.rejects(acknowledgeErasureManifest('https://example.supabase.co', 'test-only-key', manifest,
    async () => response({}, 503)), /HTTP 503/u);
});
