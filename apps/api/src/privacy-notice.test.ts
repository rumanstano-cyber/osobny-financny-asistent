import assert from 'node:assert/strict';
import test from 'node:test';
import type { supabase } from './supabase.js';

process.env.TELEGRAM_BOT_TOKEN ??= 'test-token';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role';
process.env.INTERNAL_CRON_SECRET ??= 'test-internal-cron-secret-32-chars';

const { deliverFirstUsePrivacyNotice } = await import('./privacy-notice.js');
type Client = typeof supabase;

function client(options: { linked?: boolean; acknowledged?: boolean } = {}) {
  let inserts = 0;
  let onboarding = 0;
  const fake = {
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        maybeSingle: async () => ({
          data: table === 'channel_accounts'
            ? (options.linked === false ? null : { user_id: 'user-1' })
            : (options.acknowledged ? { id: 'ack-1' } : null),
          error: null,
        }),
        insert: async () => { inserts += 1; return { error: null }; },
      };
      return chain;
    },
    rpc: async () => { onboarding += 1; return { data: [{ user_id: 'user-1' }], error: null }; },
  } as unknown as Client;
  return { fake, getInserts: () => inserts, getOnboarding: () => onboarding };
}

test('first Telegram use sends a short privacy link then stores a versioned record', async () => {
  const state = client();
  const messages: string[] = [];
  assert.equal(await deliverFirstUsePrivacyNotice('123', async (message) => { messages.push(message); }, state.fake), true);
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /\/privacy/u);
  assert.equal(state.getInserts(), 1);
});

test('already acknowledged notice is not sent again', async () => {
  const state = client({ acknowledged: true });
  assert.equal(await deliverFirstUsePrivacyNotice('123', async () => { throw new Error('unexpected send'); }, state.fake), false);
  assert.equal(state.getInserts(), 0);
});

test('first use creates the normal Telegram profile without a new onboarding path', async () => {
  const state = client({ linked: false });
  await deliverFirstUsePrivacyNotice('123', async () => undefined, state.fake);
  assert.equal(state.getOnboarding(), 1);
});

test('failed Telegram delivery is not recorded as acknowledged', async () => {
  const state = client();
  await assert.rejects(deliverFirstUsePrivacyNotice('123', async () => { throw new Error('unavailable'); }, state.fake));
  assert.equal(state.getInserts(), 0);
});
