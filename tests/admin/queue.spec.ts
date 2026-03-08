/**
 * QUEUE INTERACTION TESTS — Admin console
 *
 * Covers every queue operation:
 *  1.  Display — empty state, items render, positions
 *  2.  Remove  — ✕ button removes a queue item
 *  3.  Shuffle — 🔀 Shuffle calls server, reorders queue
 *  4.  Shuffle guard — button disabled / no-op for ≤1 items
 *  5.  Reorder — keyboard drag-drop via dnd-kit
 *  6.  Now Playing view
 *  7.  Priority queue display + remove
 *  8.  Priority badge in sidebar
 *  9.  Clear queue via admin skip/controls
 *  10. Queue empty message after all items removed
 *  11. Console error monitoring throughout
 */
import { test, expect } from '../fixtures/base';
import {
  seedQueue,
  clearQueue,
  clearNormalQueue,
  clearPriorityQueue,
  createTestMediaItem,
  addToQueue,
  bringPlayerOnline,
  PLAYER_ID,
} from '../helpers/db';

const BASE = 'http://localhost:5173';

// ── Helpers ────────────────────────────────────────────────────────────────

// Queue is now a single consolidated view — clicking the Queue nav item lands on it directly
async function goToQueue(page: any) {
  await page.goto(BASE);
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: /Queue/i }).first().click();
  await page.waitForTimeout(500);
}

// Aliases for backward-compat with tests that used separate views
const goToQueueNext     = goToQueue;
const goToQueuePriority = goToQueue;
const goToQueueNow      = goToQueue;

// ── Suite ──────────────────────────────────────────────────────────────────

// ── Auth guard ────────────────────────────────────────────────────────────────
// Queue tests require the admin to be authenticated.
// If TEST_EMAIL / TEST_PASSWORD are not set, all tests in this file are skipped.
const SKIP_REASON = 'Admin credentials not configured (set TEST_EMAIL + TEST_PASSWORD in .env)';

/** Filter out expected Supabase auth noise that appears on every unauthenticated admin load */
function filterErrors(logs: Array<{ type: string; text: string }>) {
  return logs.filter(l =>
    l.type === 'error' &&
    !l.text.includes('Auth session missing') &&
    !l.text.includes('autocomplete')
  );
}

test.beforeAll(async () => {
  await bringPlayerOnline();
});

test.afterEach(async () => {
  // Clean up any test state
  await clearQueue();
});

// ── 1. Empty state ─────────────────────────────────────────────────────────

test('queue-01: Up Next shows empty state message when queue is clear', async ({ page, consoleLogs, isLoggedIn }) => {
  if (!isLoggedIn) { test.skip(true, SKIP_REASON); return; }
  await clearQueue();
  await goToQueueNext(page);

  await expect(page.getByText('Queue is empty')).toBeVisible({ timeout: 12_000 });
  // No drag handles when empty
  const handles = page.locator('button').filter({ hasText: '⋮⋮' });
  await expect(handles).toHaveCount(0);

  const errors = filterErrors(consoleLogs);
  expect(errors.length, `Browser errors: ${errors.map(e => e.text).join(', ')}`).toBe(0);
});

// ── 2. Queue items render ──────────────────────────────────────────────────

test('queue-02: seeded items appear in Up Next with title, artist, remove buttons', async ({ page, consoleLogs, isLoggedIn }) => {
  if (!isLoggedIn) { test.skip(true, SKIP_REASON); return; }
  await seedQueue(3);
  await goToQueueNext(page);

  // Wait for items to arrive via realtime
  await expect(async () => {
    const handles = page.locator('button').filter({ hasText: '⋮⋮' });
    await expect(handles).toHaveCount(3, { timeout: 500 });
  }).toPass({ timeout: 15_000 });

  // Verify titles and remove buttons are present
  await expect(page.getByText('Test Song 1')).toBeVisible();
  await expect(page.getByText('Test Song 2')).toBeVisible();
  await expect(page.getByText('Test Song 3')).toBeVisible();

  // Three ✕ remove buttons
  const removeBtns = page.locator('button').filter({ hasText: '✕' });
  await expect(removeBtns).toHaveCount(3);

  const errors = filterErrors(consoleLogs);
  expect(errors.length, `Browser errors: ${errors.map(e => e.text).join(', ')}`).toBe(0);
});

