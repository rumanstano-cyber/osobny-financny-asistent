import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const PAGE_SIZE = 500;
const MAX_PAGES = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const STATUSES = new Set(['requested', 'processing', 'completed', 'cancelled', 'rejected']);

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function callBackupRpc(baseUrl, serviceKey, name, body, fetcher = fetch) {
  const response = await fetcher(`${baseUrl.replace(/\/+$/u, '')}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  // Do not log the response body: providers may echo request identifiers.
  if (!response.ok) throw new Error(`Privacy reconciliation RPC failed (HTTP ${response.status})`);
  return response.json();
}

export async function createErasureManifest(baseUrl, serviceKey, fetcher = fetch) {
  const capturedAt = new Date().toISOString();
  const records = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = await callBackupRpc(baseUrl, serviceKey,
      'list_erasure_reconciliation_snapshot', { p_after: after, p_limit: PAGE_SIZE }, fetcher);
    if (!Array.isArray(rows) || rows.length > PAGE_SIZE) throw new Error('Invalid reconciliation page');
    for (const row of rows) {
      if (!UUID.test(row.request_id) || !UUID.test(row.user_id)
          || !STATUSES.has(row.request_status)
          || (after && row.request_id <= after)) {
        throw new Error('Invalid reconciliation record');
      }
      records.push({
        requestId: row.request_id,
        userId: row.user_id,
        status: row.request_status,
        requestedAt: row.requested_at,
        dueAt: row.due_at,
        completedAt: row.completed_at,
      });
      after = row.request_id;
    }
    if (rows.length < PAGE_SIZE) return { version: 1, capturedAt, records };
  }
  throw new Error('Reconciliation snapshot exceeds the safe page limit');
}

export async function acknowledgeErasureManifest(baseUrl, serviceKey, manifest, fetcher = fetch) {
  if (manifest?.version !== 1 || !Number.isFinite(Date.parse(manifest.capturedAt))
      || !Array.isArray(manifest.records)) throw new Error('Invalid reconciliation manifest');
  const pendingIds = manifest.records
    .filter((row) => row.status === 'requested' || row.status === 'processing')
    .map((row) => row.requestId);
  let acknowledged = 0;
  for (let offset = 0; offset < pendingIds.length; offset += PAGE_SIZE) {
    const count = await callBackupRpc(baseUrl, serviceKey,
      'ack_erasure_reconciliation_snapshot', {
        p_snapshot_at: manifest.capturedAt,
        p_request_ids: pendingIds.slice(offset, offset + PAGE_SIZE),
      }, fetcher);
    if (!Number.isInteger(count) || count < 0 || count > PAGE_SIZE) {
      throw new Error('Invalid reconciliation acknowledgement');
    }
    acknowledged += count;
  }
  return acknowledged;
}

async function main() {
  const [mode, file] = process.argv.slice(2);
  if (!['snapshot', 'ack'].includes(mode) || !file) {
    throw new Error('Usage: backup-erasure-reconciliation.mjs snapshot|ack <manifest-path>');
  }
  const baseUrl = requiredEnv('SUPABASE_URL');
  const serviceKey = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
  if (mode === 'snapshot') {
    const manifest = await createErasureManifest(baseUrl, serviceKey);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
    console.log(`Privacy reconciliation snapshot captured (${manifest.records.length} records).`);
  } else {
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    const count = await acknowledgeErasureManifest(baseUrl, serviceKey, manifest);
    console.log(`Privacy reconciliation backup acknowledged (${count} pending requests).`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Privacy reconciliation failed');
    process.exitCode = 1;
  });
}
