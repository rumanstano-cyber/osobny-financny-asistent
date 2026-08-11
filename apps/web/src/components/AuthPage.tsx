import { useState } from 'react';
import type { FormEvent } from 'react';
import { supabase } from '../supabase';

type Mode = 'sign-in' | 'sign-up';

export function AuthPage() {
  const [mode, setMode] = useState<Mode>('sign-in');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage('');
    setBusy(true);
    try {
      if (mode === 'sign-up') {
        if (password.length < 8) throw new Error('Heslo musí mať aspoň 8 znakov.');
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { full_name: fullName.trim() }, emailRedirectTo: `${window.location.origin}/` },
        });
        if (error) throw error;
        setMessage(data.session ? 'Účet je vytvorený.' : 'Skontroluj e-mail a potvrď registráciu.');
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Prihlásenie sa nepodarilo.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-card" aria-labelledby="auth-heading">
        <span className="eyebrow">Osobný finančný asistent</span>
        <h1 id="auth-heading">Majte financie pod kontrolou.</h1>
        <p className="muted">Výdavky z Telegramu, bločky a mesačné prehľady na jednom mieste.</p>
        <div className="tab-list" role="tablist" aria-label="Typ prístupu">
          <button className={mode === 'sign-in' ? 'tab active' : 'tab'} type="button" onClick={() => setMode('sign-in')} role="tab" aria-selected={mode === 'sign-in'}>Prihlásenie</button>
          <button className={mode === 'sign-up' ? 'tab active' : 'tab'} type="button" onClick={() => setMode('sign-up')} role="tab" aria-selected={mode === 'sign-up'}>Registrácia</button>
        </div>
        <form className="stack" onSubmit={submit}>
          {mode === 'sign-up' && <label>Meno<input autoComplete="name" value={fullName} onChange={(event) => setFullName(event.target.value)} placeholder="Vaše meno" /></label>}
          <label>E-mail<input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="meno@example.com" /></label>
          <label>Heslo<input required type="password" minLength={8} autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Aspoň 8 znakov" /></label>
          <button className="button primary" disabled={busy} type="submit">{busy ? 'Spracúvam…' : mode === 'sign-in' ? 'Prihlásiť sa' : 'Vytvoriť účet'}</button>
          {message && <p className="form-message" role="status">{message}</p>}
        </form>
      </section>
    </main>
  );
}
