import { config } from './config.js';
import { supabase } from './supabase.js';

const version = '2026-09-draft-1';
type PrivacyClient = typeof supabase;

/** First-use information, not a legal-consent gate or another onboarding step. */
export async function deliverFirstUsePrivacyNotice(
  telegramUserId: string,
  send: (message: string) => Promise<unknown>,
  client: PrivacyClient = supabase,
): Promise<boolean> {
  const { data: account, error: accountError } = await client.from('channel_accounts')
    .select('user_id').eq('channel', 'telegram').eq('external_account_id', telegramUserId)
    .is('unlinked_at', null).maybeSingle();
  if (accountError) throw new Error(accountError.message);

  let userId = account?.user_id as string | undefined;
  if (!userId) {
    const { data, error } = await client.rpc('ensure_telegram_email_profile', {
      p_telegram_user_id: telegramUserId,
      p_display_name: '',
    });
    if (error) throw new Error(error.message);
    userId = (data as Array<{ user_id: string }> | null)?.[0]?.user_id;
  }
  if (!userId) throw new Error('Privacy notice user could not be identified');

  const { data: acknowledgement, error: lookupError } = await client.from('user_consents')
    .select('id').eq('user_id', userId).eq('consent_type', 'privacy_notice_ack')
    .eq('policy_version', version).eq('granted', true).is('withdrawn_at', null).maybeSingle();
  if (lookupError) throw new Error(lookupError.message);
  if (acknowledgement) return false;

  await send(`Na fungovanie asistenta spracúvame údaje o účte, zápisoch a dokladoch. Informácie o ochrane údajov: ${config.WEB_APP_URL}/privacy`);
  const { error: insertError } = await client.from('user_consents').insert({
    user_id: userId,
    consent_type: 'privacy_notice_ack',
    policy_version: version,
    granted: true,
    evidence: { channel: 'telegram' },
  });
  if (insertError && insertError.code !== '23505') throw new Error(insertError.message);
  return true;
}
