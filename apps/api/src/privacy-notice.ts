import { AccessRevokedError, type TelegramPrincipalAccess } from './access-control.js';
import { config } from './config.js';
import { supabase } from './supabase.js';

export const TELEGRAM_PRIVACY_NOTICE_VERSION = '2026-09-draft-1';
export const TELEGRAM_PRIVACY_CONTINUE_CALLBACK = 'privacy:continue';
export const TELEGRAM_PRIVACY_PROMPT = 'Pred používaním asistenta si prosím pozrite informácie o ochrane osobných údajov a pokračujte tlačidlom nižšie.';
type PrivacyClient = typeof supabase;
type Principal = Pick<TelegramPrincipalAccess, 'state' | 'userId'>;

export function telegramPrivacyNoticeText(): string {
  return `Na fungovanie asistenta spracúvame údaje o účte, finančných zápisoch a dokladoch. Informácie o ochrane osobných údajov: ${config.WEB_APP_URL}/privacy\n\n${TELEGRAM_PRIVACY_PROMPT}`;
}

export async function telegramPrivacyGateState(
  telegramUserId: string,
  principal: Principal,
  client: PrivacyClient = supabase,
): Promise<{ userId: string; required: boolean }> {
  if (principal.state === 'revoked') throw new AccessRevokedError();
  let userId = principal.userId;
  if (principal.state === 'new') {
    const { data, error } = await client.rpc('ensure_telegram_email_profile', {
      p_telegram_user_id: telegramUserId,
      p_display_name: '',
    });
    if (error) throw new Error(error.message);
    userId = (data as Array<{ user_id: string }> | null)?.[0]?.user_id ?? null;
  }
  if (!userId) throw new AccessRevokedError();

  const { data: user, error: userError } = await client.from('ofa_users')
    .select('telegram_privacy_notice_required').eq('id', userId)
    .eq('status', 'active').is('deleted_at', null).maybeSingle();
  if (userError) throw new Error(userError.message);
  if (!user) throw new AccessRevokedError();
  if (user.telegram_privacy_notice_required !== true) return { userId, required: false };

  const { data: acknowledgement, error: lookupError } = await client.from('user_consents')
    .select('id').eq('user_id', userId).eq('consent_type', 'telegram_privacy_notice_ack')
    .eq('policy_version', TELEGRAM_PRIVACY_NOTICE_VERSION)
    .eq('granted', true).is('withdrawn_at', null).maybeSingle();
  if (lookupError) throw new Error(lookupError.message);
  return { userId, required: !acknowledgement };
}

export async function passTelegramPrivacyGate(
  telegramUserId: string,
  principal: Principal,
  showNotice: () => Promise<unknown>,
  next: () => Promise<unknown>,
  client: PrivacyClient = supabase,
): Promise<boolean> {
  const state = await telegramPrivacyGateState(telegramUserId, principal, client);
  if (state.required) {
    await showNotice();
    return false;
  }
  await next();
  return true;
}

/** Called only after the Telegram callback principal was resolved as active. */
export async function acknowledgeTelegramPrivacyNotice(
  telegramUserId: string,
  principal: Principal,
  client: PrivacyClient = supabase,
): Promise<boolean> {
  if (principal.state !== 'active') throw new AccessRevokedError();
  const state = await telegramPrivacyGateState(telegramUserId, principal, client);
  if (!state.required) return false;

  const { error } = await client.from('user_consents').insert({
    user_id: state.userId,
    consent_type: 'telegram_privacy_notice_ack',
    policy_version: TELEGRAM_PRIVACY_NOTICE_VERSION,
    granted: true,
    evidence: { channel: 'telegram', action: 'continue' },
  });
  if (!error) return true;
  if (error.code !== '23505') throw new Error(error.message);
  if ((await telegramPrivacyGateState(telegramUserId, principal, client)).required) {
    throw new Error('Privacy acknowledgement conflict did not produce an active record');
  }
  return false;
}
