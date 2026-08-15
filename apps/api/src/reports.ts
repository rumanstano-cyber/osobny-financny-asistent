import type { Bot } from 'grammy';
import { monthlyCommentary, monthlyReportCommentary } from './ai.js';
import { config } from './config.js';
import { supabase } from './supabase.js';

const reportTimeZone = 'Europe/Bratislava';

type TransactionRow = { id: string; transaction_type: 'income' | 'expense'; amount_minor: number; currency_code: string };
type CategoryAssignmentRow = { transaction_id: string; category: { name: string; slug: string } | { name: string; slug: string }[] | null };
type WorkspaceRow = { id: string; base_currency_code: string };
type MembershipRow = { workspace_id: string; user_id: string; role: string };
type TelegramAccountRow = { user_id: string; external_account_id: string };
type CurrentMonthReportLookup = { report: MonthlyReport; unavailableMessage: null } | { report: null; unavailableMessage: string };

export type CategorySpend = { name: string; slug: string; amountMinor: number };
export type MonthlyReport = {
  periodStart: Date;
  periodEnd: Date;
  monthLabel: string;
  currencyCode: string;
  incomeMinor: number;
  expenseMinor: number;
  balanceMinor: number;
  categories: CategorySpend[];
};

function formatCurrency(amountMinor: number, currencyCode: string): string {
  return new Intl.NumberFormat('sk-SK', {
    style: 'currency',
    currency: currencyCode,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amountMinor / 100);
}

function zonedDateParts(date: Date): { year: number; month: number; day: number } {
  const values = new Intl.DateTimeFormat('en-CA', {
    timeZone: reportTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = (type: string) => Number(values.find((part) => part.type === type)?.value);
  return { year: value('year'), month: value('month'), day: value('day') };
}

function zonedMonthBoundary(year: number, month: number): Date {
  const probe = new Date(Date.UTC(year, month - 1, 1, 12));
  const offsetName = new Intl.DateTimeFormat('en-US', {
    timeZone: reportTimeZone,
    timeZoneName: 'longOffset',
  }).formatToParts(probe).find((part) => part.type === 'timeZoneName')?.value ?? 'GMT+00:00';
  const match = offsetName.match(/^GMT([+-])(\d{2}):(\d{2})$/);
  const offsetMinutes = match
    ? (Number(match[2]) * 60 + Number(match[3])) * (match[1] === '+' ? 1 : -1)
    : 0;
  return new Date(Date.UTC(year, month - 1, 1) - offsetMinutes * 60_000);
}

function currentMonthPeriod(referenceDate = new Date()): { start: Date; end: Date; monthLabel: string } {
  const { year, month } = zonedDateParts(referenceDate);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const start = zonedMonthBoundary(year, month);
  const end = zonedMonthBoundary(nextYear, nextMonth);
  const monthLabel = new Intl.DateTimeFormat('sk-SK', { timeZone: reportTimeZone, month: 'long', year: 'numeric' }).format(start);
  return { start, end, monthLabel };
}

function categoryFromAssignment(value: CategoryAssignmentRow['category']): { name: string; slug: string } | null {
  return Array.isArray(value) ? value[0] ?? null : value;
}

export async function buildMonthlyReport(workspaceId: string, currencyCode: string, referenceDate = new Date()): Promise<MonthlyReport> {
  const period = currentMonthPeriod(referenceDate);
  const { data, error } = await supabase
    .from('financial_transactions')
    .select('id, transaction_type, amount_minor, currency_code')
    .eq('workspace_id', workspaceId)
    .eq('status', 'confirmed')
    .is('deleted_at', null)
    .eq('currency_code', currencyCode)
    .gte('occurred_at', period.start.toISOString())
    .lt('occurred_at', period.end.toISOString());
  if (error) throw new Error(error.message);

  const transactions = (data ?? []) as TransactionRow[];
  const incomeMinor = transactions.filter((item) => item.transaction_type === 'income').reduce((sum, item) => sum + item.amount_minor, 0);
  const expenseTransactions = transactions.filter((item) => item.transaction_type === 'expense');
  const expenseMinor = expenseTransactions.reduce((sum, item) => sum + item.amount_minor, 0);

  const transactionIds = expenseTransactions.map((item) => item.id);
  const assignmentByTransaction = new Map<string, { name: string; slug: string }>();
  if (transactionIds.length > 0) {
    const { data: assignments, error: assignmentError } = await supabase
      .from('transaction_category_assignments')
      .select('transaction_id, category:categories!inner(name, slug)')
      .in('transaction_id', transactionIds)
      .is('valid_to', null);
    if (assignmentError) throw new Error(assignmentError.message);
    for (const assignment of (assignments ?? []) as unknown as CategoryAssignmentRow[]) {
      const category = categoryFromAssignment(assignment.category);
      if (category) assignmentByTransaction.set(assignment.transaction_id, category);
    }
  }

  const categoryTotals = new Map<string, CategorySpend>();
  for (const transaction of expenseTransactions) {
    const category = assignmentByTransaction.get(transaction.id) ?? { name: 'Ostatné', slug: 'ostatne' };
    const current = categoryTotals.get(category.slug) ?? { ...category, amountMinor: 0 };
    current.amountMinor += transaction.amount_minor;
    categoryTotals.set(category.slug, current);
  }

  return {
    periodStart: period.start,
    periodEnd: period.end,
    monthLabel: period.monthLabel,
    currencyCode,
    incomeMinor,
    expenseMinor,
    balanceMinor: incomeMinor - expenseMinor,
    categories: [...categoryTotals.values()].sort((left, right) => right.amountMinor - left.amountMinor),
  };
}

function reportNumbers(report: MonthlyReport, previousExpenseMinor?: number): string {
  const categories = report.categories.slice(0, 5).map((item) => `${item.name}: ${formatCurrency(item.amountMinor, report.currencyCode)}`).join(', ') || 'žiadne výdavky';
  const trend = previousExpenseMinor === undefined
    ? ''
    : ` Výdavky v predchádzajúcom mesiaci: ${formatCurrency(previousExpenseMinor, report.currencyCode)}.`;
  return `Mesiac: ${report.monthLabel}. Príjmy: ${formatCurrency(report.incomeMinor, report.currencyCode)}. Výdavky: ${formatCurrency(report.expenseMinor, report.currencyCode)}. Bilancia: ${formatCurrency(report.balanceMinor, report.currencyCode)}.${trend} Top kategórie: ${categories}.`;
}

function quickChartUrl(report: MonthlyReport): string {
  const categories = report.categories.slice(0, 8);
  const total = categories.reduce((sum, item) => sum + item.amountMinor, 0);
  const chart = {
    type: 'pie',
    data: {
      labels: categories.map((item) => {
        const share = total > 0 ? Math.round((item.amountMinor / total) * 100) : 0;
        return `${item.name} (${share} %)`;
      }),
      datasets: [{
        data: categories.map((item) => item.amountMinor / 100),
        backgroundColor: ['#2563eb', '#16a34a', '#f59e0b', '#dc2626', '#7c3aed', '#0891b2', '#db2777', '#65a30d'],
        borderColor: '#ffffff',
        borderWidth: 2,
      }],
    },
    options: {
      plugins: {
        title: { display: true, text: `Výdavky podľa kategórií – ${report.monthLabel}`, font: { size: 20 } },
        legend: { position: 'bottom', labels: { boxWidth: 14, padding: 16, font: { size: 13 } } },
      },
    },
  };
  return `https://quickchart.io/chart?width=800&height=500&c=${encodeURIComponent(JSON.stringify(chart))}`;
}

function telegramCaption(report: MonthlyReport, commentary: string): string {
  const categoryLines = report.categories.slice(0, 8).map((item) => {
    const share = report.expenseMinor > 0 ? Math.round((item.amountMinor / report.expenseMinor) * 100) : 0;
    return `• ${item.name}: ${formatCurrency(item.amountMinor, report.currencyCode)} (${share} %)`;
  });
  return [
    `📊 Mesačný prehľad – ${report.monthLabel}`,
    `Príjmy: ${formatCurrency(report.incomeMinor, report.currencyCode)}`,
    `Výdavky: ${formatCurrency(report.expenseMinor, report.currencyCode)}`,
    `Bilancia: ${formatCurrency(report.balanceMinor, report.currencyCode)}`,
    '',
    'Výdavky podľa kategórií:',
    ...(categoryLines.length > 0 ? categoryLines : ['• Zatiaľ žiadne výdavky']),
    '',
    commentary,
  ].join('\n');
}

function htmlEscape(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] ?? character);
}

function reportEmailHtml(report: MonthlyReport, commentary: string, chartUrl: string): string {
  const categoryRows = report.categories.map((item) => `<tr><td>${htmlEscape(item.name)}</td><td style="text-align:right">${htmlEscape(formatCurrency(item.amountMinor, report.currencyCode))}</td></tr>`).join('');
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#111827"><h1>Mesačný prehľad – ${htmlEscape(report.monthLabel)}</h1><img src="${htmlEscape(chartUrl)}" alt="Graf výdavkov" style="max-width:100%;height:auto"><table style="border-collapse:collapse;margin:16px 0"><tr><td>Príjmy</td><td>${htmlEscape(formatCurrency(report.incomeMinor, report.currencyCode))}</td></tr><tr><td>Výdavky</td><td>${htmlEscape(formatCurrency(report.expenseMinor, report.currencyCode))}</td></tr><tr><td><strong>Bilancia</strong></td><td><strong>${htmlEscape(formatCurrency(report.balanceMinor, report.currencyCode))}</strong></td></tr></table><p>${htmlEscape(commentary)}</p><h2>Výdavky podľa kategórií</h2><table style="border-collapse:collapse">${categoryRows || '<tr><td>Bez výdavkov</td><td></td></tr>'}</table></body></html>`;
}

async function sendReportEmail(report: MonthlyReport, commentary: string, chartUrl: string): Promise<boolean> {
  if (!config.RESEND_API_KEY || !config.EMAIL_FROM || !config.EMAIL_TO) return false;
  const to = config.EMAIL_TO.split(',').map((address) => address.trim()).filter(Boolean);
  if (to.length === 0) return false;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${config.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: config.EMAIL_FROM, to, subject: `Mesačný finančný prehľad – ${report.monthLabel}`, html: reportEmailHtml(report, commentary, chartUrl) }),
  });
  if (!response.ok) throw new Error(`Resend delivery failed: ${response.status}`);
  return true;
}

