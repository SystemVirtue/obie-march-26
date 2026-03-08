import { defineConfig, devices } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '.env') });

/**
 * Playwright config for Obie Jukebox v5
 *
 * Three apps under test:
 *  - Admin  http://localhost:5173  (requires auth)
 *  - Player http://localhost:5174  (no auth)
 *  - Kiosk  http://localhost:5175  (no auth)
 *
 * Test credentials: set TEST_EMAIL + TEST_PASSWORD in .env (or .env.test)
 * If not set, auth-gated admin tests are skipped automatically.
 */
export default defineConfig({
  testDir: './tests',

  // Integration tests share a live Supabase — run serially to avoid conflicts
  fullyParallel: false,
  workers: 1,

  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,

  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],

  use: {
    // Capture everything for debugging via Console Ninja + VSCode
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
    // Show browser in VSCode window
    headless: false,
    // Capture all browser console output
    ignoreHTTPSErrors: true,
    // Give realtime subscriptions time to settle
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },

  projects: [
    // ── 1. Auth setup (runs first, saves storageState) ────────────────────────
    {
      name: 'setup',
      testMatch: '**/global-setup.ts',
      use: { ...devices['Desktop Chrome'], headless: true },
    },

    // ── 2. Auth tests (fresh context — tests the login page itself) ───────────
    {
      name: 'auth',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://localhost:5173',
        // No storageState — these tests verify the login form itself
      },
      testMatch: 'tests/auth/**/*.spec.ts',
    },

    // ── 3. Admin (authenticated) ───────────────────────────────────────────────
    {
      name: 'admin',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://localhost:5173',
        storageState: 'tests/.auth/admin.json',
      },
      dependencies: ['setup'],
      testMatch: 'tests/admin/**/*.spec.ts',
    },

    // ── 3. Kiosk (public) ─────────────────────────────────────────────────────
    {
      name: 'kiosk',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://localhost:5175',
      },
      testMatch: 'tests/kiosk/**/*.spec.ts',
    },

    // ── 4. Player (public) ────────────────────────────────────────────────────
    {
      name: 'player',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://localhost:5174',
      },
      testMatch: 'tests/player/**/*.spec.ts',
    },
  ],

  webServer: [
    {
      command: 'npm run dev:admin',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: 'npm run dev:kiosk',
      url: 'http://localhost:5175',
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: 'npm run dev:player',
      url: 'http://localhost:5174',
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
