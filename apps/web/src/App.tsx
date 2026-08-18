import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { AuthPage } from './components/AuthPage';
import { Dashboard } from './components/Dashboard';
import { LandingPage } from './components/LandingPage';
import { getSupabaseClient, isSupabaseConfigured } from './supabase';

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [path, setPath] = useState(() => window.location.pathname);

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

  if (session) return <Dashboard session={session} />;
  if (path === '/login' || path === '/register') return <AuthPage initialMode={path === '/register' ? 'sign-up' : 'sign-in'} />;
  return <LandingPage />;
}
