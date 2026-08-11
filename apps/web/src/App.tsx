import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { AuthPage } from './components/AuthPage';
import { Dashboard } from './components/Dashboard';
import { supabase } from './supabase';

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
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
    const protectedPath = '/dashboard';
    if (session && window.location.pathname !== protectedPath) {
      window.history.replaceState({}, '', protectedPath);
    }
    if (!session && window.location.pathname !== '/') {
      window.history.replaceState({}, '', '/');
    }
  }, [session]);

  if (loading) {
    return <main className="page-center" aria-live="polite"><p>Načítavam bezpečnú reláciu…</p></main>;
  }

  return session ? <Dashboard session={session} /> : <AuthPage />;
}
