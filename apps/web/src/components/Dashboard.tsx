import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../supabase';

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

function formatMoney(amountMinor: number, currency = 'EUR') {
  return new Intl.NumberFormat('sk-SK', { style: 'currency', currency }).format(amountMinor / 100);
}

function currentMonthStart() {
  const date = new Date();
  return new Date(date.getFullYear(), date.getMonth(), 1).toISOString();
}

function categoryName(transaction: Transaction) {
  return transaction.transaction_category_assignments?.[0]?.categories?.name ?? 'Ostatné';
}

export function Dashboard({ session }: { session: Session }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [receiptCount, setReceiptCount] = useState(0);
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
        setReceiptCount(0);
        return;
      }

      const [transactionResult, receiptResult] = await Promise.all([
        supabase
          .from('financial_transactions')
          .select('id, transaction_type, amount_minor, currency_code, occurred_at, merchant_name, note, transaction_category_assignments!left(categories!inner(name))')
          .eq('workspace_id', selectedWorkspaceId)
          .gte('occurred_at', currentMonthStart())
          .eq('status', 'confirmed')
          .order('occurred_at', { ascending: false })
          .limit(12),
        supabase
          .from('ofa_receipts')
          .select('id, merchant_name, receipt_date, total_amount_minor, currency_code', { count: 'exact' })
          .eq('workspace_id', selectedWorkspaceId)
          .order('created_at', { ascending: false })
          .limit(4),
      ]);
      if (transactionResult.error) throw transactionResult.error;
      if (receiptResult.error) throw receiptResult.error;
      setTransactions((transactionResult.data ?? []) as unknown as Transaction[]);
      setReceipts((receiptResult.data ?? []) as Receipt[]);
      setReceiptCount(receiptResult.count ?? 0);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Dáta sa nepodarilo načítať.');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { void loadDashboard(); }, [loadDashboard]);

  const summary = useMemo(() => {
    const income = transactions.filter((item) => item.transaction_type === 'income').reduce((sum, item) => sum + item.amount_minor, 0);
    const expenses = transactions.filter((item) => item.transaction_type === 'expense').reduce((sum, item) => sum + item.amount_minor, 0);
    const currency = workspaces.find((item) => item.id === workspaceId)?.base_currency_code ?? 'EUR';
    const categories = new Map<string, number>();
    for (const transaction of transactions.filter((item) => item.transaction_type === 'expense')) {
      const name = categoryName(transaction);
      categories.set(name, (categories.get(name) ?? 0) + transaction.amount_minor);
    }
    return { income, expenses, currency, categories: [...categories.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5) };
  }, [transactions, workspaceId, workspaces]);

  async function createPairingCode() {
    setError('');
    const { data, error: pairingError } = await supabase.rpc('create_telegram_link_code');
    if (pairingError) { setError(pairingError.message); return; }
    const value = Array.isArray(data) ? data[0] : null;
    if (!value?.code || !value.expires_at) { setError('Párovací kód sa nepodarilo vytvoriť.'); return; }
    setPairingCode({ code: value.code as string, expiresAt: value.expires_at as string });
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

      {error && <p className="notice error" role="alert">{error}</p>}
      {loading ? <p className="notice" aria-live="polite">Načítavam údaje…</p> : <>
        <section className="stats-grid" aria-label="Súhrn aktuálneho mesiaca">
          <article className="stat-card"><span>Príjmy tento mesiac</span><strong>{formatMoney(summary.income, summary.currency)}</strong></article>
          <article className="stat-card"><span>Výdavky tento mesiac</span><strong>{formatMoney(summary.expenses, summary.currency)}</strong></article>
          <article className="stat-card emphasis"><span>Bilancia</span><strong>{formatMoney(summary.income - summary.expenses, summary.currency)}</strong></article>
          <article className="stat-card"><span>Načítané bločky</span><strong>{receiptCount}</strong></article>
        </section>

        <section className="content-card" aria-labelledby="category-heading">
          <div className="section-heading"><h2 id="category-heading">Kategórie výdavkov</h2><span>tento mesiac</span></div>
          {summary.categories.length ? <ul className="category-list">{summary.categories.map(([name, total]) => <li key={name}><span>{name}</span><strong>{formatMoney(total, summary.currency)}</strong></li>)}</ul> : <p className="empty">Zatiaľ nemáte žiadne výdavky za tento mesiac.</p>}
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
      </>}
    </main>
  );
}
