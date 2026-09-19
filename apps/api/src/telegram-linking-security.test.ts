import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../../supabase/migrations/20260919160048_harden_telegram_account_linking.sql',
  import.meta.url,
);
const grantsMigrationUrl = new URL(
  '../../../supabase/migrations/20260919194918_tighten_telegram_link_rpc_grants.sql',
  import.meta.url,
);

async function sources() {
  const [migration, telegram] = await Promise.all([
    readFile(migrationUrl, 'utf8'),
    readFile(new URL('./telegram.ts', import.meta.url), 'utf8'),
  ]);
  return { migration, telegram };
}

test('link codes use 128-bit randomness, a digest, a short TTL and safe search paths', async () => {
  const { migration } = await sources();
  assert.match(migration, /extensions\.gen_random_bytes\(16\)/u);
  assert.match(migration, /extensions\.digest\(v_code, 'sha256'\)/u);
  assert.match(migration, /interval '15 minutes'/u);
  assert.match(migration, /\^\[0-9A-Fa-f\]\{32\}\$/u);
  assert.doesNotMatch(migration, /gen_random_bytes\(5\)/u);
  assert.equal((migration.match(/set search_path = ''/gu) ?? []).length, 4);
});

test('invalid, expired and used codes fail before any account mutation', async () => {
  const { migration } = await sources();
  const lockedCode = migration.indexOf('from public.telegram_link_codes link');
  const invalidGuard = migration.indexOf('if v_link.id is null then');
  const firstAccountInsert = migration.indexOf('insert into public.ofa_users', lockedCode);
  assert.ok(lockedCode >= 0 && invalidGuard > lockedCode && firstAccountInsert > invalidGuard);
  assert.match(migration, /link\.consumed_at is null[\s\S]*link\.expires_at > pg_catalog\.clock_timestamp\(\)[\s\S]*for update/u);
});

test('single-use and concurrent replay protection are enforced atomically', async () => {
  const { migration } = await sources();
  assert.match(migration, /from public\.telegram_link_codes link[\s\S]*for update/u);
  assert.match(migration, /update public\.telegram_link_codes link[\s\S]*link\.consumed_at is null[\s\S]*link\.expires_at > pg_catalog\.clock_timestamp\(\)/u);
  assert.match(migration, /get diagnostics v_affected = row_count[\s\S]*if v_affected <> 1/u);
  assert.match(migration, /from public\.ofa_users u[\s\S]*for update[\s\S]*update public\.telegram_link_codes/u);
});

test('account takeover and duplicate Telegram identity paths fail closed', async () => {
  const { migration } = await sources();
  assert.match(migration, /ca\.external_account_id <> p_telegram_user_id/u);
  assert.match(migration, /v_telegram_auth_user_id is not null and v_telegram_auth_user_id <> v_web_auth_user_id/u);
  assert.match(migration, /unique constraint on \(channel, external_account_id\)/u);
  assert.match(migration, /where ca\.channel = 'telegram'[\s\S]*ca\.external_account_id = p_telegram_user_id[\s\S]*for update/u);
});

test('revoked users, memberships and deleted workspaces cannot link or relink', async () => {
  const { migration } = await sources();
  assert.match(migration, /u\.status = 'active'[\s\S]*u\.deleted_at is null/u);
  assert.match(migration, /wm\.status = 'active'[\s\S]*wm\.removed_at is null[\s\S]*w\.deleted_at is null/u);
  assert.match(migration, /An unlink is not an account reset/u);
});

test('unlink and relink reuse the historical identity only after fresh authorization', async () => {
  const { migration } = await sources();
  assert.match(migration, /Include historical rows so a legitimate relink reuses the same identity/u);
  assert.match(migration, /set unlinked_at = null/u);
  assert.match(migration, /telegram_account_relinked/u);
  assert.match(migration, /link\.consumed_at is null/u);
});

test('Telegram identity comes only from ctx.from and link errors do not expose internals', async () => {
  const { telegram } = await sources();
  assert.match(telegram, /p_telegram_user_id: String\(ctx\.from\.id\)/u);
  assert.match(telegram, /allowUnlinkedForRelink: true/u);
  assert.match(telegram, /Párovací kód je neplatný alebo už vypršal/u);
  assert.doesNotMatch(telegram, /console\.(?:log|error)\([^\n]*\bcode\b/iu);
});

test('workspace isolation is checked on both web and Telegram sides', async () => {
  const { migration } = await sources();
  const membershipChecks = migration.match(/from public\.workspace_members wm[\s\S]*?w\.deleted_at is null/gu) ?? [];
  assert.ok(membershipChecks.length >= 3);
  assert.match(migration, /A web account may have at most one currently active Telegram identity/u);
});

test('RPC permissions preserve least privilege and link tokens are never stored in plaintext', async () => {
  const [{ migration }, grantsMigration] = await Promise.all([
    sources(),
    readFile(grantsMigrationUrl, 'utf8'),
  ]);
  assert.match(migration, /revoke all on function public\.consume_telegram_link_code\(text, text, text\) from public, anon, authenticated/u);
  assert.match(migration, /grant execute on function public\.consume_telegram_link_code\(text, text, text\) to service_role/u);
  assert.match(migration, /grant execute on function public\.create_telegram_link_code\(\) to authenticated/u);
  assert.doesNotMatch(migration, /grant execute on function public\.create_telegram_link_code\(\) to authenticated, service_role/u);
  assert.match(grantsMigration, /revoke execute on function public\.current_ofa_user_id\(\) from service_role/u);
  assert.match(grantsMigration, /revoke execute on function public\.is_current_user_workspace_member\(uuid\) from service_role/u);
  assert.match(grantsMigration, /revoke execute on function public\.create_telegram_link_code\(\) from service_role/u);
  assert.doesNotMatch(grantsMigration, /revoke execute on function public\.consume_telegram_link_code/u);
  assert.doesNotMatch(migration, /insert into public\.telegram_link_codes[^;]*\bcode\b/iu);
});
