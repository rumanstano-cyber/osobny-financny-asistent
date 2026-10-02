import { supabase } from './supabase.js';
import { assertActiveUserWorkspaceAccess } from './access-control.js';
import { findPersonMatches, type LoanDirection, type LoanIntent } from './loan-intents.js';
import { formatAmount, type ParsedTransaction } from './finance-parser.js';

type Currency = ParsedTransaction['currencyCode'];
type Counterparty = { id: string; name: string };
type LoanRow = { id: string; counterparty_id: string; direction: LoanDirection; original_minor: number; repaid_minor: number; currency_code: string; due_on: string | null; status: string };
export type LoanContext = { userId: string; workspaceId: string };
export type LoanEntry = { name: string; direction: LoanDirection; currencyCode: string; remainingMinor: number; dueOn: string | null };
export type LoanSnapshot = { entries: LoanEntry[] };
export type LoanDecision = { kind: 'ready'; counterpartyId: string | null; name: string | null }
  | { kind: 'missing_name' }
  | { kind: 'missing_loan' }
  | { kind: 'ambiguous'; candidates: Counterparty[] }
  | { kind: 'overpayment'; balanceMinor: number };

export class LoanWriteConflict extends Error {
  constructor(public readonly code: string) { super('Loan state changed before write'); }
}

export async function ensureTelegramLoanWorkspace(telegramUserId: string, displayName: string, currencyCode: string): Promise<void> {
  const { error } = await supabase.rpc('ensure_telegram_loan_workspace', {
    p_telegram_user_id: telegramUserId, p_display_name: displayName, p_currency_code: currencyCode,
  });
  if (error) throw new Error(error.message);
}

export async function telegramLoanContext(telegramUserId: string): Promise<LoanContext | null> {
  const { data: account, error: accountError } = await supabase.from('channel_accounts')
    .select('user_id').eq('channel', 'telegram').eq('external_account_id', telegramUserId).is('unlinked_at', null).maybeSingle();
  if (accountError) throw new Error(accountError.message);
  if (!account) return null;
  const { data: memberships, error } = await supabase.from('workspace_members')
    .select('workspace_id, role, workspaces!inner(created_at, deleted_at)')
    .eq('user_id', account.user_id).eq('status', 'active').is('removed_at', null)
    .is('workspaces.deleted_at', null);
  if (error) throw new Error(error.message);
  const ordered = (memberships ?? []).sort((a, b) =>
    Number(b.role === 'owner') - Number(a.role === 'owner')
    || String((Array.isArray(a.workspaces) ? a.workspaces[0] : a.workspaces)?.created_at).localeCompare(String((Array.isArray(b.workspaces) ? b.workspaces[0] : b.workspaces)?.created_at)));
  const workspaceId = ordered[0]?.workspace_id;
  if (!workspaceId) return null;
  await assertActiveUserWorkspaceAccess(account.user_id, workspaceId);
  return { userId: account.user_id, workspaceId };
}

async function openLoanRows(workspaceId: string): Promise<{ people: Counterparty[]; loans: LoanRow[] }> {
  const { data: loans, error } = await supabase.from('personal_loans')
    .select('id, counterparty_id, direction, original_minor, repaid_minor, currency_code, due_on, status')
    .eq('workspace_id', workspaceId).eq('status', 'OPEN').order('opened_at');
  if (error) throw new Error(error.message);
  const ids = [...new Set((loans ?? []).map((loan) => loan.counterparty_id))];
  if (!ids.length) return { people: [], loans: [] };
  const { data: people, error: peopleError } = await supabase.from('loan_counterparties')
    .select('id, name').eq('workspace_id', workspaceId).in('id', ids);
  if (peopleError) throw new Error(peopleError.message);
  return { people: (people ?? []) as Counterparty[], loans: (loans ?? []) as LoanRow[] };
}

export async function loanSnapshot(context: LoanContext): Promise<LoanSnapshot> {
  await assertActiveUserWorkspaceAccess(context.userId, context.workspaceId);
  return workspaceLoanSnapshot(context.workspaceId);
}

export async function workspaceLoanSnapshot(workspaceId: string): Promise<LoanSnapshot> {
  const { people, loans } = await openLoanRows(workspaceId);
  const byId = new Map(people.map((person) => [person.id, person.name]));
  const entries = new Map<string, LoanEntry>();
  for (const loan of loans) {
    const name = byId.get(loan.counterparty_id);
    if (!name) continue;
    const key = `${loan.counterparty_id}:${loan.direction}:${loan.currency_code}`;
    const current = entries.get(key) ?? { name, direction: loan.direction, currencyCode: loan.currency_code, remainingMinor: 0, dueOn: null };
    current.remainingMinor += Number(loan.original_minor) - Number(loan.repaid_minor);
    if (loan.due_on && (!current.dueOn || loan.due_on < current.dueOn)) current.dueOn = loan.due_on;
    entries.set(key, current);
  }
  return { entries: [...entries.values()].sort((a, b) => a.name.localeCompare(b.name, 'sk')) };
}

