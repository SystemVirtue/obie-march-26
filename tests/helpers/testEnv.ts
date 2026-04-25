import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export const SUPABASE_URL = process.env.VITE_SUPABASE_URL || '';
export const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || '';
const RUN_E2E_INTEGRATION = (process.env.RUN_E2E_INTEGRATION || '').toLowerCase() === 'true';

function hasValidSupabaseEnv(): boolean {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return false;
  try {
    new URL(SUPABASE_URL);
    return true;
  } catch {
    return false;
  }
}

export function canRunIntegrationTests(): boolean {
  return RUN_E2E_INTEGRATION && hasValidSupabaseEnv();
}

export function integrationSkipMessage(): string {
  if (!RUN_E2E_INTEGRATION) {
    return 'RUN_E2E_INTEGRATION is not set to true; skipping integration-style Playwright tests by default.';
  }
  return 'Missing/invalid VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in .env; skipping integration-style Playwright tests.';
}
