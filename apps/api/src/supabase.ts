import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

const SUPABASE_REQUEST_TIMEOUT_MS = 30_000;

export function supabaseFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(SUPABASE_REQUEST_TIMEOUT_MS);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
  return fetch(input, { ...init, signal });
}

// This client is backend-only. Never expose SUPABASE_SERVICE_ROLE_KEY to a client app.
export const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
  global: { fetch: supabaseFetch },
});
