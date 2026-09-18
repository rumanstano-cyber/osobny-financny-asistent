import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { encodeStoragePath, safeBackupPath } from './backup-supabase-storage.mjs';

test('storage object paths remain inside the isolated backup directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ofa-backup-test-'));
  assert.equal(safeBackupPath(root, 'workspace/receipt.jpg'), resolve(root, 'workspace/receipt.jpg'));
  assert.throws(() => safeBackupPath(root, '../outside'), /Unsafe storage object key/u);
  assert.throws(() => safeBackupPath(root, 'workspace/../../outside'), /Unsafe storage object key/u);
  assert.throws(() => safeBackupPath(root, '/absolute'), /Unsafe storage object key/u);
});

test('storage paths are encoded per segment without losing hierarchy', () => {
  assert.equal(encodeStoragePath('workspace/a b/účtenka.jpg'), 'workspace/a%20b/%C3%BA%C4%8Dtenka.jpg');
});
