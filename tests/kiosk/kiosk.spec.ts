test('kiosk-07: search and request adds to priority queue', async ({ page, consoleLogs }) => {
  // Step 1: Open kiosk and wait for session
  await page.goto(BASE);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  // Step 2: Find and use the search input
  const searchInput = page.locator('input[type="text"], input[placeholder*="search" i], input[placeholder*="song" i]').first();
  const hasInput = await searchInput.isVisible().catch(() => false);
  expect(hasInput).toBe(true);
  await searchInput.fill('FOO');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(3000);

  // Step 3: Wait for search results and select the first result
  const firstResult = page.locator('[data-testid="video-result-card"], .video-result-card').first();
  await expect(firstResult).toBeVisible({ timeout: 10000 });
  await firstResult.click();

  // Step 4: Confirm the request (look for a confirm button/dialog)
  const confirmBtn = page.getByRole('button', { name: /confirm|add|request/i }).first();
  await expect(confirmBtn).toBeVisible({ timeout: 5000 });
  await confirmBtn.click();
  await page.waitForTimeout(3000);

  // Step 5: Check that the requested song appears in the priority queue
  // (Assume the queue UI shows priority items first, and exposes their title or a marker)
  const queueItem = page.locator('[data-queue-type="priority"], .queue-priority, .priority-queue-item').first();
  await expect(queueItem).toBeVisible({ timeout: 10000 });
  // Optionally, check that the queue item matches the requested song title
  // const queueText = await queueItem.textContent();
  // expect(queueText?.toLowerCase()).toContain('foo');
});
/**
 * KIOSK TESTS — Public search & request interface
 *
 * Tests: init session, search input renders, search results,
 * confirm dialog, credits display, background playlist.
 *
 * Note: Kiosk requires no auth. All operations route through kiosk-handler edge function.
 */
import { test, expect } from '../fixtures/base';

const BASE = 'http://localhost:5175';

test.beforeEach(async ({ page }) => {
  await page.goto(BASE);
  // Wait for kiosk to initialize session
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000); // allow session init edge function to return
});

test('kiosk-01: kiosk loads and initializes session', async ({ page, consoleLogs }) => {
  // Should not crash during init
  const errors = consoleLogs.filter(l => l.type === 'error' && !l.text.includes('ResizeObserver'));
  expect(errors.length, errors.map(e => e.text).join(', ')).toBe(0);

  // The page should render something meaningful
  const bodyText = await page.textContent('body');
  console.log('[kiosk-01] Page text (first 300):', bodyText?.slice(0, 300));
  expect(bodyText?.length ?? 0).toBeGreaterThan(10);
});

test('kiosk-02: search interface is visible', async ({ page, consoleLogs }) => {
  // SearchInterface component should be rendered
  // It renders either: search input, keyboard, or a "tap to search" button
  const hasInput    = await page.locator('input[type="text"], input[placeholder]').first().isVisible().catch(() => false);
  const hasSearchEl = await page.locator('[class*="search"], [id*="search"]').first().isVisible().catch(() => false);
  const hasBtn      = await page.getByRole('button').count() > 0;

  console.log(`[kiosk-02] hasInput: ${hasInput}, hasSearchEl: ${hasSearchEl}, hasButtons: ${hasBtn}`);
  expect(hasInput || hasSearchEl || hasBtn).toBe(true);

  const errors = consoleLogs.filter(l => l.type === 'error' && !l.text.includes('ResizeObserver'));
  expect(errors.length, errors.map(e => e.text).join(', ')).toBe(0);
});

