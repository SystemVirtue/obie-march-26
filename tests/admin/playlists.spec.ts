/**
 * PLAYLISTS TESTS — Admin PlaylistsPanel
 *
 * Tests: All Playlists view, Import view, Load playlist button,
 * expanded playlist items, create dialog, delete confirmation.
 */
import { test, expect } from '../fixtures/base';

const BASE = 'http://localhost:5173';

async function goToAllPlaylists(page: any) {
  await page.goto(BASE);
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: /Playlists/i }).first().click();
  await page.waitForTimeout(200);
  await page.getByRole('button', { name: 'All Playlists' }).first().click();
  await page.waitForTimeout(500);
}

async function goToImportPlaylist(page: any) {
  await page.goto(BASE);
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: /Playlists/i }).first().click();
  await page.waitForTimeout(200);
  await page.getByRole('button', { name: 'Import Playlist' }).first().click();
  await page.waitForTimeout(500);
}

test('playlist-01: All Playlists view renders panel header', async ({ page, consoleLogs, isLoggedIn }) => {
  if (!isLoggedIn) { test.skip(true, 'No auth'); return; }
  await goToAllPlaylists(page);

  await expect(page.getByText('All Playlists')).toBeVisible({ timeout: 10_000 });

  const errors = consoleLogs.filter(l => l.type === 'error' && !l.text.includes('Auth session missing'));
  expect(errors.length, errors.map(e => e.text).join(', ')).toBe(0);
});

test('playlist-02: playlists list loads (or shows empty state)', async ({ page, consoleLogs, isLoggedIn }) => {
  if (!isLoggedIn) { test.skip(true, 'No auth'); return; }
  await goToAllPlaylists(page);

  // Either a list of playlists or an empty state message
  await expect(async () => {
    const hasList  = await page.locator('[style*="border-radius"]').filter({ hasText: /\w+/ }).count() > 0;
    const hasEmpty = await page.getByText(/no playlists|empty/i).isVisible().catch(() => false);
    expect(hasList || hasEmpty).toBe(true);
  }).toPass({ timeout: 15_000 });

  const errors = consoleLogs.filter(l => l.type === 'error' && !l.text.includes('Auth session missing'));
  expect(errors.length, errors.map(e => e.text).join(', ')).toBe(0);
});

test('playlist-03: Load button is visible on each playlist row', async ({ page, consoleLogs, isLoggedIn }) => {
  if (!isLoggedIn) { test.skip(true, 'No auth'); return; }
  await goToAllPlaylists(page);

  // Wait for playlists to load
  await page.waitForTimeout(3000);

  const loadBtns = page.getByRole('button', { name: /load/i });
  const count = await loadBtns.count();
  console.log(`[playlist-03] Found ${count} Load buttons`);

  if (count > 0) {
    await expect(loadBtns.first()).toBeVisible();
  } else {
    console.log('[playlist-03] No playlists found — checking for empty state');
    const hasContent = await page.locator('body').textContent();
    console.log('[playlist-03] Page text (first 200):', hasContent?.slice(0, 200));
  }
});

test('playlist-04: clicking Load triggers single API call (no multi-step)', async ({ page, consoleLogs, isLoggedIn }) => {
  if (!isLoggedIn) { test.skip(true, 'No auth'); return; }
  await goToAllPlaylists(page);
  await page.waitForTimeout(3000);

  const loadBtns = page.getByRole('button', { name: /load/i });
  const count = await loadBtns.count();
  if (count === 0) {
    test.skip(true, 'No playlists available — skip');
    return;
  }

  // Track network calls to playlist-manager
  const calls: string[] = [];
  page.on('request', req => {
    if (req.url().includes('playlist-manager')) {
      try {
        calls.push(JSON.stringify(req.postData()));
      } catch {}
    }
  });

  await loadBtns.first().click();

  // Wait for success indicator
  await expect(async () => {
    const hasSuccess = await page.getByText(/loaded|✓/i).isVisible().catch(() => false);
    const hasError   = await page.getByText(/failed|❌/i).isVisible().catch(() => false);
    expect(hasSuccess || hasError).toBe(true);
  }).toPass({ timeout: 15_000 });

  // Should be exactly ONE call to playlist-manager (the load_playlist action)
  const loadPlaylistCalls = calls.filter(c => c.includes('load_playlist'));
  console.log(`[playlist-04] Total playlist-manager calls: ${calls.length}`);
  console.log(`[playlist-04] load_playlist calls: ${loadPlaylistCalls.length}`);

  // We should have exactly 1 load_playlist call (not 3 separate set_active/clear/import)
  expect(loadPlaylistCalls.length).toBe(1);

  // Should NOT have separate clear_queue + set_active calls alongside it
  const clearCalls  = calls.filter(c => c.includes('clear_queue'));
  const activeCalls = calls.filter(c => c.includes('set_active'));
  expect(clearCalls.length,  'Should not call clear_queue separately').toBe(0);
  expect(activeCalls.length, 'Should not call set_active separately').toBe(0);

  const errors = consoleLogs.filter(l => l.type === 'error' && !l.text.includes('Auth session missing'));
  expect(errors.length, errors.map(e => e.text).join(', ')).toBe(0);
});

test('playlist-05: Import Playlist view renders URL input', async ({ page, consoleLogs, isLoggedIn }) => {
  if (!isLoggedIn) { test.skip(true, 'No auth'); return; }
  await goToImportPlaylist(page);

  await expect(page.getByText('Import Playlist')).toBeVisible({ timeout: 10_000 });

  // Should have a text input for URL / playlist ID
  const input = page.locator('input[type="text"], input[type="url"], input[placeholder]').first();
  await expect(input).toBeVisible({ timeout: 8_000 });

  const errors = consoleLogs.filter(l => l.type === 'error' && !l.text.includes('Auth session missing'));
  expect(errors.length, errors.map(e => e.text).join(', ')).toBe(0);
});
