import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

const DEFAULT_BUCKET = 'ofa-receipts';
const PAGE_SIZE = 1_000;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function safeBackupPath(root, objectKey) {
  const parts = objectKey.split('/');
  if (!objectKey || parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Unsafe storage object key');
  }
  const rootPath = resolve(root);
  const candidate = resolve(rootPath, ...parts);
  if (candidate !== rootPath && !candidate.startsWith(`${rootPath}${sep}`)) {
    throw new Error('Storage object key escapes the backup directory');
  }
  return candidate;
}

export function encodeStoragePath(value) {
  return value.split('/').map((part) => encodeURIComponent(part)).join('/');
}

async function withRetry(operation, label) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, attempt * 1_000));
      }
    }
  }
  throw new Error(`${label} failed after ${MAX_ATTEMPTS} attempts`, { cause: lastError });
}

function requestHeaders(serviceRoleKey, includeJson = false) {
  return {
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
    ...(includeJson ? { 'content-type': 'application/json' } : {}),
  };
}

async function listDirectory(baseUrl, serviceRoleKey, bucket, prefix) {
  const entries = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await withRetry(async () => {
      const response = await fetch(`${baseUrl}/storage/v1/object/list/${encodeURIComponent(bucket)}`, {
        method: 'POST',
        headers: requestHeaders(serviceRoleKey, true),
        body: JSON.stringify({ prefix, limit: PAGE_SIZE, offset, sortBy: { column: 'name', order: 'asc' } }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`Storage list returned HTTP ${response.status}`);
      const value = await response.json();
      if (!Array.isArray(value)) throw new Error('Storage list returned an invalid response');
      return value;
    }, 'Storage list');
    entries.push(...page);
    if (page.length < PAGE_SIZE) return entries;
  }
}

async function listObjectsRecursively(baseUrl, serviceRoleKey, bucket, prefix = '') {
  const objects = [];
  const entries = await listDirectory(baseUrl, serviceRoleKey, bucket, prefix);
  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string') throw new Error('Storage list contains an invalid entry');
    const objectKey = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.id || entry.metadata) {
      objects.push({ key: objectKey, metadata: entry.metadata ?? {} });
    } else {
      objects.push(...await listObjectsRecursively(baseUrl, serviceRoleKey, bucket, objectKey));
    }
  }
  return objects;
}

async function downloadObject(baseUrl, serviceRoleKey, bucket, objectKey, destination) {
  const response = await withRetry(async () => {
    const result = await fetch(
      `${baseUrl}/storage/v1/object/authenticated/${encodeURIComponent(bucket)}/${encodeStoragePath(objectKey)}`,
      { headers: requestHeaders(serviceRoleKey), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );
    if (!result.ok || !result.body) throw new Error(`Storage download returned HTTP ${result.status}`);
    return result;
  }, 'Storage download');

  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const hash = createHash('sha256');
  let bytes = 0;
  const hasher = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), hasher, createWriteStream(destination, { mode: 0o600 }));
  return { bytes, sha256: hash.digest('hex') };
}

export async function backupSupabaseStorage({ baseUrl, serviceRoleKey, bucket, outputDirectory }) {
  const objectDirectory = resolve(outputDirectory, 'objects');
  await mkdir(objectDirectory, { recursive: true, mode: 0o700 });
  const objects = await listObjectsRecursively(baseUrl, serviceRoleKey, bucket);
  const manifestObjects = [];

  for (const object of objects) {
    const destination = safeBackupPath(objectDirectory, object.key);
    const downloaded = await downloadObject(baseUrl, serviceRoleKey, bucket, object.key, destination);
    manifestObjects.push({ key: object.key, ...downloaded });
  }

  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    bucket,
    objectCount: manifestObjects.length,
    totalBytes: manifestObjects.reduce((total, object) => total + object.bytes, 0),
    objects: manifestObjects,
  };
  await writeFile(resolve(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

async function main() {
  const baseUrl = requiredEnv('SUPABASE_URL').replace(/\/+$/u, '');
  if (!baseUrl.startsWith('https://')) throw new Error('SUPABASE_URL must use HTTPS');
  const serviceRoleKey = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
  const bucket = process.env.SUPABASE_STORAGE_BUCKET?.trim() || DEFAULT_BUCKET;
  const outputDirectory = resolve(requiredEnv('BACKUP_STORAGE_DIRECTORY'));
  const manifest = await backupSupabaseStorage({ baseUrl, serviceRoleKey, bucket, outputDirectory });
  console.log('Supabase Storage backup completed', {
    bucket,
    objectCount: manifest.objectCount,
    totalBytes: manifest.totalBytes,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error('Supabase Storage backup failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  });
}
