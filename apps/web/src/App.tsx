import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { AuthPage } from './components/AuthPage';
import { Dashboard } from './components/Dashboard';
import { LandingPage } from './components/LandingPage';
import { PendingDeletionPage } from './components/PendingDeletionPage';
import { PrivacyInformationPage } from './components/PrivacyInformationPage';
import { getSupabaseClient, isSupabaseConfigured } from './supabase';

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [path, setPath] = useState(() => window.location.pathname);
  const [deletionState, setDeletionState] = useState<{ graceEndsAt: string; canCancel: boolean } | null | undefined>(undefined);

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setLoading(false);
      return;
    }

    const supabase = getSupabaseClient();
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setLoading(false);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    const syncPath = () => setPath(window.location.pathname);
    window.addEventListener('popstate', syncPath);
    return () => window.removeEventListener('popstate', syncPath);
  }, []);

  useEffect(() => {
    if (!session) {
      setDeletionState(null);
      return;
    }
    let cancelled = false;
    setDeletionState(undefined);
    void getSupabaseClient().rpc('get_my_account_erasure_state').then(({ data, error }) => {
      if (cancelled) return;
      if (error) {
        setDeletionState(undefined);
        return;
      }
      const row = Array.isArray(data) ? data[0] as { grace_ends_at?: string; can_cancel?: boolean } | undefined : undefined;
      setDeletionState(row?.grace_ends_at ? { graceEndsAt: row.grace_ends_at, canCancel: row.can_cancel === true } : null);
    });
    return () => { cancelled = true; };
  }, [session]);

  useEffect(() => {
    const protectedPath = '/dashboard';
    const nextPath = session
      ? protectedPath
      : path === protectedPath
        ? '/login'
        : path;
    if (nextPath !== path) {
      window.history.replaceState({}, '', nextPath);
      setPath(nextPath);
    }
  }, [path, session]);

  if (loading) {
    return <main className="page-center" aria-live="polite"><p>Načítavam bezpečnú reláciu…</p></main>;
  }

  if (path === '/privacy') return <PrivacyInformationPage />;

  if (session && deletionState === undefined) return <main className="page-center" aria-live="polite"><p>Overujem stav účtu…</p></main>;
  if (session && deletionState) return <PendingDeletionPage graceEndsAt={deletionState.graceEndsAt} canCancel={deletionState.canCancel} onCancelled={() => setDeletionState(null)} />;
  if (session) return <Dashboard session={session} />;
  if (path === '/login' || path === '/register') return <AuthPage initialMode={path === '/register' ? 'sign-up' : 'sign-in'} />;
  return <LandingPage />;
}
