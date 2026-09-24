import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { Zip, ZipDeflate, ZipPassThrough, strToU8 } from 'fflate';
import { supabase } from './supabase.js';

type Profile = { id: string; auth_user_id: string | null; status: string; deleted_at: string | null };
type StoredFile = { id: string; workspace_id: string; uploaded_by_user_id: string | null; storage_key: string; content_type: string; deleted_at: string | null };
type ExportClient = typeof supabase;

export class PrivacyAccessError extends Error {
  constructor() { super('Privacy request is not authorised'); }
}

/** Supabase Auth is checked remotely; browser-supplied user IDs are ignored. */
export async function resolveVerifiedWebUser(authorization: string | undefined, allowGrace = false, client: ExportClient = supabase): Promise<Profile> {
  const match = /^Bearer ([A-Za-z0-9_.-]+)$/u.exec(authorization ?? '');
  if (!match) throw new PrivacyAccessError();
  const { data: identity, error: authError } = await client.auth.getUser(match[1]);
  if (authError || !identity.user?.id || !identity.user.email_confirmed_at) throw new PrivacyAccessError();

  const { data: profile, error: profileError } = await client
    .from('ofa_users')
    .select('id, auth_user_id, status, deleted_at')
    .eq('auth_user_id', identity.user.id)
    .maybeSingle();
  if (profileError) throw new Error(profileError.message);
  if (!profile || (profile.status !== 'active' && !(allowGrace && profile.status === 'deleted' && profile.deleted_at === null))) {
    throw new PrivacyAccessError();
  }
  return profile as Profile;
}

async function readAll(table: string, ownerColumn: string, ownerId: string): Promise<Record<string, unknown>[]> {
  const output: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .eq(ownerColumn, ownerId)
      .order('id')
      .range(offset, offset + 499);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Record<string, unknown>[];
    output.push(...rows);
    if (rows.length < 500) return output;
  }
}

async function readByIds(table: string, column: string, ids: string[]): Promise<Record<string, unknown>[]> {
  const output: Record<string, unknown>[] = [];
  for (let offset = 0; offset < ids.length; offset += 100) {
    for (let page = 0; ; page += 500) {
      const { data, error } = await supabase
        .from(table)
        .select('*')
        .in(column, ids.slice(offset, offset + 100))
        .order('id')
        .range(page, page + 499);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as Record<string, unknown>[];
      output.push(...rows);
      if (rows.length < 500) break;
    }
  }
  return output;
}

export function inActiveWorkspace<T extends Record<string, unknown>>(rows: T[], workspaceIds: Set<string>): T[] {
  return rows.filter((row) => workspaceIds.has(String(row.workspace_id)));
}

async function assertExportStillAuthorised(userId: string, workspaceId?: string, client: ExportClient = supabase): Promise<void> {
  const { data: profile, error: profileError } = await client.from('ofa_users')
    .select('status, deleted_at').eq('id', userId).single();
  if (profileError || !profile || profile.status !== 'active' || profile.deleted_at !== null) throw new PrivacyAccessError();
  if (!workspaceId) return;
  const { data: membership, error: membershipError } = await client.from('workspace_members')
    .select('workspace_id, workspaces!inner(deleted_at)')
    .eq('user_id', userId).eq('workspace_id', workspaceId).eq('status', 'active')
    .is('workspaces.deleted_at', null).maybeSingle();
  if (membershipError || !membership) throw new PrivacyAccessError();
}

/**
 * Only records directly owned/created by the authenticated user are exported.
 * A shared workspace membership never grants an implicit bulk export of other
 * members' finances or receipt images through this endpoint.
 */
