import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { supabase } from './supabase.js';

process.env.TELEGRAM_BOT_TOKEN ??= 'test-token';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role';
process.env.INTERNAL_CRON_SECRET ??= 'test-internal-cron-secret-32-chars';

const {
  acknowledgeTelegramPrivacyNotice,
  passTelegramPrivacyGate,
  TELEGRAM_PRIVACY_CONTINUE_CALLBACK,
  TELEGRAM_PRIVACY_NOTICE_VERSION,
  telegramPrivacyGateState,
  telegramPrivacyNoticeText,
} = await import('./privacy-notice.js');
type Client = typeof supabase;
const active = { state: 'active' as const, userId: 'user-1' };

function client(options: { legacy?: boolean; acknowledged?: boolean; conflict?: boolean } = {}) {
  let acknowledged = options.acknowledged ?? false;
  let inserts = 0;
  let onboarding = 0;
  const records: Array<Record<string, unknown>> = [];
  const lookups: Array<Record<string, unknown>> = [];
  const fake = {
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const chain = {
        select: () => chain,
        eq: (key: string, value: unknown) => { filters[key] = value; return chain; },
        is: () => chain,
        maybeSingle: async () => {
          lookups.push({ table, ...filters });
          return { data: table === 'ofa_users'
            ? { telegram_privacy_notice_required: !options.legacy }
            : acknowledged ? { id: 'ack-1' } : null, error: null };
        },
        insert: async (record: Record<string, unknown>) => {
          inserts += 1;
          records.push(record);
          if (options.conflict) {
            acknowledged = true;
            return { error: { code: '23505', message: 'duplicate' } };
          }
          acknowledged = true;
          return { error: null };
        },
      };
      return chain;
    },
    rpc: async () => { onboarding += 1; return { data: [{ user_id: 'user-1' }], error: null }; },
  } as unknown as Client;
  return { fake, records, lookups, getInserts: () => inserts, getOnboarding: () => onboarding };
}

test('new Telegram user sees the current notice URL and Continue action before financial use', async () => {
  const state = client();
  const notice = telegramPrivacyNoticeText();
  assert.match(notice, /\/privacy/u);
  assert.match(notice, /ochrane osobných údajov/u);
  assert.doesNotMatch(notice, /Súhlasím/u);
  assert.equal(TELEGRAM_PRIVACY_CONTINUE_CALLBACK, 'privacy:continue');
  assert.deepEqual(await telegramPrivacyGateState('123', { state: 'new', userId: null }, state.fake), {
    userId: 'user-1', required: true,
  });
  assert.equal(state.getOnboarding(), 1);
  assert.equal(state.getInserts(), 0);
});

test('pending gate blocks expense, receipt, voice, loan and financial callbacks before their handlers', async () => {
  const state = client();
  for (const kind of ['expense', 'income', 'receipt', 'voice', 'loan', 'category', 'void', 'report']) {
    let notices = 0;
    let financialWrites = 0;
    const allowed = await passTelegramPrivacyGate('123', active,
      async () => { notices += 1; },
      async () => { financialWrites += 1; }, state.fake);
    assert.equal(allowed, false, kind);
    assert.equal(notices, 1, kind);
    assert.equal(financialWrites, 0, kind);
  }
  assert.equal(state.getInserts(), 0);
});

test('Continue stores one versioned Telegram acknowledgement and permits only later messages', async () => {
  const state = client();
  const blockedMessage = async () => { throw new Error('earlier message was replayed'); };
  assert.equal(await passTelegramPrivacyGate('123', active, async () => undefined, blockedMessage, state.fake), false);
  assert.equal(await acknowledgeTelegramPrivacyNotice('123', active, state.fake), true);
  assert.deepEqual(state.records[0], {
    user_id: 'user-1', consent_type: 'telegram_privacy_notice_ack',
    policy_version: TELEGRAM_PRIVACY_NOTICE_VERSION, granted: true,
    evidence: { channel: 'telegram', action: 'continue' },
  });
  let laterWrites = 0;
  assert.equal(await passTelegramPrivacyGate('123', active,
    async () => { throw new Error('notice was repeated'); },
    async () => { laterWrites += 1; }, state.fake), true);
  assert.equal(laterWrites, 1);
  assert.equal(state.getInserts(), 1);
});

test('repeated Continue is idempotent, including a concurrent unique-key conflict', async () => {
  const state = client();
  assert.equal(await acknowledgeTelegramPrivacyNotice('123', active, state.fake), true);
  assert.equal(await acknowledgeTelegramPrivacyNotice('123', active, state.fake), false);
  assert.equal(state.getInserts(), 1);
  const concurrent = client({ conflict: true });
  assert.equal(await acknowledgeTelegramPrivacyNotice('123', active, concurrent.fake), false);
  assert.equal(concurrent.getInserts(), 1);
});

test('existing users remain eligible without a fabricated acknowledgement', async () => {
  const state = client({ legacy: true });
  let financialWrites = 0;
  assert.equal(await passTelegramPrivacyGate('123', active,
    async () => { throw new Error('legacy user was prompted'); },
    async () => { financialWrites += 1; }, state.fake), true);
  assert.equal(financialWrites, 1);
  assert.equal(await acknowledgeTelegramPrivacyNotice('123', active, state.fake), false);
  assert.equal(state.getInserts(), 0);
});

test('web acknowledgement alone does not activate a new Telegram account', async () => {
  const state = client();
  assert.equal((await telegramPrivacyGateState('123', active, state.fake)).required, true);
  assert.ok(state.lookups.some((lookup) => lookup.table === 'user_consents'
    && lookup.consent_type === 'telegram_privacy_notice_ack'
    && lookup.user_id === 'user-1'));
});

test('revoked or unknown callback principal cannot activate another account', async () => {
  const state = client();
  await assert.rejects(acknowledgeTelegramPrivacyNotice('123', { state: 'revoked', userId: 'other-user' }, state.fake));
  await assert.rejects(acknowledgeTelegramPrivacyNotice('123', { state: 'new', userId: null }, state.fake));
  assert.equal(state.getInserts(), 0);
  const telegram = readFileSync(new URL('./telegram.ts', import.meta.url), 'utf8');
  assert.match(telegram, /const telegramUserId = String\(ctx\.from\.id\);\s*const principal = await assertTelegramPrincipalAccess\(telegramUserId\);\s*const recorded = await acknowledgeTelegramPrivacyNotice\(telegramUserId, principal\)/u);
});

test('onboarding gate runs before all Telegram commands, callbacks and message parsing', () => {
  const telegram = readFileSync(new URL('./telegram.ts', import.meta.url), 'utf8');
  const gate = telegram.indexOf('await passTelegramPrivacyGate(');
  assert.ok(gate > telegram.indexOf('await enforceCostProtection(\'telegram_update\''));
  assert.ok(gate < telegram.indexOf("bot.command('start'"));
  assert.ok(gate < telegram.indexOf('bot.callbackQuery('));
  assert.ok(gate < telegram.indexOf("bot.on('message'"));
  assert.match(telegram, /ctx\.callbackQuery\?\.data !== TELEGRAM_PRIVACY_CONTINUE_CALLBACK/u);
  assert.match(telegram, /reply_markup: new InlineKeyboard\(\)\.text\('Pokračovať', TELEGRAM_PRIVACY_CONTINUE_CALLBACK\)/u);
});
