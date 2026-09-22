import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../../supabase/migrations/20260922115357_enforce_verified_email_identity.sql',
  import.meta.url,
);

async function migrationSource() {
  return readFile(migrationUrl, 'utf8');
}

test('web identity resolution requires the authoritative Auth email confirmation', async () => {
  const migration = await migrationSource();

  assert.match(migration, /join auth\.users auth_user on auth_user\.id = u\.auth_user_id/u);
  assert.match(migration, /u\.auth_user_id = auth\.uid\(\)/u);
  assert.match(migration, /auth_user\.email_confirmed_at is not null/u);
  assert.match(migration, /u\.status = 'active'/u);
  assert.match(migration, /u\.deleted_at is null/u);
});

test('verified-email enforcement remains a safe least-privilege SECURITY DEFINER helper', async () => {
  const migration = await migrationSource();

  assert.match(migration, /security definer[\s\S]*set search_path = ''/u);
  assert.match(
    migration,
    /revoke all on function public\.current_ofa_user_id\(\) from public, anon, service_role/u,
  );
  assert.match(
    migration,
    /grant execute on function public\.current_ofa_user_id\(\) to authenticated/u,
  );
  assert.doesNotMatch(migration, /\b(?:insert|update|delete|truncate)\b/iu);
});

test('central helper continues to protect dashboard RLS and Telegram link-code minting', async () => {
  const [linkingMigration, dashboardMigration, rlsMigration] = await Promise.all([
    readFile(
      new URL('../../../supabase/migrations/20260919160048_harden_telegram_account_linking.sql', import.meta.url),
      'utf8',
    ),
    readFile(
      new URL('../../../supabase/migrations/20260906220000_add_workspace_dashboard_summary.sql', import.meta.url),
      'utf8',
    ),
    readFile(
      new URL('../../../supabase/migrations/20260811184000_add_web_auth_and_dashboard_rls.sql', import.meta.url),
      'utf8',
    ),
  ]);

  assert.match(linkingMigration, /v_user_id uuid := public\.current_ofa_user_id\(\)/u);
  assert.match(linkingMigration, /wm\.user_id = public\.current_ofa_user_id\(\)/u);
  assert.match(dashboardMigration, /security invoker/u);
  assert.match(rlsMigration, /members can view transactions[\s\S]*is_current_user_workspace_member\(workspace_id\)/u);
  assert.match(rlsMigration, /members can view receipts[\s\S]*is_current_user_workspace_member\(workspace_id\)/u);
});
