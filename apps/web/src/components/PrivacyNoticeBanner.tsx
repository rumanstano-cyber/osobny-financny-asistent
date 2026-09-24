import { useEffect, useState } from 'react';
import { getSupabaseClient } from '../supabase';

const version = '2026-09-draft-1';
type PrivacyRpc = (name: string, args: { p_version: string }) => Promise<{
  data: boolean | null;
  error: { message: string } | null;
}>;

export function PrivacyNoticeBanner() {
  const [acknowledged, setAcknowledged] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const rpc = getSupabaseClient().rpc as unknown as PrivacyRpc;

  useEffect(() => {
    let cancelled = false;
    void rpc('has_my_privacy_notice_ack', { p_version: version }).then((result) => {
      if (!cancelled) setAcknowledged(result.error ? false : result.data === true);
    });
    return () => { cancelled = true; };
  }, []);

  async function acknowledge() {
    setError('');
    const result = await rpc('acknowledge_my_privacy_notice', { p_version: version });
    if (result.error || result.data !== true) {
      setError('Oboznámenie sa nepodarilo zaznamenať. Skúste to neskôr.');
      return;
    }
    setAcknowledged(true);
  }

  if (acknowledged !== false) return null;
  return <section className="content-card" aria-label="Informácie o ochrane údajov">
    <p>Na prevádzku asistenta používame údaje o účte, zápisoch a dokladoch. <a href="/privacy">Prečítajte si informácie o ochrane údajov.</a></p>
    <button className="button secondary" type="button" onClick={() => void acknowledge()}>Rozumiem</button>
    {error && <p className="notice error" role="alert">{error}</p>}
  </section>;
}
