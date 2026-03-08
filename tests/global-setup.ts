/**
 * Global setup: log in to admin and save storageState.
 * Skips gracefully if TEST_EMAIL / TEST_PASSWORD are not set.
 */
import { test as setup, expect } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';

const AUTH_FILE = path.join(__dirname, '.auth/admin.json');

setup('authenticate as admin', async ({ page }) => {
  const email    = process.env.TEST_EMAIL    || '';
  const password = process.env.TEST_PASSWORD || '';

  // Ensure the .auth directory exists
  const authDir = path.dirname(AUTH_FILE);
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  if (!email || !password) {
    console.warn(
      '\n⚠️  TEST_EMAIL / TEST_PASSWORD not set — saving empty auth state.\n' +
      '   Admin tests that require authentication will be skipped.\n' +
      '   Add these to your .env file to run the full suite.\n'
    );
    // Write empty auth state so dependant projects still load
    fs.writeFileSync(AUTH_FILE, JSON.stringify({ cookies: [], origins: [] }));
    return;
  }

  await page.goto('http://localhost:5173');
  await expect(page.getByText('Obie Admin')).toBeVisible({ timeout: 20_000 });

  // No htmlFor/id association on inputs — use type selectors
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: 'Sign In' }).click();

  // Wait until we're past the login screen (sidebar visible)
  await expect(page.getByText('Admin Console')).toBeVisible({ timeout: 20_000 });

  await page.context().storageState({ path: AUTH_FILE });
  console.log('✅ Admin auth state saved');
});