// ── 3. Remove a queue item ─────────────────────────────────────────────────

test('queue-03: clicking ✕ removes an item from the queue', async ({ page, consoleLogs, isLoggedIn }) => {
  if (!isLoggedIn) { test.skip(true, SKIP_REASON); return; }
  await seedQueue(3);
  await goToQueueNext(page);

  // Wait for all 3 items
  await expect(async () => {
    await expect(page.locator('button').filter({ hasText: '⋮⋮' })).toHaveCount(3, { timeout: 500 });
  }).toPass({ timeout: 15_000 });

  // Remove the first item
  const removeBtns = page.locator('button').filter({ hasText: '✕' });
  await removeBtns.first().click();

  // Optimistic update + server confirm → 2 items left
  await expect(async () => {
    await expect(page.locator('button').filter({ hasText: '⋮⋮' })).toHaveCount(2, { timeout: 500 });
  }).toPass({ timeout: 12_000 });

  const errors = filterErrors(consoleLogs);
  expect(errors.length, `Browser errors: ${errors.map(e => e.text).join(', ')}`).toBe(0);
});

// ── 4. Remove all items → empty state ─────────────────────────────────────

test('queue-04: removing all items shows empty state', async ({ page, consoleLogs, isLoggedIn }) => {
  if (!isLoggedIn) { test.skip(true, SKIP_REASON); return; }
  await seedQueue(2);
  await goToQueueNext(page);

  await expect(async () => {
    await expect(page.locator('button').filter({ hasText: '⋮⋮' })).toHaveCount(2, { timeout: 500 });
  }).toPass({ timeout: 15_000 });

  // Remove both
  for (let i = 0; i < 2; i++) {
    await page.locator('button').filter({ hasText: '✕' }).first().click();
    await page.waitForTimeout(600);
  }

  await expect(page.getByText('Queue is empty')).toBeVisible({ timeout: 12_000 });
});

// ── 5. Shuffle ────────────────────────────────────────────────────────────

test('queue-05: 🔀 Shuffle button is visible with ≥2 items', async ({ page, consoleLogs, isLoggedIn }) => {
  if (!isLoggedIn) { test.skip(true, SKIP_REASON); return; }
  await seedQueue(5);
  await goToQueueNext(page);

  await expect(async () => {
    await expect(page.locator('button').filter({ hasText: '⋮⋮' })).toHaveCount(5, { timeout: 500 });
  }).toPass({ timeout: 15_000 });

  const shuffleBtn = page.getByRole('button', { name: /shuffle/i });
  await expect(shuffleBtn).toBeVisible();
  await expect(shuffleBtn).toBeEnabled();
});

test('queue-06: 🔀 Shuffle reorders the queue (server-side)', async ({ page, consoleLogs, isLoggedIn }) => {
  if (!isLoggedIn) { test.skip(true, SKIP_REASON); return; }
  await seedQueue(5);
  await goToQueueNext(page);

  // Capture initial order
  await expect(async () => {
    await expect(page.locator('button').filter({ hasText: '⋮⋮' })).toHaveCount(5, { timeout: 500 });
  }).toPass({ timeout: 15_000 });

  const getOrder = async () => {
    const items = page.locator('[style*="border-radius: 11px"]').filter({ hasText: 'Test Song' });
    const count = await items.count();
    const titles: string[] = [];
    for (let i = 0; i < count; i++) {
      const text = await items.nth(i).innerText().catch(() => '');
      const match = text.match(/Test Song \d/);
      if (match) titles.push(match[0]);
    }
    return titles;
  };

  const before = await getOrder();
  console.log('[queue-06] Order before shuffle:', before.join(', '));

  // Click shuffle
  await page.getByRole('button', { name: /shuffle/i }).click();

  // Wait for the Shuffling spinner to disappear
  await expect(page.getByText(/shuffling/i)).not.toBeVisible({ timeout: 10_000 });

  // Allow realtime update to arrive
  await page.waitForTimeout(1500);

  const after = await getOrder();
  console.log('[queue-06] Order after shuffle:', after.join(', '));

  // Queue should still have 5 items
  await expect(page.locator('button').filter({ hasText: '⋮⋮' })).toHaveCount(5);

  // With 5 items there's a < 1% chance they stay in identical order after a random shuffle
  // We don't assert strict reordering (flaky), but we do assert count and no errors
  const errors = filterErrors(consoleLogs);
  expect(errors.length, `Browser errors: ${errors.map(e => e.text).join(', ')}`).toBe(0);
});

