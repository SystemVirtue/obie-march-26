/**
 * AUTH TESTS — Admin login / logout
 */
import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:5173';

// Auth tests run in a fresh context with NO storageState (see playwright.config.ts 'auth' project)
test('auth-01: login page renders with email + password fields', async ({ page }) => {
  await page.goto(BASE);
  // Wait past the "Loading…" spinner — Obie Admin appears after getCurrentUser() resolves
  await expect(page.getByText('Obie Admin')).toBeVisible({ timeout: 25_000 });
  await expect(page.getByText('CONSOLE ACCESS')).toBeVisible();

  // Form fields — no htmlFor/id on inputs, so use type selectors
  await expect(page.locator('input[type="email"]')).toBeVisible();
  await expect(page.locator('input[type="password"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign In' })).toBeEnabled();
});

test('auth-02: invalid credentials shows error message', async ({ page }) => {
  await page.goto(BASE);
  await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 25_000 });

  await page.locator('input[type="email"]').fill('invalid@test.com');
  await page.locator('input[type="password"]').fill('wrongpassword');
  await page.getByRole('button', { name: 'Sign In' }).click();

  // Some form of error should appear (Supabase returns a message)
  await expect(async () => {
    const errEl = page.locator('[style*="color: #f87171"]').or(page.getByText(/invalid|error|failed/i));
    await expect(errEl.first()).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 15_000 });
});

test('auth-03: sign in with valid credentials if TEST_EMAIL is set', async ({ page }) => {
  const email    = process.env.TEST_EMAIL    || '';
  const password = process.env.TEST_PASSWORD || '';

  if (!email || !password) {
    test.skip(true, 'TEST_EMAIL / TEST_PASSWORD not configured — skipping');
    return;
  }

  await page.goto(BASE);
  await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 25_000 });
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: 'Sign In' }).click();

  // Sidebar appears after login
  await expect(page.getByRole('button', { name: /Queue/i })).toBeVisible({ timeout: 20_000 });
});

test('auth-04: sign out returns to login screen', async ({ page }) => {
  const email    = process.env.TEST_EMAIL    || '';
  const password = process.env.TEST_PASSWORD || '';

  if (!email || !password) {
    test.skip(true, 'TEST_EMAIL / TEST_PASSWORD not configured — skipping');
    return;
  }

  await page.goto(BASE);
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page.getByRole('button', { name: /Queue/i })).toBeVisible({ timeout: 20_000 });

  // Sign out
  await page.getByRole('button', { name: 'Sign Out' }).click();
  await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible({ timeout: 10_000 });
});