export function formatLoanSnapshot(snapshot: LoanSnapshot, direction: LoanDirection | null = null, name: string | null = null): string {
  let entries = snapshot.entries.filter((entry) => direction === null || entry.direction === direction);
  if (name) {
    const matches = findPersonMatches(name, entries.map((entry, index) => ({ id: String(index), name: entry.name })));
    if (new Set(matches.map((match) => match.name)).size > 1) return `Myslíš ${matches.map((match) => match.name).join(' alebo ')}?`;
    entries = entries.filter((entry) => matches.some((match) => match.name === entry.name));
    if (entries.length === 0) return `Pre ${name} nemáš otvorenú pôžičku.`;
  }
  if (entries.length === 0) return 'Momentálne nemáš evidovanú žiadnu otvorenú pôžičku.';
  const lines: string[] = ['💰 Pôžičky'];
  for (const [side, title] of [['lent', 'Mne dlhujú:'], ['borrowed', 'Ja dlhujem:']] as const) {
    const group = entries.filter((entry) => entry.direction === side);
    if (!group.length) continue;
    lines.push('', title);
    for (const entry of group) lines.push(`${entry.name} — ${formatLoanAmount(entry.remainingMinor, entry.currencyCode)}${entry.dueOn ? ` (do ${entry.dueOn})` : ''}`);
    const currencies = [...new Set(group.map((entry) => entry.currencyCode))];
    for (const currency of currencies) lines.push(`Spolu: ${formatLoanAmount(group.filter((entry) => entry.currencyCode === currency).reduce((sum, entry) => sum + entry.remainingMinor, 0), currency)}`);
  }
  return lines.join('\n');
}

export function formatLoanAmount(amountMinor: number, currencyCode: string): string {
  return formatAmount(amountMinor, currencyCode as Currency);
}

export async function decideLoanWrite(context: LoanContext, intent: Exclude<LoanIntent, null | { kind: 'status' }>): Promise<LoanDecision> {
  await assertActiveUserWorkspaceAccess(context.userId, context.workspaceId);
  if (!intent.name) return { kind: 'missing_name' };
  const { people, loans } = await openLoanRows(context.workspaceId);
  const relevant = people.filter((person) => loans.some((loan) => loan.counterparty_id === person.id
    && loan.direction === intent.direction && loan.currency_code === intent.currencyCode));
  const matches = findPersonMatches(intent.name, intent.kind === 'repayment' ? relevant : people);
  if (matches.length > 1) return { kind: 'ambiguous', candidates: matches };
  if (intent.kind === 'principal') return { kind: 'ready', counterpartyId: matches[0]?.id ?? null, name: matches[0] ? null : intent.name };
  if (matches.length === 0) return { kind: 'missing_loan' };
  const balanceMinor = loans.filter((loan) => loan.counterparty_id === matches[0].id
    && loan.direction === intent.direction && loan.currency_code === intent.currencyCode)
    .reduce((sum, loan) => sum + Number(loan.original_minor) - Number(loan.repaid_minor), 0);
  if (intent.amountMinor > balanceMinor) return { kind: 'overpayment', balanceMinor };
  return { kind: 'ready', counterpartyId: matches[0].id, name: null };
}

export async function recordLoanWrite(telegramUserId: string, context: LoanContext, message: {
  chatId: string; messageId: string; updateId: string; occurredAt: string;
}, intent: Exclude<LoanIntent, null | { kind: 'status' }>, decision: Extract<LoanDecision, { kind: 'ready' }>) {
  await assertActiveUserWorkspaceAccess(context.userId, context.workspaceId);
  const { data, error } = await supabase.rpc('record_telegram_loan_movement', {
    p_telegram_user_id: telegramUserId, p_chat_id: message.chatId, p_message_id: message.messageId,
    p_update_id: message.updateId, p_name: decision.name, p_counterparty_id: decision.counterpartyId,
    p_direction: intent.direction, p_kind: intent.kind, p_amount_minor: intent.amountMinor,
    p_currency_code: intent.currencyCode, p_due_on: intent.dueOn, p_occurred_at: message.occurredAt,
  });
  if (error?.code === '22003' || error?.code === 'P0002') throw new LoanWriteConflict(error.code);
  if (error) throw new Error(error.message);
  return (data as { movement_id: string; counterparty_name: string; remaining_minor: number; was_duplicate: boolean }[] | null)?.[0] ?? null;
}

export async function lastLoanMovement(context: LoanContext, transactionId: string) {
  await assertActiveUserWorkspaceAccess(context.userId, context.workspaceId);
  const { data, error } = await supabase.from('loan_movements').select('id, kind, direction, amount_minor, currency_code')
    .eq('workspace_id', context.workspaceId).eq('transaction_id', transactionId).eq('created_by_user_id', context.userId).is('voided_at', null).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export async function voidLastLoan(telegramUserId: string, movementId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('void_last_telegram_loan_movement', {
    p_telegram_user_id: telegramUserId, p_movement_id: movementId,
  });
  if (error) throw new Error(error.message);
  return data === true;
}