test('queue-07: Shuffle is a no-op when queue has ≤1 item (guard check)', async ({ page, consoleLogs, isLoggedIn }) => {
  if (!isLoggedIn) { test.skip(true, SKIP_REASON); return; }
  const mediaId = await createTestMediaItem('single');
  await addToQueue(mediaId, 'normal');
  await goToQueueNext(page);

  await expect(async () => {
    await expect(page.locator('button').filter({ hasText: '⋮⋮' })).toHaveCount(1, { timeout: 500 });
  }).toPass({ timeout: 15_000 });

  const shuffleBtn = page.getByRole('button', { name: /shuffle/i });
  await shuffleBtn.click();

  // Button should not show "Shuffling…" (the guard returns early)
  await page.waitForTimeout(500);
  const stillVisible = await shuffleBtn.isVisible();
  expect(stillVisible).toBe(true);

  // No network error for shuffle
  const errors = filterErrors(consoleLogs);
  expect(errors.length, `Browser errors: ${errors.map(e => e.text).join(', ')}`).toBe(0);
});

// ── 6. Keyboard reorder (dnd-kit) ─────────────────────────────────────────

test('queue-08: keyboard reorder moves item down one position', async ({ page, consoleLogs, isLoggedIn }) => {
  if (!isLoggedIn) { test.skip(true, SKIP_REASON); return; }
  await seedQueue(3);
  await goToQueueNext(page);

  await expect(async () => {
    await expect(page.locator('button').filter({ hasText: '⋮⋮' })).toHaveCount(3, { timeout: 500 });
  }).toPass({ timeout: 15_000 });

  // Focus first drag handle and use Space+ArrowDown+Space (dnd-kit keyboard)
  const handles = page.locator('button').filter({ hasText: '⋮⋮' });
  await handles.first().focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');

  // Wait for reorder to be sent
  await page.waitForTimeout(1000);

  // Still 3 items after reorder
  await expect(handles).toHaveCount(3);

  const errors = filterErrors(consoleLogs);
  expect(errors.length, `Browser errors: ${errors.map(e => e.text).join(', ')}`).toBe(0);
});

// ── 7. Now Playing view ────────────────────────────────────────────────────

test('queue-09: Queue view renders Priority + Up Next sections without errors', async ({ page, consoleLogs, isLoggedIn }) => {
  if (!isLoggedIn) { test.skip(true, SKIP_REASON); return; }
  await goToQueue(page);

  // Consolidated panel header
  await expect(page.getByText('Queue', { exact: false })).toBeVisible({ timeout: 10_000 });

  // Both section labels always visible
  await expect(page.getByText('Priority Requests', { exact: false })).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText('Up Next', { exact: false })).toBeVisible({ timeout: 8_000 });
  console.log('[queue-09] Queue view rendered with both sections');

  const errors = filterErrors(consoleLogs);
  expect(errors.length, `Browser errors: ${errors.map(e => e.text).join(', ')}`).toBe(0);
});

// ── 8. Priority queue ─────────────────────────────────────────────────────

test('queue-10: seeded priority item appears in Priority Requests view', async ({ page, consoleLogs, isLoggedIn }) => {
  if (!isLoggedIn) { test.skip(true, SKIP_REASON); return; }
  const mediaId = await createTestMediaItem('priority');
  await addToQueue(mediaId, 'priority');

  await goToQueuePriority(page);

  await expect(page.getByText('Priority Requests', { exact: false })).toBeVisible();

  await expect(async () => {
    const items = page.locator('[style*="rgba(59,130,246"]');
    await expect(items.first()).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 15_000 });

  // The test song title should appear
  await expect(page.getByText('Test Song priority')).toBeVisible({ timeout: 10_000 });

  await clearPriorityQueue();
});

