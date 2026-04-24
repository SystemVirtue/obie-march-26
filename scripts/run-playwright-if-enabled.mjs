#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const enabled = String(process.env.RUN_E2E_INTEGRATION || '').toLowerCase() === 'true';

if (!enabled) {
  console.log('⚠️ Skipping Playwright: set RUN_E2E_INTEGRATION=true (and required Supabase/auth env vars) to run E2E tests.');
  process.exit(0);
}

const result = spawnSync('npx', ['playwright', 'test'], { stdio: 'inherit', shell: true });
process.exit(result.status ?? 1);
