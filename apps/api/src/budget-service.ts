import { supabase } from './supabase.js';
import {
  budgetAmountPendingExpiresAt,
  budgetCallbackClaim,
  type BudgetCallbackIdentity,
} from './budget-callback.js';
import { assertActiveUserWorkspaceAccess } from './access-control.js';
import { safeErrorLog } from './safe-log.js';

const timeZone = 'Europe/Bratislava';

export type BudgetCategory = { id: string; name: string; slug: string };
export type BudgetContext = { userId: string; workspaceId: string; currencyCode: string };
export type BudgetStatus = {
  id: string;
  categoryId: string;
  categoryName: string;
  categorySlug: string;
  amountMinor: number;
  currencyCode: string;
  spentMinor: number;
  remainingMinor: number;
  percent: number;
};

function monthPeriod(reference = new Date()): { start: Date; end: Date } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(reference);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const year = value('year');
  const month = value('month');
  const boundary = (boundaryYear: number, boundaryMonth: number) => {
    const probe = new Date(Date.UTC(boundaryYear, boundaryMonth - 1, 1, 12));
    const offsetName = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(probe).find((part) => part.type === 'timeZoneName')?.value ?? 'GMT+00:00';
    const match = offsetName.match(/^GMT([+-])(\d{2}):(\d{2})$/);
    const offset = match ? (Number(match[2]) * 60 + Number(match[3])) * (match[1] === '+' ? 1 : -1) : 0;
    return new Date(Date.UTC(boundaryYear, boundaryMonth - 1, 1) - offset * 60_000);
  };
  const start = boundary(year, month);
  const end = boundary(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1);
  return { start, end };
}

export async function telegramBudgetContext(telegramUserId: string): Promise<BudgetContext | null> {
  const { data: account, error: accountError } = await supabase
    .from('channel_accounts').select('user_id').eq('channel', 'telegram').eq('external_account_id', telegramUserId).is('unlinked_at', null).maybeSingle();
  if (accountError) throw new Error(accountError.message);
  if (!account) return null;
  const { data: user, error: userError } = await supabase
    .from('ofa_users').select('id').eq('id', account.user_id).eq('status', 'active').is('deleted_at', null).maybeSingle();
  if (userError) throw new Error(userError.message);
  if (!user) return null;
  const { data: membership, error: membershipError } = await supabase
    .from('workspace_members').select('workspace_id').eq('user_id', account.user_id).eq('status', 'active').is('removed_at', null).limit(1).maybeSingle();
  if (membershipError) throw new Error(membershipError.message);
  if (!membership) return null;
  const { data: workspace, error: workspaceError } = await supabase.from('workspaces').select('base_currency_code').eq('id', membership.workspace_id).is('deleted_at', null).maybeSingle();
  if (workspaceError) throw new Error(workspaceError.message);
  return workspace ? { userId: account.user_id, workspaceId: membership.workspace_id, currencyCode: workspace.base_currency_code } : null;
}

export async function getBudgetCategories(context: BudgetContext): Promise<BudgetCategory[]> {
  await assertActiveUserWorkspaceAccess(context.userId, context.workspaceId);
  const { data, error } = await supabase.from('categories').select('id, name, slug')
    .eq('transaction_type', 'expense').eq('is_active', true).eq('is_archived', false)
    .or(`workspace_id.is.null,workspace_id.eq.${context.workspaceId}`).order('name');
  if (error) throw new Error(error.message);
  return (data ?? []) as BudgetCategory[];
}

async function currentSpend(context: BudgetContext, categoryId: string, currencyCode: string): Promise<number> {
  const { start, end } = monthPeriod();
  const { data: transactions, error } = await supabase.from('financial_transactions').select('id, amount_minor')
    .eq('workspace_id', context.workspaceId).eq('transaction_type', 'expense').eq('status', 'confirmed').is('deleted_at', null)
    .eq('currency_code', currencyCode).gte('occurred_at', start.toISOString()).lt('occurred_at', end.toISOString());
  if (error) throw new Error(error.message);
  const ids = (transactions ?? []).map((row) => row.id);
  if (!ids.length) return 0;
  const { data: assignments, error: assignmentError } = await supabase.from('transaction_category_assignments').select('transaction_id')
    .in('transaction_id', ids).eq('category_id', categoryId).is('valid_to', null);
  if (assignmentError) throw new Error(assignmentError.message);
  const matching = new Set((assignments ?? []).map((row) => row.transaction_id));
  return (transactions ?? []).filter((row) => matching.has(row.id)).reduce((sum, row) => sum + Number(row.amount_minor), 0);
}

