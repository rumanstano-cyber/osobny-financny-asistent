import { monthlyCommentary } from './ai.js';
import { supabase } from './supabase.js';

export async function currentMonthSummary(telegramUserId: string): Promise<string> {
  const { data: account } = await supabase.from('channel_accounts').select('user_id').eq('channel', 'telegram').eq('external_account_id', telegramUserId).is('unlinked_at', null).single();
  if (!account) return 'Zatiaľ nemáš žiadne uložené transakcie.';
  const { data: membership } = await supabase.from('workspace_members').select('workspace_id').eq('user_id', account.user_id).eq('status', 'active').limit(1).single();
  if (!membership) return 'Nenašiel som finančný priestor.';
  const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
  const { data, error } = await supabase.from('financial_transactions').select('transaction_type, amount_minor, currency_code').eq('workspace_id', membership.workspace_id).eq('status', 'confirmed').is('deleted_at', null).gte('occurred_at', start.toISOString());
  if (error) throw new Error(error.message);
  const income = (data ?? []).filter((item) => item.transaction_type === 'income').reduce((sum, item) => sum + item.amount_minor, 0);
  const expenses = (data ?? []).filter((item) => item.transaction_type === 'expense').reduce((sum, item) => sum + item.amount_minor, 0);
  const summary = `Tento mesiac: príjmy ${(income / 100).toFixed(2)} €, výdavky ${(expenses / 100).toFixed(2)} €, rozdiel ${((income - expenses) / 100).toFixed(2)} €.`;
  try { return `${summary}\n${await monthlyCommentary(summary)}`; } catch { return summary; }
}
