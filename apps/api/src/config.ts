import { config as loadDotenv } from 'dotenv';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

// Resolve from this source file, not process.cwd(): pnpm, Render, and direct
// Node invocations can each use a different working directory.
const apiDirectory = dirname(fileURLToPath(import.meta.url));
export const rootEnvPath = resolve(apiDirectory, '../../..', '.env');
loadDotenv({ path: rootEnvPath });

function normalizeSecret(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.trim().replace(/^(?:"|')+|(?:"|')+$/g, '').trim();
}

const telegramToken = normalizeSecret(process.env.TELEGRAM_BOT_TOKEN);
if (!telegramToken || telegramToken === 'VLOZ_SEM_TVOJ_TOKEN') {
  console.error('CHYBA: Vlože svoj skutočný Telegram token do .env súboru.');
  process.exit(1);
}
process.env.TELEGRAM_BOT_TOKEN = telegramToken;

// Keep the API key path consistent with the Telegram token path. This also
// protects local .env values copied from dashboards against surrounding spaces
// or quotation marks, while Render-provided environment variables continue to
// work unchanged.
const openAiApiKey = normalizeSecret(process.env.OPENAI_API_KEY);
if (openAiApiKey) process.env.OPENAI_API_KEY = openAiApiKey;

console.info('Environment configuration loaded', {
  envFile: rootEnvPath,
  telegramTokenLength: telegramToken.length,
  telegramTokenSha256Prefix: createHash('sha256').update(telegramToken).digest('hex').slice(0, 12),
});

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  BASE_URL: z.string().trim().url().optional(),
  REGISTER_TELEGRAM_WEBHOOK: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  SUPABASE_URL: z.string().trim().url().refine(
    (value) => value.startsWith('https://') && value.length > 'https://'.length,
    'SUPABASE_URL must be a complete HTTPS URL, for example https://your-project.supabase.co',
  ),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(24).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  INTERNAL_CRON_SECRET: z.string().min(24),
  RESEND_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM: z.string().email().optional(),
  EMAIL_TO: z.string().min(3).optional(),
});

const environment = environmentSchema.parse(process.env);

export const config = {
  ...environment,
  // BASE_URL is intentionally independent from the Render-assigned PORT. Render
  // injects PORT at runtime, while its public URL always uses HTTPS.
  BASE_URL: environment.BASE_URL?.replace(/\/$/, '') ?? `http://localhost:${environment.PORT}`,
};
