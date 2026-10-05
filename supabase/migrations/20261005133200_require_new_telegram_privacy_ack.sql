-- Existing accounts are exempt from this new Telegram onboarding gate. This is
-- not an acknowledgement or consent record. Accounts inserted after the
-- migration must actively continue before using Telegram financial features.
alter table public.ofa_users
  add column telegram_privacy_notice_required boolean not null default false;
alter table public.ofa_users
  alter column telegram_privacy_notice_required set default true;

create unique index user_consents_telegram_privacy_notice_version_key
  on public.user_consents (user_id, consent_type, policy_version)
  where consent_type = 'telegram_privacy_notice_ack';
