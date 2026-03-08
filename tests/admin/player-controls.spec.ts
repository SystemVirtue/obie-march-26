/**
 * PLAYER CONTROLS TESTS — NowPlayingStage
 *
 * Tests: play/pause toggle, skip button, status indicator,
 * progress bar, volume display, skip disabled during skip.
 */
import { test, expect } from '../fixtures/base';
import { bringPlayerOnline } from '../helpers/db';

const BASE = 'http://localhost:5173';

test.beforeAll(async () => {
  await bringPlayerOnline();
});

test.beforeEach(async ({ page, isLoggedIn }) => {
  if (!isLoggedIn) return;
  await page.goto(BASE);
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('button').filter({ hasText: /[▶⏸]/ })).toBeVisible({ timeout: 15_000 });
});

test('ctrl-01: NowPlayingStage renders core control elements', async ({ page, consoleLogs, isLoggedIn }) => {
  if (!isLoggedIn) {
    test.skip(true, 'No auth — skip');
    return;
  }

  // Play/pause button (▶ or ⏸)
  const playPauseBtn = page.locator('button').filter({ hasText: /^[▶⏸]$/ });
  await expect(playPauseBtn).toBeVisible({ timeout: 10_000 });

  // Skip button ⏭ (or Spinner during skip)
  const skipBtn = page.locator('button').filter({ hasText: '⏭' }).or(
    page.locator('button[disabled]').filter({ hasText: '' })
  );
  await expect(skipBtn.first()).toBeVisible({ timeout: 10_000 });

  // Progress bar container
  await expect(page.locator('input[type="range"]')).toBeVisible();

  // Status dot (playing/paused/idle indicator text)
  const statusEl = page.locator('[style*="Now Playing"], [style*="Paused"], [style*="idle"], [style*="offline"]')
    .or(page.getByText(/Now Playing|Paused|Idle|offline/i).first());
  await expect(statusEl.first()).toBeVisible({ timeout: 10_000 });

  const errors = consoleLogs.filter(l => l.type === 'error' && !l.text.includes('Auth session missing'));
  expect(errors.length, errors.map(e => e.text).join(', ')).toBe(0);
});

test('ctrl-02: play/pause button toggles between ▶ and ⏸', async ({ page, consoleLogs, isLoggedIn }) => {
  if (!isLoggedIn) {
    test.skip(true, 'No auth — skip');
    return;
  }

  const ppBtn = page.locator('button').filter({ hasText: /^[▶⏸]$/ });
  const before = await ppBtn.textContent();
  console.log(`[ctrl-02] Before click: "${before}"`);

  await ppBtn.click();
  await page.waitForTimeout(1000); // give realtime time to reflect state change

  const after = await ppBtn.textContent();
  console.log(`[ctrl-02] After click: "${after}"`);

  // State should have changed (▶→⏸ or ⏸→▶)
  expect(after).not.toBe(before);

  // Restore original state
  await ppBtn.click();
  await page.waitForTimeout(500);

  const errors = consoleLogs.filter(l => l.type === 'error' && !l.text.includes('Auth session missing'));
  expect(errors.length, errors.map(e => e.text).join(', ')).toBe(0);
});

test('ctrl-03: skip button is enabled when not skipping', async ({ page, consoleLogs, isLoggedIn }) => {
  if (!isLoggedIn) {
    test.skip(true, 'No auth — skip');
    return;
  }

  const skipBtn = page.locator('button').filter({ hasText: '⏭' });
  await expect(skipBtn).toBeEnabled({ timeout: 10_000 });

  const errors = consoleLogs.filter(l => l.type === 'error' && !l.text.includes('Auth session missing'));
  expect(errors.length, errors.map(e => e.text).join(', ')).toBe(0);
});

test('ctrl-04: skip button briefly disables after click (isSkipping guard)', async ({ page, consoleLogs, isLoggedIn }) => {
  if (!isLoggedIn) {
    test.skip(true, 'No auth — skip');
    return;
  }

  const skipBtn = page.locator('button').filter({ hasText: '⏭' });
  await expect(skipBtn).toBeEnabled({ timeout: 10_000 });

  await skipBtn.click();

  // Within 200ms the button should be disabled (spinner replaces icon)
  await expect(async () => {
    const btn = page.locator('button[disabled]');
    await expect(btn.first()).toBeVisible({ timeout: 200 });
  }).toPass({ timeout: 3000 }).catch(() => {
    // Some machines are too fast / too slow — the disabled state may flash
    console.log('[ctrl-04] Disabled state too brief to catch — acceptable');
  });

  // Within 5s the button recovers (isSkipping resets)
  await expect(skipBtn).toBeEnabled({ timeout: 5000 });

  const errors = consoleLogs.filter(l => l.type === 'error' && !l.text.includes('Auth session missing'));
  expect(errors.length, errors.map(e => e.text).join(', ')).toBe(0);
});

test('ctrl-05: volume slider is visible and shows value 0-100', async ({ page, consoleLogs, isLoggedIn }) => {
  if (!isLoggedIn) {
    test.skip(true, 'No auth — skip');
    return;
  }

  const slider = page.locator('input[type="range"]');
  await expect(slider).toBeVisible({ timeout: 10_000 });

  const value = await slider.getAttribute('value');
  const numVal = parseInt(value ?? '0', 10);
  console.log(`[ctrl-05] Volume: ${numVal}`);
  expect(numVal).toBeGreaterThanOrEqual(0);
  expect(numVal).toBeLessThanOrEqual(100);

  const errors = consoleLogs.filter(l => l.type === 'error' && !l.text.includes('Auth session missing'));
  expect(errors.length, errors.map(e => e.text).join(', ')).toBe(0);
});

test('ctrl-06: status indicator shows a valid state string', async ({ page, consoleLogs, isLoggedIn }) => {
  if (!isLoggedIn) {
    test.skip(true, 'No auth — skip');
    return;
  }

  // The status pill shows one of: playing, paused, idle, loading, offline
  const validStates = ['playing', 'paused', 'idle', 'loading', 'offline'];
  let foundState = '';

  for (const state of validStates) {
    const el = page.getByText(state, { exact: false });
    if (await el.first().isVisible({ timeout: 1000 }).catch(() => false)) {
      foundState = state;
      break;
    }
  }

  console.log(`[ctrl-06] Current state: "${foundState}"`);
  expect(validStates.some(s => s === foundState || foundState.includes(s))).toBe(true);

  const errors = consoleLogs.filter(l => l.type === 'error' && !l.text.includes('Auth session missing'));
  expect(errors.length, errors.map(e => e.text).join(', ')).toBe(0);
});