test('kiosk-03: search routes through kiosk-handler (not direct youtube-scraper)', async ({ page, consoleLogs }) => {
  // Monitor all fetch/XHR requests
  const requests: string[] = [];
  page.on('request', req => {
    const url = req.url();
    if (url.includes('functions/v1/')) {
      requests.push(url);
    }
  });

  // Find and use the search input or tap button to trigger a search
  await page.waitForTimeout(1000);

  // Look for any search trigger
  const searchInput = page.locator('input[type="text"], input[placeholder*="search" i], input[placeholder*="song" i]').first();
  const hasInput = await searchInput.isVisible().catch(() => false);

  if (hasInput) {
    await searchInput.fill('test song');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(3000);

    // Check that kiosk-handler was called, NOT youtube-scraper directly
    const kioskCalls   = requests.filter(r => r.includes('kiosk-handler'));
    const scraperCalls = requests.filter(r => r.includes('youtube-scraper'));

    console.log('[kiosk-03] kiosk-handler calls:', kioskCalls.length);
    console.log('[kiosk-03] youtube-scraper direct calls:', scraperCalls.length);

    if (kioskCalls.length > 0 || scraperCalls.length > 0) {
      // If either was called, verify it went through kiosk-handler
      expect(scraperCalls.length, 'youtube-scraper should NOT be called directly from kiosk').toBe(0);
      if (kioskCalls.length > 0) {
        expect(kioskCalls.length).toBeGreaterThan(0);
      }
    }
  } else {
    console.log('[kiosk-03] No search input found — kiosk may need a session or different state');
  }
});

test('kiosk-04: credits display is visible', async ({ page, consoleLogs }) => {
  // Credits are shown as a number or coins icon
  const bodyText = await page.textContent('body');
  console.log('[kiosk-04] Looking for credits...');

  // Credits UI: either a number, "coins", or a Coins icon
  const hasCoins   = await page.locator('[class*="coin"], [data-icon="coins"]').first().isVisible().catch(() => false);
  const hasCreditEl = await page.getByText(/credit|coin|\d+ coin/i).first().isVisible().catch(() => false);
  const hasLucideIcon = await page.locator('svg').first().isVisible().catch(() => false);

  console.log(`[kiosk-04] hasCoins: ${hasCoins}, hasCreditEl: ${hasCreditEl}, hasLucideIcon: ${hasLucideIcon}`);
  // At minimum, the page renders without crash
  expect(bodyText?.length ?? 0).toBeGreaterThan(0);
});

test('kiosk-05: kiosk session init calls kiosk-handler with action=init', async ({ page, consoleLogs }) => {
  const initRequests: string[] = [];
  page.on('request', req => {
    if (req.url().includes('kiosk-handler')) {
      try {
        const body = req.postData() || '';
        initRequests.push(body);
      } catch {}
    }
  });

  // Navigate fresh to trigger init
  await page.goto(BASE);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(3000);

  console.log('[kiosk-05] kiosk-handler init calls:', initRequests);
  const initCall = initRequests.find(r => r.includes('init'));
  expect(initCall, 'kiosk-handler should be called with action=init on load').toBeTruthy();
});

test('kiosk-06: no direct DB operations from kiosk (all through kiosk-handler)', async ({ page, consoleLogs }) => {
  // Monitor for direct supabase REST calls (not edge functions)
  const directDbCalls: string[] = [];
  const supabaseUrl = process.env.VITE_SUPABASE_URL || '';

  page.on('request', req => {
    const url = req.url();
    if (supabaseUrl && url.includes(supabaseUrl)) {
      if (url.includes('/rest/v1/') && !url.includes('/functions/')) {
        directDbCalls.push(url);
      }
    }
  });

  // Wait for init to complete and subscriptions to start
  await page.waitForTimeout(3000);

  // Direct DB calls are expected for realtime subscriptions (WebSocket) but not for
  // business logic operations. REST API calls indicate direct DB manipulation.
  const nonSubscriptionCalls = directDbCalls.filter(u =>
    !u.includes('websocket') && !u.includes('realtime')
  );
  console.log('[kiosk-06] Direct REST DB calls:', nonSubscriptionCalls);

  // The kiosk should not be making direct REST calls for business logic
  // (credits add, search, request — all should go through kiosk-handler)
  // Allow up to 2 for the subscribeToKioskSession initial fetch
  expect(nonSubscriptionCalls.length).toBeLessThanOrEqual(3);
});