export async function budgetStatus(context: BudgetContext, categoryId: string): Promise<BudgetStatus | null> {
  await assertActiveUserWorkspaceAccess(context.userId, context.workspaceId);
  const { data, error } = await supabase.from('budgets').select('id, category_id, amount_minor, currency_code, categories!inner(name, slug)')
    .eq('workspace_id', context.workspaceId).eq('category_id', categoryId).eq('period', 'monthly').eq('is_active', true).is('deleted_at', null).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const category = Array.isArray(data.categories) ? data.categories[0] : data.categories;
  if (!category) return null;
  const amountMinor = Number(data.amount_minor);
  const spentMinor = await currentSpend(context, categoryId, data.currency_code);
  return { id: data.id, categoryId, categoryName: category.name, categorySlug: category.slug, amountMinor, currencyCode: data.currency_code, spentMinor, remainingMinor: amountMinor - spentMinor, percent: amountMinor ? (spentMinor / amountMinor) * 100 : 0 };
}

export async function setBudget(context: BudgetContext, category: BudgetCategory, amountMinor: number, currencyCode: string): Promise<BudgetStatus> {
  await assertActiveUserWorkspaceAccess(context.userId, context.workspaceId);
  const { data: existing, error: existingError } = await supabase.from('budgets').select('id').eq('workspace_id', context.workspaceId).eq('category_id', category.id).eq('period', 'monthly').eq('is_active', true).is('deleted_at', null).maybeSingle();
  if (existingError) throw new Error(existingError.message);
  const now = new Date().toISOString();
  const payload = { name: `Mesačný limit – ${category.name}`, amount_minor: amountMinor, currency_code: currencyCode, starts_on: monthPeriod().start.toISOString().slice(0, 10), alert_threshold_percent: 80, is_active: true, deleted_at: null };
  let budgetId = existing?.id;
  if (budgetId) {
    const { error } = await supabase.from('budgets').update(payload).eq('id', budgetId);
    if (error) throw new Error(error.message);
  } else {
    const { data, error } = await supabase.from('budgets').insert({ ...payload, workspace_id: context.workspaceId, category_id: category.id, period: 'monthly', created_by_user_id: context.userId }).select('id').single();
    if (error || !data) throw new Error(error?.message ?? 'Budget was not created');
    budgetId = data.id;
  }
  const { error: auditError } = await supabase.from('audit_events').insert({ workspace_id: context.workspaceId, actor_user_id: context.userId, actor_type: 'user', action: existing ? 'budget.updated' : 'budget.created', entity_type: 'budget', entity_id: budgetId, after_data: { category_id: category.id, amount_minor: amountMinor, currency_code: currencyCode, at: now } });
  if (auditError) console.error('Budget audit event failed', { error: safeErrorLog(auditError) });
  return (await budgetStatus(context, category.id))!;
}

export async function cancelBudget(context: BudgetContext, categoryId: string): Promise<BudgetStatus | null> {
  await assertActiveUserWorkspaceAccess(context.userId, context.workspaceId);
  const current = await budgetStatus(context, categoryId);
  if (!current) return null;
  const { error } = await supabase.from('budgets').update({ is_active: false, deleted_at: new Date().toISOString() }).eq('id', current.id);
  if (error) throw new Error(error.message);
  await supabase.from('audit_events').insert({ workspace_id: context.workspaceId, actor_user_id: context.userId, actor_type: 'user', action: 'budget.cancelled', entity_type: 'budget', entity_id: current.id, before_data: { category_id: categoryId, amount_minor: current.amountMinor } });
  return current;
}

export async function claimBudgetAlert(context: BudgetContext, status: BudgetStatus, threshold: 80 | 100): Promise<boolean> {
  await assertActiveUserWorkspaceAccess(context.userId, context.workspaceId);
  if (status.percent < threshold) return false;
  const periodStart = monthPeriod().start.toISOString().slice(0, 10);
  const { error } = await supabase.from('budget_alert_events').insert({ workspace_id: context.workspaceId, budget_id: status.id, period_start: periodStart, threshold, sent_at: new Date().toISOString() });
  if (!error) return true;
  if (error.code === '23505') return false;
  throw new Error(error.message);
}

export async function setBudgetOfferPreference(context: BudgetContext, mode: 'later' | 'never'): Promise<void> {
  await assertActiveUserWorkspaceAccess(context.userId, context.workspaceId);
  const payload = mode === 'never'
    ? { proactive_budget_offers_enabled: false, suppressed_until: null, last_offer_at: new Date().toISOString() }
    : { proactive_budget_offers_enabled: true, suppressed_until: new Date(Date.now() + 14 * 24 * 60 * 60_000).toISOString(), last_offer_at: new Date().toISOString() };
  const { error } = await supabase.from('budget_preferences').upsert({ workspace_id: context.workspaceId, user_id: context.userId, ...payload }, { onConflict: 'workspace_id,user_id' });
  if (error) throw new Error(error.message);
}

