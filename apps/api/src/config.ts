import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  SUPABASE_URL: z.string().trim().url().refine(
    (value) => new URL(value).protocol === 'https:' && Boolean(new URL(value).hostname),
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

export const config = environmentSchema.parse(process.env);
