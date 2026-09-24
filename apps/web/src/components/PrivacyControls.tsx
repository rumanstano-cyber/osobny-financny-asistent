import { useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { getSupabaseClient } from '../supabase';

type Preview = {
  active_warranty_documents: number;
  ownership_transfer_required_workspace_ids: string[];
  grace_days: number;
};
type Successor = { user_id: string; display_name: string };
type Workspace = { id: string; name: string };

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL?.trim() ||
  (import.meta.env.DEV ? 'http://localhost:3000' : 'https://osobny-financny-asistent-1.onrender.com'))
  .replace(/\/$/u, '');

export function PrivacyControls({ session, workspaces }: { session: Session; workspaces: Workspace[] }) {
  const supabase = getSupabaseClient();
  // These RPCs are introduced by the privacy migration and are not part of
  // the generated API types available to the web package at build time.
  const privacyRpc = supabase.rpc as unknown as (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
  const [preview, setPreview] = useState<Preview | null>(null);
  const [successors, setSuccessors] = useState<Record<string, Successor[]>>({});
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function loadPreview() {
    setBusy(true);
    setMessage('');
    try {
      const { data, error } = await privacyRpc('account_erasure_preview');
      if (error) throw error;
      const next = data as Preview;
      setPreview(next);
      const choices = await Promise.all(next.ownership_transfer_required_workspace_ids.map(async (workspaceId) => {
        const result = await privacyRpc('list_eligible_ownership_successors', { p_workspace_id: workspaceId });
        if (result.error) throw result.error;
        return [workspaceId, (result.data ?? []) as Successor[]] as const;
      }));
      setSuccessors(Object.fromEntries(choices));
    } catch {
      setMessage('Informácie o výmaze sa nepodarilo načítať. Skúste to neskôr.');
    } finally {
      setBusy(false);
    }
  }

  async function transfer(workspaceId: string) {
    const successorId = selected[workspaceId];
    if (!successorId) return;
    setBusy(true);
    setMessage('');
    try {
      const { error } = await privacyRpc('transfer_workspace_ownership_for_erasure', {
        p_workspace_id: workspaceId,
        p_successor_user_id: successorId,
      });
      if (error) throw error;
      setMessage('Vlastníctvo účtu bolo prevedené na zvoleného člena. Tento prevod sa pri zrušení žiadosti o výmaz automaticky nevráti.');
      await loadPreview();
    } catch {
      setMessage('Prevod vlastníctva sa nepodaril. Overte, že ide o aktívneho člena tohto účtu.');
    } finally {
      setBusy(false);
    }
  }

  async function downloadExport() {
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(`${apiBaseUrl}/api/privacy/export`, {
        headers: { authorization: `Bearer ${session.access_token}` },
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('Export unavailable');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'osobny-financny-asistent-export.zip';
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setMessage('Export je pripravený na stiahnutie. Súbor si bezpečne uložte.');
    } catch {
      setMessage('Export sa nepodarilo pripraviť. Skúste to neskôr.');
    } finally {
      setBusy(false);
    }
  }

  async function confirmErasure() {
    setBusy(true);
    setMessage('');
    try {
      const { error } = await privacyRpc('confirm_account_erasure', { p_confirmation: 'VYMAZAŤ ÚČET' });
      if (error) throw error;
      setMessage('Žiadosť bola potvrdená. Účet je teraz zablokovaný; výmaz sa dokončí po 30 dňoch. Počas tejto lehoty je možné žiadosť zrušiť.');
      setConfirming(false);
      await supabase.auth.signOut();
    } catch {
      setMessage('Žiadosť sa nepodarilo potvrdiť. Skontrolujte prevod vlastníctva zdieľaných účtov.');
    } finally {
      setBusy(false);
    }
  }

  return <section className="content-card" aria-labelledby="privacy-heading">
    <div className="section-heading"><h2 id="privacy-heading">Vaše údaje</h2></div>
    <p>Údaje si môžete stiahnuť alebo požiadať o výmaz účtu. Pred výmazom odporúčame najprv stiahnuť export.</p>
    <div className="privacy-actions">
      <button className="button secondary" type="button" disabled={busy} onClick={() => void downloadExport()}>Stiahnuť moje údaje</button>
      <button className="button secondary" type="button" disabled={busy} onClick={() => void loadPreview()}>Vymazať účet a moje údaje</button>
    </div>
    {preview && <div className="privacy-preview">
      <p>Aktívne sledované doklady: <strong>{preview.active_warranty_documents}</strong>. Po definitívnom výmaze sa odstránia ich fotografie a prestanú upozornenia.</p>
      <p>Po potvrdení sa účet ihneď zablokuje. Nasleduje {preview.grace_days}-dňová lehota na zrušenie žiadosti; údaje sa počas nej fyzicky nemažú.</p>
      {preview.ownership_transfer_required_workspace_ids.map((workspaceId) => <div key={workspaceId}>
        <p>Pred výmazom účtu vyberte nového vlastníka zdieľaného účtu <strong>{workspaces.find((workspace) => workspace.id === workspaceId)?.name ?? 'Zdieľaný účet'}</strong>.</p>
        <label>Nový vlastník
          <select value={selected[workspaceId] ?? ''} onChange={(event) => setSelected({ ...selected, [workspaceId]: event.target.value })}>
            <option value="">Vyberte aktívneho člena</option>
            {(successors[workspaceId] ?? []).map((candidate) => <option key={candidate.user_id} value={candidate.user_id}>{candidate.display_name} · {candidate.user_id.slice(0, 8)}</option>)}
          </select>
        </label>
        <button className="button secondary" type="button" disabled={busy || !selected[workspaceId]} onClick={() => void transfer(workspaceId)}>Výslovne previesť vlastníctvo</button>
      </div>)}
      {preview.ownership_transfer_required_workspace_ids.length === 0 && !confirming &&
        <button className="button secondary" type="button" disabled={busy} onClick={() => setConfirming(true)}>Pokračovať k potvrdeniu výmazu</button>}
      {confirming && <div role="group" aria-label="Potvrdenie výmazu">
        <p>Potvrdením požiadate o výmaz účtu a údajov po 30 dňoch. Tento krok nie je možné vykonať za iného člena.</p>
        <button className="button secondary" type="button" disabled={busy} onClick={() => void confirmErasure()}>Potvrdzujem výmaz môjho účtu</button>
        <button className="button secondary" type="button" disabled={busy} onClick={() => setConfirming(false)}>Späť</button>
      </div>}
    </div>}
    {message && <p className="notice" role="status">{message}</p>}
  </section>;
}