export async function collectPrivateExport(userId: string): Promise<{
  metadata: Record<string, unknown>;
  files: StoredFile[];
}> {
  const [profile, identities, channelAccounts, consents, memberships, transactions, receipts, protections] = await Promise.all([
    supabase.from('ofa_users').select('id, display_name, email, locale, time_zone, status, created_at').eq('id', userId).single(),
    readAll('auth_identities', 'user_id', userId),
    readAll('channel_accounts', 'user_id', userId),
    readAll('user_consents', 'user_id', userId),
    supabase.from('workspace_members').select('workspace_id, role, status, joined_at').eq('user_id', userId),
    readAll('financial_transactions', 'created_by_user_id', userId),
    readAll('ofa_receipts', 'uploaded_by_user_id', userId),
    readAll('receipt_purchase_protections', 'recipient_user_id', userId),
  ]);
  if (profile.error || !profile.data) throw new Error(profile.error?.message ?? 'Profile not found');
  if (memberships.error) throw new Error(memberships.error.message);

  const activeMemberships = (memberships.data ?? []).filter((row) => row.status === 'active');
  const memberWorkspaceIds = activeMemberships.map((row) => row.workspace_id);
  const { data: activeWorkspaces, error: workspaceError } = memberWorkspaceIds.length === 0
    ? { data: [], error: null }
    : await supabase.from('workspaces').select('id').in('id', memberWorkspaceIds).is('deleted_at', null);
  if (workspaceError) throw new Error(workspaceError.message);
  const activeWorkspaceIds = new Set((activeWorkspaces ?? []).map((row) => String(row.id)));
  const ownTransactions = inActiveWorkspace(transactions, activeWorkspaceIds);
  const ownReceipts = inActiveWorkspace(receipts, activeWorkspaceIds);
  const ownProtections = inActiveWorkspace(protections, activeWorkspaceIds);

  const transactionIds = ownTransactions.map((row) => String(row.id));
  const receiptIds = ownReceipts.map((row) => String(row.id));
  const fileIds = ownReceipts.map((row) => String(row.file_id));
  const [events, categoryAssignments, receiptItems, storedFiles] = await Promise.all([
    readByIds('transaction_events', 'transaction_id', transactionIds),
    readByIds('transaction_category_assignments', 'transaction_id', transactionIds),
    readByIds('receipt_line_items', 'receipt_id', receiptIds),
    readByIds('stored_files', 'id', fileIds),
  ]);

  // Whitelist only fields needed to find a document; never expose Storage
  // keys or internal file hashes in the JSON manifest.
  const files = (storedFiles as unknown as StoredFile[]).filter((file) =>
    file.deleted_at === null && file.uploaded_by_user_id === userId && activeWorkspaceIds.has(file.workspace_id));
  const documents = files.map((file) => ({ file_id: file.id, content_type: file.content_type }));
  return {
    metadata: {
      format_version: 1,
      exported_at: new Date().toISOString(),
      profile: profile.data,
      identities,
      channel_accounts: channelAccounts,
      privacy_acknowledgements: consents,
      memberships: activeMemberships.filter((row) => activeWorkspaceIds.has(row.workspace_id)),
      financial_transactions: ownTransactions,
      transaction_events: events.map((row) => ({ ...row, actor_user_id: row.actor_user_id === userId ? userId : null })),
      category_assignments: categoryAssignments.map((row) => ({ ...row, assigned_by_user_id: row.assigned_by_user_id === userId ? userId : null })),
      receipts: ownReceipts,
      receipt_items: receiptItems,
      purchase_protections: ownProtections,
      documents,
    },
    files,
  };
}

/** On-demand stream: no export archive or URL is persisted anywhere. */
export function streamPrivateExport(
  payload: Awaited<ReturnType<typeof collectPrivateExport>>,
  userId: string,
  client: ExportClient = supabase,
): PassThrough {
  const output = new PassThrough();
  const archive = new Zip((error, chunk, final) => {
    if (error) { output.destroy(error); return; }
    if (chunk.length > 0) output.write(Buffer.from(chunk));
    if (final) output.end();
  });

  void (async () => {
    try {
      await assertExportStillAuthorised(userId, undefined, client);
      const manifest = new ZipDeflate('data.json', { level: 6 });
      archive.add(manifest);
      manifest.push(strToU8(JSON.stringify(payload.metadata, null, 2)), true);
      if (output.writableNeedDrain) await once(output, 'drain');

      for (const file of payload.files) {
        await assertExportStillAuthorised(userId, file.workspace_id, client);
        const { data, error } = await client.storage.from('ofa-receipts').download(file.storage_key);
        if (error || !data) throw new Error(error?.message ?? 'A receipt document is unavailable');
        const extension = file.content_type === 'application/pdf' ? 'pdf' : file.content_type === 'image/png' ? 'png' : 'jpg';
        const entry = new ZipPassThrough(`documents/${file.id}.${extension}`);
        archive.add(entry);
        for await (const chunk of data.stream() as AsyncIterable<Uint8Array>) {
          entry.push(chunk);
          if (output.writableNeedDrain) await once(output, 'drain');
        }
        entry.push(new Uint8Array(0), true);
      }
      archive.end();
    } catch (error) {
      archive.terminate();
      output.destroy(error instanceof Error ? error : new Error('Export failed'));
    }
  })();
  return output;
}
