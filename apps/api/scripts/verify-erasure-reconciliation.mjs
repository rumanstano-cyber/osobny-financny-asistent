import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const ACTIVE_REQUESTS = new Set(['requested', 'processing']);

export function verifyErasureReconciliation(manifest, restoredRows, now = Date.now()) {
  if (manifest?.version !== 1 || !Array.isArray(manifest.records)
      || !Number.isFinite(Date.parse(manifest.capturedAt))
      || now - Date.parse(manifest.capturedAt) > 36 * 60 * 60 * 1000
      || Date.parse(manifest.capturedAt) > now + 60_000) {
    throw new Error('Recent independent erasure ledger is required before restore promotion');
  }
  const restored = new Map(restoredRows.map((row) => [row.requestId, row]));
  for (const entry of manifest.records) {
    const row = restored.get(entry.requestId);
    if (!row || row.userId !== entry.userId) {
      throw new Error('Restored database requires erasure reconciliation before promotion');
    }
    if (entry.status === 'completed') {
      if (row.status !== 'completed' || row.userStatus !== 'deleted' || !row.userDeleted) {
        throw new Error('Restored database requires completed erasure replay before promotion');
      }
    } else if (ACTIVE_REQUESTS.has(entry.status)) {
      if (!(ACTIVE_REQUESTS.has(row.status) || row.status === 'completed')
          || row.userStatus !== 'deleted') {
        throw new Error('Restored database does not preserve pending erasure access revocation');
      }
    } else if (row.status !== entry.status) {
      throw new Error('Restored database requires request-state reconciliation before promotion');
    }
  }
  return { checked: manifest.records.length,
    pending: manifest.records.filter((entry) => ACTIVE_REQUESTS.has(entry.status)).length };
}

function parseRestoredRows(value) {
  return value.split('\n').filter(Boolean).map((line) => {
    const [requestId, userId, status, userStatus, userDeleted] = line.split('\t');
    if (!requestId || !userId || !status || !userStatus
        || !['t', 'f', 'true', 'false'].includes(userDeleted)) {
      throw new Error('Invalid restored erasure state');
    }
    return { requestId, userId, status, userStatus, userDeleted: userDeleted === 't' || userDeleted === 'true' };
  });
}

async function main() {
  const [manifestPath, restoredRowsPath] = process.argv.slice(2);
  if (!manifestPath || !restoredRowsPath) throw new Error('Both reconciliation files are required');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const restoredRows = parseRestoredRows(await readFile(restoredRowsPath, 'utf8'));
  const result = verifyErasureReconciliation(manifest, restoredRows);
  console.log(`Isolated restore erasure gate passed (${result.checked} records, ${result.pending} pending).`);
  if (result.pending > 0) {
    console.log('Live promotion remains blocked until due erasures are replayed and verified.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Erasure reconciliation failed');
    process.exitCode = 1;
  });
}
