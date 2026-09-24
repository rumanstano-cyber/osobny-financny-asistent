import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { getSupabaseClient } from '../supabase';
import { PrivacyControls } from './PrivacyControls';
import { PrivacyNoticeBanner } from './PrivacyNoticeBanner';

type Workspace = { id: string; name: string; base_currency_code: string };
type Transaction = {
  id: string;
  transaction_type: 'income' | 'expense' | 'transfer';
  amount_minor: number;
  currency_code: string;
  occurred_at: string;
  merchant_name: string | null;
  note: string | null;
  transaction_category_assignments: Array<{ categories: { name: string } | null }> | null;
};
type Receipt = { id: string; merchant_name: string | null; receipt_date: string | null; total_amount_minor: number | null; currency_code: string | null };
type Budget = { id: string; amount_minor: number; currency_code: string; categories: { name: string } | { name: string }[] | null };
type DashboardSummary = {
  income_minor: number;
  expense_minor: number;
  balance_minor: number;
  receipt_count: number;
  categories: Array<{ name: string; amount_minor: number }>;
};
type DashboardSummaryRow = Omit<DashboardSummary, 'categories'> & { categories: unknown };
type DashboardRpcClient = {
  rpc: (functionName: 'get_current_workspace_dashboard_summary', args: { p_workspace_id: string }) => Promise<{ data: DashboardSummaryRow[] | null; error: { message: string } | null }>;
};

function formatMoney(amountMinor: number, currency = 'EUR') {
  return new Intl.NumberFormat('sk-SK', { style: 'currency', currency }).format(amountMinor / 100);
}

function categoryName(transaction: Transaction) {
  return transaction.transaction_category_assignments?.[0]?.categories?.name ?? 'Ostatné';
}