export async function claimBudgetCallback(identity: BudgetCallbackIdentity): Promise<boolean> {
  const now = new Date().toISOString();
  const claim = budgetCallbackClaim(identity);
  const { error: cleanupError } = await supabase
    .from('telegram_budget_callback_claims')
    .delete()
    .lt('expires_at', now);
  if (cleanupError) throw new Error(cleanupError.message);

  const { error } = await supabase.from('telegram_budget_callback_claims').insert({
    claim_key: claim.claimKey,
    callback_query_hash: claim.callbackQueryHash,
    flow: 'budget',
    expires_at: claim.expiresAt,
  });
  if (!error) return true;
  if (error.code === '23505') return false;
  throw new Error(error.message);
}

export async function startBudgetAmountPending(context: BudgetContext, categoryId: string): Promise<BudgetCategory | null> {
  await assertActiveUserWorkspaceAccess(context.userId, context.workspaceId);
  const category = (await getBudgetCategories(context)).find((item) => item.id === categoryId) ?? null;
  if (!category) return null;
  const { error } = await supabase.from('telegram_budget_pending_states').upsert({ workspace_id: context.workspaceId, user_id: context.userId, category_id: categoryId, intent: 'awaiting_budget_amount', expires_at: budgetAmountPendingExpiresAt() }, { onConflict: 'workspace_id,user_id' });
  if (error) throw new Error(error.message);
  return category;
}

export async function consumeBudgetAmountPending(context: BudgetContext, amountMinor: number, currencyCode: string): Promise<BudgetStatus | null> {
  await assertActiveUserWorkspaceAccess(context.userId, context.workspaceId);
  const { data, error } = await supabase.from('telegram_budget_pending_states').select('category_id, expires_at').eq('workspace_id', context.workspaceId).eq('user_id', context.userId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || new Date(data.expires_at).getTime() < Date.now()) return null;
  const category = (await getBudgetCategories(context)).find((item) => item.id === data.category_id);
  if (!category) return null;
  const status = await setBudget(context, category, amountMinor, currencyCode);
  await supabase.from('telegram_budget_pending_states').delete().eq('workspace_id', context.workspaceId).eq('user_id', context.userId);
  return status;
}

export async function hasBudgetAmountPending(context: BudgetContext): Promise<boolean> {
  await assertActiveUserWorkspaceAccess(context.userId, context.workspaceId);
  const { data, error } = await supabase.from('telegram_budget_pending_states').select('expires_at').eq('workspace_id', context.workspaceId).eq('user_id', context.userId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return false;
  if (new Date(data.expires_at).getTime() >= Date.now()) return true;
  await supabase.from('telegram_budget_pending_states').delete().eq('workspace_id', context.workspaceId).eq('user_id', context.userId);
  return false;
}

export async function maybeBudgetOffer(context: BudgetContext, categoryId: string): Promise<BudgetStatus | BudgetCategory | null> {
  await assertActiveUserWorkspaceAccess(context.userId, context.workspaceId);
  const category = (await getBudgetCategories(context)).find((item) => item.id === categoryId);
  if (!category || await budgetStatus(context, categoryId)) return null;
  const { data: preference, error } = await supabase.from('budget_preferences').select('proactive_budget_offers_enabled, suppressed_until, last_offer_at').eq('workspace_id', context.workspaceId).eq('user_id', context.userId).maybeSingle();
  if (error) throw new Error(error.message);
  if (preference?.proactive_budget_offers_enabled === false || (preference?.suppressed_until && new Date(preference.suppressed_until).getTime() > Date.now()) || (preference?.last_offer_at && Date.now() - new Date(preference.last_offer_at).getTime() < 14 * 24 * 60 * 60_000)) return null;
  const { start, end } = monthPeriod();
  const { data: tx, error: txError } = await supabase.from('financial_transactions').select('id').eq('workspace_id', context.workspaceId).eq('transaction_type', 'expense').eq('status', 'confirmed').is('deleted_at', null).gte('occurred_at', start.toISOString()).lt('occurred_at', end.toISOString());
  if (txError) throw new Error(txError.message);
  const ids = (tx ?? []).map((row) => row.id);
  if (!ids.length) return null;
  const { count, error: countError } = await supabase.from('transaction_category_assignments').select('id', { count: 'exact', head: true }).in('transaction_id', ids).eq('category_id', categoryId).is('valid_to', null);
  if (countError || (count ?? 0) < 3) return null;
  await supabase.from('budget_preferences').upsert({ workspace_id: context.workspaceId, user_id: context.userId, proactive_budget_offers_enabled: true, last_offer_at: new Date().toISOString(), suppressed_until: null }, { onConflict: 'workspace_id,user_id' });
  return category;
}
