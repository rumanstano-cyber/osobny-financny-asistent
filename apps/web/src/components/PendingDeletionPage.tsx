import { useState } from 'react';
import { getSupabaseClient } from '../supabase';

export function PendingDeletionPage({ graceEndsAt, canCancel, onCancelled }: { graceEndsAt: string; canCancel: boolean; onCancelled: () => void }) {
  const supabase = getSupabaseClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function cancel() {
    setBusy(true);
    setError('');
    try {
      const { data, error: cancelError } = await supabase.rpc('cancel_account_erasure');
      if (cancelError || data !== true) throw cancelError ?? new Error('Grace period expired');
      onCancelled();
    } catch {
      setError('Žiadosť sa nepodarilo zrušiť. Skúste to neskôr alebo kontaktujte podporu.');
    } finally {
      setBusy(false);
    }
  }

  return <main className="page-center">
    <section className="content-card" aria-labelledby="deletion-heading">
      <h1 id="deletion-heading">Výmaz účtu je naplánovaný</h1>
      <p>Účet je zablokovaný. Údaje zostanú dostupné na obnovenie do {new Intl.DateTimeFormat('sk-SK', { dateStyle: 'long' }).format(new Date(graceEndsAt))}.</p>
      <p>Ak si to rozmyslíte, žiadosť môžete počas tejto lehoty zrušiť. Už uskutočnený prevod vlastníctva zdieľaného účtu sa tým automaticky nevráti.</p>
      {canCancel ? <button className="button primary" type="button" disabled={busy} onClick={() => void cancel()}>Zrušiť žiadosť o výmaz</button>
        : <p>Lehota na zrušenie uplynula. Výmaz sa dokončuje.</p>}
      <button className="button secondary" type="button" onClick={() => void supabase.auth.signOut()}>Odhlásiť</button>
      {error && <p className="notice error" role="alert">{error}</p>}
    </section>
  </main>;
}