export function Dashboard({ session }: { session: Session }) {
  const supabase = getSupabaseClient();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [receiptCount, setReceiptCount] = useState(0);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [telegramLinked, setTelegramLinked] = useState(false);
  const [pairingCode, setPairingCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { data: workspaceRows, error: workspaceError } = await supabase
        .from('workspaces')
        .select('id, name, base_currency_code')
        .order('created_at', { ascending: true });
      if (workspaceError) throw workspaceError;
      const allowedWorkspaces = (workspaceRows ?? []) as Workspace[];
      setWorkspaces(allowedWorkspaces);
      const selectedWorkspaceId = workspaceId || allowedWorkspaces[0]?.id || '';
      setWorkspaceId(selectedWorkspaceId);

      const { data: channels, error: channelError } = await supabase
        .from('channel_accounts')
        .select('id')
        .eq('channel', 'telegram')
        .is('unlinked_at', null);
      if (channelError) throw channelError;
      setTelegramLinked((channels?.length ?? 0) > 0);

      if (!selectedWorkspaceId) {
        setTransactions([]);
        setReceipts([]);
        setBudgets([]);
        setReceiptCount(0);
        return;
      }

      const [transactionResult, receiptResult, summaryResult, budgetResult] = await Promise.all([
        supabase
        .from('financial_transactions')
        .select('id, transaction_type, amount_minor, currency_code, occurred_at, merchant_name, note, transaction_category_assignments!left(categories!inner(name))')
        .eq('workspace_id', selectedWorkspaceId)
        .eq('status', 'confirmed')
        .is('deleted_at', null)
          .order('occurred_at', { ascending: false })
          .limit(12),
        supabase
          .from('ofa_receipts')
          .select('id, merchant_name, receipt_date, total_amount_minor, currency_code')
          .eq('workspace_id', selectedWorkspaceId)
          .is('deleted_at', null)
          .order('created_at', { ascending: false })
          .limit(4),
        (supabase as unknown as DashboardRpcClient).rpc('get_current_workspace_dashboard_summary', { p_workspace_id: selectedWorkspaceId }),
        supabase.from('budgets').select('id, amount_minor, currency_code, categories!inner(name)')
          .eq('workspace_id', selectedWorkspaceId).eq('period', 'monthly').eq('is_active', true).is('deleted_at', null),
      ]);
      if (transactionResult.error) throw transactionResult.error;
      if (receiptResult.error) throw receiptResult.error;
      if (summaryResult.error) throw summaryResult.error;
      if (budgetResult.error) throw budgetResult.error;
      setTransactions((transactionResult.data ?? []) as unknown as Transaction[]);
      setReceipts((receiptResult.data ?? []) as Receipt[]);
      const summaryRow = Array.isArray(summaryResult.data) ? summaryResult.data[0] : null;
      setSummary(summaryRow ? {
        income_minor: Number(summaryRow.income_minor),
        expense_minor: Number(summaryRow.expense_minor),
        balance_minor: Number(summaryRow.balance_minor),
        receipt_count: Number(summaryRow.receipt_count),
        categories: Array.isArray(summaryRow.categories) ? summaryRow.categories.map((item: { name?: unknown; amount_minor?: unknown }) => ({ name: String(item.name), amount_minor: Number(item.amount_minor) })) : [],
      } : null);
      setReceiptCount(summaryRow ? Number(summaryRow.receipt_count) : 0);
      setBudgets((budgetResult.data ?? []) as unknown as Budget[]);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Dáta sa nepodarilo načítať.');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { void loadDashboard(); }, [loadDashboard]);

  const displaySummary = useMemo(() => {
    const currency = workspaces.find((item) => item.id === workspaceId)?.base_currency_code ?? 'EUR';
    return {
      income: summary?.income_minor ?? 0,
      expenses: summary?.expense_minor ?? 0,
      balance: summary?.balance_minor ?? 0,
      currency,
      categories: summary?.categories.slice(0, 5) ?? [],
    };
  }, [summary, workspaceId, workspaces]);

  const displayBudgets = useMemo(() => budgets.map((budget) => {
    const category = Array.isArray(budget.categories) ? budget.categories[0] : budget.categories;
    const spent = summary?.categories.find((item) => item.name === category?.name)?.amount_minor ?? 0;
    const remaining = Number(budget.amount_minor) - spent;
    return { id: budget.id, category: category?.name ?? 'Kategória', amount: Number(budget.amount_minor), spent, remaining, currency: budget.currency_code };
  }), [budgets, summary]);

  async function createPairingCode() {
    setError('');
    const { data, error: pairingError } = await supabase.rpc('create_telegram_link_code');
    if (pairingError) { setError(pairingError.message); return; }
    const value = Array.isArray(data)
      ? data[0] as { code?: unknown; expires_at?: unknown } | undefined
      : undefined;
    if (typeof value?.code !== 'string' || typeof value.expires_at !== 'string') {
      setError('Párovací kód sa nepodarilo vytvoriť.');
      return;
    }
    setPairingCode({ code: value.code, expiresAt: value.expires_at });
  }

  return (
    <main className="dashboard-shell">
      <header className="topbar">
        <div><span className="eyebrow">Osobný finančný asistent</span><h1>Prehľad financií</h1></div>
        <button className="button secondary" type="button" onClick={() => void supabase.auth.signOut()}>Odhlásiť</button>
      </header>

      <section className="workspace-bar" aria-label="Výber účtu">
        <label>Účet
          <select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
            {workspaces.map((workspace) => <option value={workspace.id} key={workspace.id}>{workspace.name}</option>)}
          </select>
        </label>
        <p className="muted">Prihlásený: {session.user.email}</p>
      </section>

      <PrivacyNoticeBanner />

      {error && <p className="notice error" role="alert">{error}</p>}
      {loading ? <p className="notice" aria-live="polite">Načítavam údaje…</p> : <>
        <section className="stats-grid" aria-label="Súhrn aktuálneho mesiaca">
          <article className="stat-card"><span>Príjmy tento mesiac</span><strong>{formatMoney(displaySummary.income, displaySummary.currency)}</strong></article>
          <article className="stat-card"><span>Výdavky tento mesiac</span><strong>{formatMoney(displaySummary.expenses, displaySummary.currency)}</strong></article>
          <article className="stat-card emphasis"><span>Bilancia</span><strong>{formatMoney(displaySummary.balance, displaySummary.currency)}</strong></article>
          <article className="stat-card"><span>Načítané bločky</span><strong>{receiptCount}</strong></article>
        </section>

        <section className="content-card" aria-labelledby="category-heading">
          <div className="section-heading"><h2 id="category-heading">Kategórie výdavkov</h2><span>tento mesiac</span></div>
          {displaySummary.categories.length ? <ul className="category-list">{displaySummary.categories.map((category) => <li key={category.name}><span>{category.name}</span><strong>{formatMoney(category.amount_minor, displaySummary.currency)}</strong></li>)}</ul> : <p className="empty">Zatiaľ nemáte žiadne výdavky za tento mesiac.</p>}
        </section>

        <section className="content-card" aria-labelledby="budget-heading">
          <div className="section-heading"><h2 id="budget-heading">Mesačné limity</h2><span>nastavené v Telegrame</span></div>
          {displayBudgets.length ? <ul className="category-list">{displayBudgets.map((budget) => <li key={budget.id}><span>{budget.category}<small>{formatMoney(budget.spent, budget.currency)} z {formatMoney(budget.amount, budget.currency)} · {budget.remaining >= 0 ? `ostáva ${formatMoney(budget.remaining, budget.currency)}` : `prekročené o ${formatMoney(Math.abs(budget.remaining), budget.currency)}`}</small></span><strong>{Math.min(999, Math.round((budget.spent / budget.amount) * 100))} %</strong></li>)}</ul> : <p className="empty">Mesačný limit nastavíte priamo v Telegrame, napríklad: „Nastav limit na Potraviny 300 €“.</p>}
        </section>

        <section className="content-card" aria-labelledby="transaction-heading">
          <div className="section-heading"><h2 id="transaction-heading">Posledné transakcie</h2><span>{transactions.length} zobrazených</span></div>
          {transactions.length ? <ul className="transaction-list">{transactions.map((transaction) => <li key={transaction.id}><div><strong>{transaction.merchant_name ?? transaction.note ?? 'Transakcia'}</strong><span>{new Intl.DateTimeFormat('sk-SK').format(new Date(transaction.occurred_at))} · {categoryName(transaction)}</span></div><b className={transaction.transaction_type === 'expense' ? 'expense' : 'income'}>{transaction.transaction_type === 'expense' ? '−' : '+'}{formatMoney(transaction.amount_minor, transaction.currency_code)}</b></li>)}</ul> : <p className="empty">Transakcie odoslané cez Telegram sa zobrazia tu.</p>}
        </section>

        <section className="content-card" aria-labelledby="receipt-heading">
          <div className="section-heading"><h2 id="receipt-heading">Posledné bločky</h2><span>{receiptCount} celkom</span></div>
          {receipts.length ? <ul className="receipt-list">{receipts.map((receipt) => <li key={receipt.id}><span>🧾</span><div><strong>{receipt.merchant_name ?? 'Bloček'}</strong><span>{receipt.receipt_date ?? 'Bez dátumu'}</span></div><b>{receipt.total_amount_minor === null ? '—' : formatMoney(receipt.total_amount_minor, receipt.currency_code ?? 'EUR')}</b></li>)}</ul> : <p className="empty">Pošlite fotku bločku do Telegram bota.</p>}
        </section>

        <section className="content-card telegram-card" aria-labelledby="telegram-heading">
          <div className="section-heading"><h2 id="telegram-heading">Prepojenie s Telegramom</h2><span className={telegramLinked ? 'badge success' : 'badge'}>{telegramLinked ? 'Prepojené' : 'Nepripojené'}</span></div>
          {telegramLinked ? <p className="empty">Váš Telegram bot už zapisuje výdavky do tohto prehľadu.</p> : <>
            <p>Vygenerujte jednorazový kód. V Telegram chate s botom potom odošlite <code>/link VÁŠ_KÓD</code>. Kód platí 15 minút.</p>
            {pairingCode ? <div className="pair-code"><strong>{pairingCode.code}</strong><span>Platí do {new Intl.DateTimeFormat('sk-SK', { hour: '2-digit', minute: '2-digit' }).format(new Date(pairingCode.expiresAt))}</span></div> : <button className="button primary" type="button" onClick={() => void createPairingCode()}>Vygenerovať párovací kód</button>}
          </>}
        </section>
        <PrivacyControls session={session} workspaces={workspaces} />
      </>}
    </main>
  );
}
