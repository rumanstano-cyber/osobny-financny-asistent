import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(new URL('../../../supabase/migrations/20260923181247_privacy_account_workflows.sql', import.meta.url), 'utf8');

test('shared owner cannot confirm deletion while another active member exists', () => {
  const confirm = migration.split('create or replace function public.confirm_account_erasure_internal')[1]
    ?.split('create or replace function public.confirm_account_erasure(')[0] ?? '';
  assert.match(confirm, /owner_member\.role = 'owner'/u);
  assert.match(confirm, /other_member\.user_id <> p_user_id/u);
  assert.match(confirm, /other_member\.status = 'active'/u);
  assert.match(confirm, /other_user\.status = 'active'/u);
  assert.match(confirm, /raise exception 'Explicit ownership transfer required before erasure'/u);
  assert.ok(confirm.indexOf('Explicit ownership transfer required') < confirm.indexOf('insert into public.gdpr_requests'));
});

test('successor must be an existing active eligible member of the same workspace', () => {
  const transfer = migration.split('create or replace function public.transfer_workspace_ownership_for_erasure_internal')[1]
    ?.split('create or replace function public.transfer_workspace_ownership_for_erasure(')[0] ?? '';
  assert.match(transfer, /member\.workspace_id = p_workspace_id/u);
  assert.match(transfer, /member\.user_id = p_successor_user_id/u);
  assert.match(transfer, /member\.status = 'active'/u);
  assert.match(transfer, /member\.removed_at is null/u);
  assert.match(transfer, /member\.role in \('admin', 'member'\)/u);
  assert.match(transfer, /successor\.status = 'active'/u);
  assert.match(transfer, /successor\.deleted_at is null/u);
  assert.match(transfer, /p_actor_user_id = p_successor_user_id/u);
});

test('transfer is explicit, auditable and scoped to exactly the selected workspace', () => {
  const transfer = migration.split('create or replace function public.transfer_workspace_ownership_for_erasure_internal')[1]
    ?.split('create or replace function public.transfer_workspace_ownership_for_erasure(')[0] ?? '';
  assert.match(transfer, /where workspace\.id = p_workspace_id and workspace\.deleted_at is null\s+for update/u);
  assert.match(transfer, /v_existing_owner is distinct from p_actor_user_id/u);
  assert.match(transfer, /set role = 'member'\s+where member\.workspace_id = p_workspace_id and member\.user_id = p_actor_user_id/u);
  assert.match(transfer, /set role = 'owner'\s+where member\.workspace_id = p_workspace_id and member\.user_id = p_successor_user_id/u);
  assert.match(transfer, /where workspace\.id = p_workspace_id and workspace\.created_by_user_id = p_actor_user_id/u);
  assert.match(transfer, /workspace\.ownership_transferred_for_erasure/u);
  assert.doesNotMatch(transfer, /order by.*created_at.*limit 1/iu);
});

test('sole-member workspace needs no transfer, grace is 30 days, and cancellation does not revert ownership', () => {
  const confirm = migration.split('create or replace function public.confirm_account_erasure_internal')[1]
    ?.split('create or replace function public.confirm_account_erasure(')[0] ?? '';
  const cancel = migration.split('create or replace function public.cancel_account_erasure_internal')[1]
    ?.split('create or replace function public.cancel_account_erasure(')[0] ?? '';
  assert.match(confirm, /exists \(\s*select 1 from public\.workspace_members other_member/u);
  assert.match(confirm, /pg_catalog\.now\(\) \+ interval '30 days'/u);
  assert.match(confirm, /set status = 'deleted'/u);
  assert.match(cancel, /request\.due_at > pg_catalog\.now\(\)/u);
  assert.match(cancel, /set status = 'active'/u);
  assert.doesNotMatch(cancel, /update public\.(workspace_members|workspaces)/u);
});

test('new definer RPCs have empty search paths and minimum grants', () => {
  const declarations = [...migration.matchAll(/create or replace function public\.([a-z_]+)\([^]*?security definer\s+set search_path = ''/gu)];
  assert.ok(declarations.length >= 10);
  assert.match(migration, /revoke all on function public\.transfer_workspace_ownership_for_erasure_internal\(uuid, uuid, uuid\) from public, anon, authenticated/u);
  assert.match(migration, /grant execute on function public\.transfer_workspace_ownership_for_erasure\(uuid, uuid\) to authenticated/u);
  assert.match(migration, /grant execute on function public\.transfer_telegram_workspace_ownership_for_erasure\(text, uuid, uuid\) to service_role/u);
});