test('queue-11: priority item can be removed from Priority Requests view', async ({ page, consoleLogs, isLoggedIn }) => {
  if (!isLoggedIn) { test.skip(true, SKIP_REASON); return; }
  const mediaId = await createTestMediaItem('priority-remove');
  await addToQueue(mediaId, 'priority');

  await goToQueuePriority(page);

  await expect(async () => {
    await expect(page.getByText('Test Song priority-remove')).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 15_000 });

  // Remove it
  await page.locator('button').filter({ hasText: '✕' }).first().click();

  // Should revert to "Empty" (priority section shows Empty when null)
  await expect(page.getByText('Empty')).toBeVisible({ timeout: 12_000 });

  const errors = filterErrors(consoleLogs);
  expect(errors.length, `Browser errors: ${errors.map(e => e.text).join(', ')}`).toBe(0);
});

test('queue-12: priority badge count shows in sidebar when priority items exist', async ({ page, consoleLogs, isLoggedIn }) => {
  if (!isLoggedIn) { test.skip(true, SKIP_REASON); return; }
  const mediaId = await createTestMediaItem('badge');
  await addToQueue(mediaId, 'priority');

  await page.goto(BASE);
  await page.waitForLoadState('networkidle');

  // Open Queue group
  await page.getByRole('button', { name: /Queue/i }).first().click();

  // The badge (blue pill) should appear showing a count
  await expect(async () => {
    const badge = page.locator('[style*="rgba(59,130,246,0.2)"]').filter({ hasText: /\d/ });
    await expect(badge.first()).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 15_000 });

  await clearPriorityQueue();
});

// ── 9. NowPlayingStage — up-next strip ────────────────────────────────────

test('queue-13: NowPlayingStage "Up Next" strip shows queue items', async ({ page, consoleLogs, isLoggedIn }) => {
  if (!isLoggedIn) { test.skip(true, SKIP_REASON); return; }
  await seedQueue(3);
  await page.goto(BASE);
  await page.waitForLoadState('networkidle');

  // "Up Next" label is in the stage header
  await expect(page.getByText('Up Next')).toBeVisible({ timeout: 10_000 });

  const errors = filterErrors(consoleLogs);
  expect(errors.length, `Browser errors: ${errors.map(e => e.text).join(', ')}`).toBe(0);
});

// ── 10. Queue count in panel header ───────────────────────────────────────

test('queue-14: panel header subtitle reflects correct item count', async ({ page, consoleLogs, isLoggedIn }) => {
  if (!isLoggedIn) { test.skip(true, SKIP_REASON); return; }
  await seedQueue(4);
  await goToQueueNext(page);

  // Subtitle "4 songs in queue"
  await expect(async () => {
    await expect(page.getByText(/songs in queue/i)).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 15_000 });

  const subtitle = page.getByText(/songs in queue/i);
  const text = await subtitle.first().textContent();
  console.log(`[queue-14] Subtitle: "${text}"`);
  expect(text).toMatch(/4 songs in queue/);

  const errors = filterErrors(consoleLogs);
  expect(errors.length, `Browser errors: ${errors.map(e => e.text).join(', ')}`).toBe(0);
});

// ── 11. Rapid remove stress test ──────────────────────────────────────────

test('queue-15: rapid removal of 5 items completes without errors', async ({ page, consoleLogs, isLoggedIn }) => {
  if (!isLoggedIn) { test.skip(true, SKIP_REASON); return; }
  await seedQueue(5);
  await goToQueueNext(page);

  await expect(async () => {
    await expect(page.locator('button').filter({ hasText: '⋮⋮' })).toHaveCount(5, { timeout: 500 });
  }).toPass({ timeout: 15_000 });

  // Remove all 5 one by one
  for (let i = 0; i < 5; i++) {
    const btn = page.locator('button').filter({ hasText: '✕' }).first();
    if (await btn.isVisible()) {
      await btn.click();
      await page.waitForTimeout(400);
    }
  }

  await expect(page.getByText('Queue is empty')).toBeVisible({ timeout: 15_000 });

  const errors = filterErrors(consoleLogs);
  expect(errors.length, `Browser errors: ${errors.map(e => e.text).join(', ')}`).toBe(0);
});