async function claimMonthlyDelivery(workspace: WorkspaceRow, report: MonthlyReport): Promise<string | null> {
  const { data, error } = await supabase
    .from('report_deliveries')
    .insert({
      workspace_id: workspace.id,
      report_type: 'monthly_summary',
      period_start: report.periodStart.toISOString(),
      period_end: report.periodEnd.toISOString(),
      base_currency_code: workspace.base_currency_code,
      data_snapshot: { incomeMinor: report.incomeMinor, expenseMinor: report.expenseMinor, balanceMinor: report.balanceMinor, categories: report.categories },
      status: 'queued',
    })
    .select('id')
    .single();
  if (error?.code === '23505') return null;
  if (error || !data) throw new Error(error?.message ?? 'Unable to create report delivery');
  return data.id as string;
}

async function markDelivery(deliveryId: string, status: 'generated' | 'sent' | 'failed'): Promise<void> {
  const now = new Date().toISOString();
  const patch = status === 'sent' ? { status, generated_at: now, sent_at: now } : { status, generated_at: now };
  const { error } = await supabase.from('report_deliveries').update(patch).eq('id', deliveryId);
  if (error) console.error('Unable to update report delivery', { deliveryId, error: error.message });
}

export async function sendMonthlyReports(bot: Bot, referenceDate = new Date()): Promise<{ delivered: number; skipped: number; failed: number }> {
  const { data: accounts, error: accountError } = await supabase
    .from('channel_accounts')
    .select('user_id, external_account_id')
    .eq('channel', 'telegram')
    .is('unlinked_at', null);
  if (accountError) throw new Error(accountError.message);

  const telegramAccounts = (accounts ?? []) as TelegramAccountRow[];
  if (telegramAccounts.length === 0) return { delivered: 0, skipped: 0, failed: 0 };
  const userIds = [...new Set(telegramAccounts.map((account) => account.user_id))];
  const accountByUser = new Map(telegramAccounts.map((account) => [account.user_id, account]));

  const { data: memberships, error: membershipError } = await supabase
    .from('workspace_members')
    .select('workspace_id, user_id, role')
    .in('user_id', userIds)
    .eq('status', 'active');
  if (membershipError) throw new Error(membershipError.message);
  const activeMemberships = (memberships ?? []) as MembershipRow[];
  if (activeMemberships.length === 0) return { delivered: 0, skipped: 0, failed: 0 };

  const workspaceIds = [...new Set(activeMemberships.map((membership) => membership.workspace_id))];
  const { data: workspaces, error: workspaceError } = await supabase.from('workspaces').select('id, base_currency_code').in('id', workspaceIds).is('deleted_at', null);
  if (workspaceError) throw new Error(workspaceError.message);
  const workspaceById = new Map(((workspaces ?? []) as WorkspaceRow[]).map((workspace) => [workspace.id, workspace]));

  let delivered = 0;
  let skipped = 0;
  let failed = 0;
  for (const membership of activeMemberships) {
    const account = accountByUser.get(membership.user_id);
    const workspace = workspaceById.get(membership.workspace_id);
    if (!account || !workspace) continue;
    try {
      const report = await buildMonthlyReport(workspace.id, workspace.base_currency_code, referenceDate);
      const deliveryId = await claimMonthlyDelivery(workspace, report);
      if (!deliveryId) {
        skipped += 1;
        continue;
      }
      const previousReferenceDate = new Date(report.periodStart.getTime() - 12 * 60 * 60 * 1_000);
      const previousReport = await buildMonthlyReport(workspace.id, workspace.base_currency_code, previousReferenceDate);
      const numbers = reportNumbers(report, previousReport.expenseMinor);
      let commentary: string;
      try { commentary = await monthlyReportCommentary(numbers); } catch { commentary = 'Prehľad je pripravený. Sleduj najväčšie kategórie výdavkov v ďalšom mesiaci.'; }
      const chartUrl = quickChartUrl(report);
      let sent = false;
      try {
        await bot.api.sendPhoto(account.external_account_id, chartUrl, { caption: telegramCaption(report, commentary) });
        sent = true;
      } catch (error) {
        console.error('Telegram monthly report delivery failed', { workspaceId: workspace.id, error: error instanceof Error ? error.message : String(error) });
      }
      if (membership.role === 'owner') {
        try { sent = (await sendReportEmail(report, commentary, chartUrl)) || sent; } catch (error) { console.error('Email monthly report delivery failed', { workspaceId: workspace.id, error: error instanceof Error ? error.message : String(error) }); }
      }
      await markDelivery(deliveryId, sent ? 'sent' : 'failed');
      if (sent) delivered += 1; else failed += 1;
    } catch (error) {
      failed += 1;
      console.error('Monthly report generation failed', { workspaceId: membership.workspace_id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { delivered, skipped, failed };
}

async function loadCurrentMonthReport(telegramUserId: string): Promise<CurrentMonthReportLookup> {
  const { data: account } = await supabase.from('channel_accounts').select('user_id').eq('channel', 'telegram').eq('external_account_id', telegramUserId).is('unlinked_at', null).single();
  if (!account) return { report: null, unavailableMessage: 'Zatiaľ nemáš žiadne uložené transakcie.' };
  const { data: membership } = await supabase.from('workspace_members').select('workspace_id').eq('user_id', account.user_id).eq('status', 'active').limit(1).single();
  if (!membership) return { report: null, unavailableMessage: 'Nenašiel som finančný priestor.' };
  const { data: workspace } = await supabase.from('workspaces').select('base_currency_code').eq('id', membership.workspace_id).is('deleted_at', null).single();
  if (!workspace) return { report: null, unavailableMessage: 'Nenašiel som finančný priestor.' };
  const report = await buildMonthlyReport(membership.workspace_id, workspace.base_currency_code);
  return { report, unavailableMessage: null };
}

export async function currentMonthSummary(telegramUserId: string): Promise<string> {
  const lookup = await loadCurrentMonthReport(telegramUserId);
  if (!lookup.report) return lookup.unavailableMessage;
  const report = lookup.report;
  const summary = reportNumbers(report);
  try { return `${summary}\n${await monthlyCommentary(summary)}`; } catch { return summary; }
}

export type CurrentMonthVisualReport = { chartUrl: string | null; caption: string };

export async function currentMonthVisualReport(telegramUserId: string): Promise<CurrentMonthVisualReport> {
  const lookup = await loadCurrentMonthReport(telegramUserId);
  if (!lookup.report) return { chartUrl: null, caption: lookup.unavailableMessage };

  const summary = reportNumbers(lookup.report);
  let commentary = '';
  try { commentary = await monthlyCommentary(summary); } catch { commentary = 'Prehľad je pripravený. Sleduj najväčšie kategórie výdavkov.'; }
  return {
    chartUrl: lookup.report.categories.length > 0 ? quickChartUrl(lookup.report) : null,
    caption: telegramCaption(lookup.report, commentary),
  };
}
