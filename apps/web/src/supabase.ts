import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();

export const isSupabaseConfigured = Boolean(
  url &&
  publishableKey &&
  /^https:\/\/.+\.supabase\.co$/i.test(url),
);

let client: ReturnType<typeof createClient> | null = null;

export function getSupabaseClient() {
  if (!isSupabaseConfigured) {
    throw new Error('Chýba alebo je neplatná VITE_SUPABASE_URL/VITE_SUPABASE_PUBLISHABLE_KEY. Skopírujte apps/web/.env.example do apps/web/.env.local.');
  }

  if (!client) {
    client = createClient(url!, publishableKey!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
  }

  return client;
}
