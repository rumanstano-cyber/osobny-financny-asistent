import { supabase } from './supabase.js';

export type TelegramPrincipalAccess = {
  state: 'new' | 'active' | 'revoked';
  userId: string | null;
  activeWorkspaceIds: string[];
};

type ChannelAccountRow = { user_id: string; unlinked_at: string | null };
type UserRow = { id: string; status: string; deleted_at: string | null };
type MembershipRow = { user_id: string; workspace_id: string; status: string; removed_at: string | null };

export class AccessRevokedError extends Error {
  constructor(message = 'Telegram principal access is not active') {
    super(message);
    this.name = 'AccessRevokedError';
  }
}

export function deriveTelegramPrincipalAccess(
  accounts: ChannelAccountRow[],
  users: UserRow[],
  memberships: MembershipRow[],
  existingWorkspaceIds: ReadonlySet<string>,
  options: { allowUnlinkedForRelink?: boolean } = {},
): TelegramPrincipalAccess {
  if (accounts.length === 0) return { state: 'new', userId: null, activeWorkspaceIds: [] };
  const linkedUserIds = new Set(accounts
    .filter((account) => account.unlinked_at === null || options.allowUnlinkedForRelink)
    .map((account) => account.user_id));
  const activeUsers = users.filter((user) => linkedUserIds.has(user.id) && user.status === 'active' && user.deleted_at === null);
  for (const user of activeUsers) {
    const activeWorkspaceIds = memberships
      .filter((membership) => membership.user_id === user.id
        && membership.status === 'active'
        && membership.removed_at === null
        && existingWorkspaceIds.has(membership.workspace_id))
      .map((membership) => membership.workspace_id);
    if (activeWorkspaceIds.length > 0) return { state: 'active', userId: user.id, activeWorkspaceIds };
  }
  const knownUserId = accounts.find((account) => account.unlinked_at === null)?.user_id ?? accounts[0]?.user_id ?? null;
  return { state: 'revoked', userId: knownUserId, activeWorkspaceIds: [] };
}

/**
 * Resolves access from the existing production source of truth. A Telegram ID
 * with no history is new and may enter onboarding. Once an account exists,
 * unlinking, suspending/deleting the user, removing all memberships, or
 * deleting all of their workspaces is a revocation and must never look new.
 */
export async function resolveTelegramPrincipalAccess(
  telegramUserId: string,
  options: { allowUnlinkedForRelink?: boolean } = {},
): Promise<TelegramPrincipalAccess> {
  const { data: accountData, error: accountError } = await supabase
    .from('channel_accounts')
    .select('user_id, unlinked_at')
    .eq('channel', 'telegram')
    .eq('external_account_id', telegramUserId);
  if (accountError) throw new Error(accountError.message);

  const accounts = (accountData ?? []) as ChannelAccountRow[];
  if (accounts.length === 0) return { state: 'new', userId: null, activeWorkspaceIds: [] };

  const linkedUserIds = [...new Set(accounts
    .filter((account) => account.unlinked_at === null || options.allowUnlinkedForRelink)
    .map((account) => account.user_id))];
  if (linkedUserIds.length === 0) return deriveTelegramPrincipalAccess(accounts, [], [], new Set(), options);

  const { data: userData, error: userError } = await supabase
    .from('ofa_users')
    .select('id, status, deleted_at')
    .in('id', linkedUserIds);
  if (userError) throw new Error(userError.message);
  const users = (userData ?? []) as UserRow[];
  const activeUsers = users.filter((user) => user.status === 'active' && user.deleted_at === null);
  if (activeUsers.length === 0) return deriveTelegramPrincipalAccess(accounts, users, [], new Set(), options);

  const activeUserIds = activeUsers.map((user) => user.id);
  const { data: membershipData, error: membershipError } = await supabase
    .from('workspace_members')
    .select('user_id, workspace_id, status, removed_at')
    .in('user_id', activeUserIds)
    .eq('status', 'active')
    .is('removed_at', null);
  if (membershipError) throw new Error(membershipError.message);
  const memberships = (membershipData ?? []) as MembershipRow[];
  const workspaceIds = [...new Set(memberships.map((membership) => membership.workspace_id))];
  if (workspaceIds.length === 0) return deriveTelegramPrincipalAccess(accounts, users, memberships, new Set(), options);

  const { data: workspaceData, error: workspaceError } = await supabase
    .from('workspaces')
    .select('id')
    .in('id', workspaceIds)
    .is('deleted_at', null);
  if (workspaceError) throw new Error(workspaceError.message);
  const existingWorkspaceIds = new Set((workspaceData ?? []).map((workspace) => workspace.id));

  return deriveTelegramPrincipalAccess(accounts, users, memberships, existingWorkspaceIds, options);
}

export async function assertTelegramPrincipalAccess(
  telegramUserId: string,
  options: { allowNew?: boolean; workspaceId?: string; allowUnlinkedForRelink?: boolean } = {},
  resolver: (id: string, options?: { allowUnlinkedForRelink?: boolean }) => Promise<TelegramPrincipalAccess> = resolveTelegramPrincipalAccess,
): Promise<TelegramPrincipalAccess> {
  const access = await resolver(telegramUserId, { allowUnlinkedForRelink: options.allowUnlinkedForRelink });
  if (access.state === 'new' && options.allowNew) return access;
  if (access.state !== 'active') throw new AccessRevokedError();
  if (options.workspaceId && !access.activeWorkspaceIds.includes(options.workspaceId)) {
    throw new AccessRevokedError('Telegram principal is not an active member of the requested workspace');
  }
  return access;
}

/** Revalidates an already resolved user/workspace pair immediately before use. */
export async function assertActiveUserWorkspaceAccess(userId: string, workspaceId: string): Promise<void> {
  const [userResult, membershipResult, workspaceResult] = await Promise.all([
    supabase.from('ofa_users').select('id').eq('id', userId).eq('status', 'active').is('deleted_at', null).maybeSingle(),
    supabase.from('workspace_members').select('workspace_id').eq('user_id', userId).eq('workspace_id', workspaceId).eq('status', 'active').is('removed_at', null).maybeSingle(),
    supabase.from('workspaces').select('id').eq('id', workspaceId).is('deleted_at', null).maybeSingle(),
  ]);
  const error = userResult.error ?? membershipResult.error ?? workspaceResult.error;
  if (error) throw new Error(error.message);
  if (!userResult.data || !membershipResult.data || !workspaceResult.data) throw new AccessRevokedError();
}
