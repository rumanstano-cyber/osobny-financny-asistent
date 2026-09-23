import { safeErrorLog } from './safe-log.js';
import { supabase } from './supabase.js';

type Claim = { request_id: string; user_id: string; lease_token: string };
type FileClaim = { file_id: string; storage_key: string };
type ErasureClient = typeof supabase;

/** Bounded worker invoked by the existing protected maintenance route. */
export async function processDueAccountErasures(client: ErasureClient = supabase): Promise<{
  completed: number;
  deferred: number;
}> {
  const { data, error } = await client.rpc('claim_due_account_erasures', { p_limit: 2 });
  if (error) throw new Error(error.message);
  let completed = 0;
  let deferred = 0;

  for (const claim of (data as Claim[] | null) ?? []) {
    let code = 'worker_error';
    try {
      const { data: files, error: filesError } = await client.rpc('list_account_erasure_storage_files', {
        p_request_id: claim.request_id,
        p_lease_token: claim.lease_token,
        p_limit: 25,
      });
      if (filesError) throw new Error(filesError.message);

      for (const file of (files as FileClaim[] | null) ?? []) {
        const { error: storageError } = await client.storage.from('ofa-receipts').remove([file.storage_key]);
        if (storageError) throw new Error(storageError.message);
        const { data: marked, error: markError } = await client.rpc('mark_account_erasure_storage_file_removed', {
          p_request_id: claim.request_id,
          p_lease_token: claim.lease_token,
          p_file_id: file.file_id,
        });
        if (markError || marked !== true) throw new Error(markError?.message ?? 'Storage removal could not be recorded');
      }

      const { data: remaining, error: remainingError } = await client.rpc('list_account_erasure_storage_files', {
        p_request_id: claim.request_id,
        p_lease_token: claim.lease_token,
        p_limit: 1,
      });
      if (remainingError) throw new Error(remainingError.message);
      if (((remaining as FileClaim[] | null) ?? []).length > 0) {
        code = 'storage_pending';
        throw new Error('Storage batch complete; more files remain');
      }

      // Auth deletion is ordered after private Storage removal. On success the
      // existing FK clears auth_user_id. A crash before DB finalization is
      // therefore safely retried without a second Auth deletion.
      const { data: profile, error: profileError } = await client.from('ofa_users')
        .select('auth_user_id').eq('id', claim.user_id).single();
      if (profileError || !profile) throw new Error(profileError?.message ?? 'Account not found');
      if (profile.auth_user_id) {
        const { error: authError } = await client.auth.admin.deleteUser(profile.auth_user_id);
        if (authError) throw new Error(authError.message);
      }

      const { data: finalized, error: finalizeError } = await client.rpc('finalize_account_erasure', {
        p_request_id: claim.request_id,
        p_lease_token: claim.lease_token,
      });
      if (finalizeError || finalized !== true) {
        code = 'reconciliation_required';
        throw new Error(finalizeError?.message ?? 'Erasure finalization was not confirmed');
      }
      completed += 1;
    } catch (error) {
      deferred += 1;
      console.error('Account erasure requires retry or reconciliation', {
        requestId: claim.request_id,
        code,
        error: safeErrorLog(error),
      });
      const { error: deferError } = await client.rpc('defer_account_erasure', {
        p_request_id: claim.request_id,
        p_lease_token: claim.lease_token,
        p_error_code: code,
      });
      if (deferError) console.error('Account erasure defer failed', {
        requestId: claim.request_id,
        error: safeErrorLog(deferError),
      });
    }
  }
  return { completed, deferred };
}
