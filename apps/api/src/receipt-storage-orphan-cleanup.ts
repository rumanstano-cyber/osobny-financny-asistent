import { safeErrorLog } from './safe-log.js';
import { supabase } from './supabase.js';

const minimumOrphanAge = '24 hours';
const cleanupLease = '10 minutes';
const cleanupLimit = 25;

export type ReceiptStorageOrphanClaim = {
  run_token: string;
  storage_key: string;
};

export type ReceiptStorageOrphanCleanupDependencies = {
  claim: () => Promise<ReceiptStorageOrphanClaim[]>;
  confirm: (runToken: string, storageKey: string) => Promise<boolean>;
  remove: (storageKey: string) => Promise<void>;
  complete: (runToken: string, deletedCount: number, errorCount: number) => Promise<void>;
  onError?: (operation: 'confirm' | 'remove', runToken: string, error: unknown) => void;
};

export type ReceiptStorageOrphanCleanupResult = {
  claimed: number;
  deleted: number;
  skipped: number;
  errors: number;
};

export async function reconcileClaimedReceiptStorageOrphans(
  dependencies: ReceiptStorageOrphanCleanupDependencies,
): Promise<ReceiptStorageOrphanCleanupResult> {
  const claims = await dependencies.claim();
  if (claims.length === 0) return { claimed: 0, deleted: 0, skipped: 0, errors: 0 };

  const runToken = claims[0]?.run_token;
  if (!runToken || claims.some((claim) => claim.run_token !== runToken || !claim.storage_key)) {
    throw new Error('Invalid receipt orphan cleanup claim');
  }

  let deleted = 0;
  let skipped = 0;
  let errors = 0;
  for (const claim of claims) {
    let confirmed = false;
    try {
      confirmed = await dependencies.confirm(runToken, claim.storage_key);
    } catch (error) {
      errors += 1;
      dependencies.onError?.('confirm', runToken, error);
      continue;
    }
    if (!confirmed) {
      skipped += 1;
      continue;
    }
    try {
      await dependencies.remove(claim.storage_key);
      deleted += 1;
    } catch (error) {
      errors += 1;
      dependencies.onError?.('remove', runToken, error);
    }
  }

  await dependencies.complete(runToken, deleted, errors);
  return { claimed: claims.length, deleted, skipped, errors };
}

function parseClaims(value: unknown): ReceiptStorageOrphanClaim[] {
  if (!Array.isArray(value)) throw new Error('Invalid receipt orphan cleanup response');
  if (value.length > 50) throw new Error('Receipt orphan cleanup response exceeded its safe limit');
  const claims: ReceiptStorageOrphanClaim[] = [];
  const storageKeys = new Set<string>();
  for (const row of value) {
    if (!row || typeof row !== 'object') throw new Error('Invalid receipt orphan cleanup row');
    const candidate = row as Partial<ReceiptStorageOrphanClaim>;
    if (typeof candidate.run_token !== 'string' || typeof candidate.storage_key !== 'string') {
      throw new Error('Invalid receipt orphan cleanup row');
    }
    if (storageKeys.has(candidate.storage_key)) throw new Error('Duplicate receipt orphan cleanup row');
    storageKeys.add(candidate.storage_key);
    claims.push({ run_token: candidate.run_token, storage_key: candidate.storage_key });
  }
  return claims;
}

export async function reconcileReceiptStorageOrphans(): Promise<ReceiptStorageOrphanCleanupResult> {
  return reconcileClaimedReceiptStorageOrphans({
    claim: async () => {
      const { data, error } = await supabase.rpc('claim_receipt_storage_orphan_cleanup', {
        p_minimum_age: minimumOrphanAge,
        p_limit: cleanupLimit,
        p_lease_interval: cleanupLease,
      });
      if (error) throw new Error(error.message);
      return parseClaims(data);
    },
    confirm: async (runToken, storageKey) => {
      const { data, error } = await supabase.rpc('confirm_receipt_storage_orphan_deletion', {
        p_run_token: runToken,
        p_storage_key: storageKey,
      });
      if (error) throw new Error(error.message);
      return data === true;
    },
    remove: async (storageKey) => {
      const { error } = await supabase.storage.from('ofa-receipts').remove([storageKey]);
      if (error) throw new Error(error.message);
    },
    complete: async (runToken, deletedCount, errorCount) => {
      const { data, error } = await supabase.rpc('complete_receipt_storage_orphan_cleanup', {
        p_run_token: runToken,
        p_deleted_count: deletedCount,
        p_error: errorCount > 0 ? `${errorCount} cleanup operations failed safely` : null,
      });
      if (error) throw new Error(error.message);
      if (data !== true) throw new Error('Receipt orphan cleanup lease could not be completed');
    },
    onError: (operation, runToken, error) => {
      console.error('Receipt storage orphan cleanup operation failed safely', {
        operation,
        runToken,
        error: safeErrorLog(error),
      });
    },
  });
}
