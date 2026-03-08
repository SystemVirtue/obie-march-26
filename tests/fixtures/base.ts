/**
 * Base test fixture — extends Playwright's `test` with:
 *  - consoleLogs: captures all browser console messages (Console Ninja compatible)
 *  - isLoggedIn: true when valid auth state is loaded
 *  - helpers for common UI actions
 */
import { test as base, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

type ConsoleEntry = { type: string; text: string; location: string };

export type TestFixtures = {
  consoleLogs: ConsoleEntry[];
  isLoggedIn: boolean;
  waitForQueue: (page: Page, minItems?: number) => Promise<void>;
  navigateTo: (page: Page, label: string) => Promise<void>;
};

export const test = base.extend<TestFixtures>({
  // ── Console capture (Console Ninja reads these) ───────────────────────────
  consoleLogs: async ({ page }, use) => {
    const logs: ConsoleEntry[] = [];

    page.on('console', (msg) => {
      const entry: ConsoleEntry = {
        type:     msg.type(),
        text:     msg.text(),
        location: msg.location().url,
      };
      logs.push(entry);
      // Mirror to test runner stdout so Console Ninja picks them up inline
      const prefix = msg.type() === 'error' ? '🔴' : msg.type() === 'warn' ? '🟡' : '📋';
      console.log(`${prefix} [BROWSER] ${entry.text}`);
    });

    page.on('pageerror', (err) => {
      const entry: ConsoleEntry = { type: 'pageerror', text: err.message, location: '' };
      logs.push(entry);
      console.error(`💥 [PAGEERROR] ${err.message}`);
    });

    await use(logs);

    // Print summary after each test
    const errors = logs.filter(l => l.type === 'error' || l.type === 'pageerror');
    if (errors.length > 0) {
      console.warn(`\n⚠️  ${errors.length} browser error(s) captured during this test:`);
      errors.forEach(e => console.warn(`   ↳ ${e.text}`));
    }
  },

  // ── Auth state check ──────────────────────────────────────────────────────
  isLoggedIn: async ({}, use) => {
    const authFile = path.join(__dirname, '../.auth/admin.json');
    let loggedIn = false;
    if (fs.existsSync(authFile)) {
      try {
        const state = JSON.parse(fs.readFileSync(authFile, 'utf-8'));
        loggedIn = (state.cookies?.length ?? 0) > 0 || (state.origins?.length ?? 0) > 0;
        // Check if there's an actual access token stored
        for (const origin of state.origins || []) {
          for (const item of origin.localStorage || []) {
            if (item.name?.includes('access_token') && item.value) {
              loggedIn = true;
            }
          }
        }
      } catch {}
    }
    await use(loggedIn);
  },

  // ── Wait for queue items to appear ───────────────────────────────────────
  waitForQueue: async ({}, use) => {
    await use(async (page: Page, minItems = 1) => {
      // Navigate to queue-next if not already there
      const shuffleBtn = page.getByRole('button', { name: /shuffle/i });
      const emptyMsg   = page.getByText('Queue is empty');

      if (minItems === 0) {
        await expect(emptyMsg).toBeVisible({ timeout: 10_000 });
        return;
      }

      // Wait until at least minItems queue items (drag handles ⋮⋮)
      await expect(async () => {
        const handles = page.locator('button').filter({ hasText: '⋮⋮' });
        const count   = await handles.count();
        expect(count).toBeGreaterThanOrEqual(minItems);
      }).toPass({ timeout: 15_000, intervals: [500] });
    });
  },

  // ── Navigate sidebar ──────────────────────────────────────────────────────
  navigateTo: async ({}, use) => {
    await use(async (page: Page, label: string) => {
      // Click matching sidebar button
      await page.getByRole('button', { name: label }).first().click();
      await page.waitForTimeout(300); // let the view transition settle
    });
  },
});

export { expect };
