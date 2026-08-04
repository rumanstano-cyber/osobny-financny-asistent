import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

// This client is backend-only. Never expose SUPABASE_SERVICE_ROLE_KEY to a client app.
export const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
