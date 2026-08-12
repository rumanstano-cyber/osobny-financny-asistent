import { createHash } from 'node:crypto';
import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// This diagnostic deliberately runs in a fresh process and does not import the
// application config, Supabase client, or OpenAI client. It proves which root
// .env Telegram token would be loaded without requiring unrelated credentials.
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const rootEnvPath = resolve(scriptDirectory, '../../..', '.env');
loadDotenv({ path: rootEnvPath, override: true });

const token = process.env.TELEGRAM_BOT_TOKEN?.trim().replace(/^(?:"|')+|(?:"|')+$/g, '').trim();
if (!token || token === 'VLOZ_SEM_TVOJ_TOKEN') {
  console.error('CHYBA: Vlože svoj skutočný Telegram token do .env súboru.');
  process.exit(1);
}

const fingerprint = createHash('sha256').update(token).digest('hex').slice(0, 12);
console.info('Telegram token loaded from root .env', {
  envFile: rootEnvPath,
  length: token.length,
  sha256Prefix: fingerprint,
});

const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
const payload = await response.json();
if (!response.ok || !payload.ok) {
  console.error('Telegram token verification failed', {
    status: response.status,
    description: typeof payload.description === 'string' ? payload.description : 'Unknown error',
  });
  process.exit(1);
}

console.info('Telegram connection verified', { botId: payload.result.id, username: payload.result.username });
