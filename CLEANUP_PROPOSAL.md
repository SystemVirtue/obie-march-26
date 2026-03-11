# Obie Jukebox v2 — Production Cleanup Proposal

> **Date:** March 11, 2026  
> **Branch:** To be executed on `cleanup/production-ready`  
> **Goal:** Simplify, streamline, de-clutter, and make production-ready — same UI, same functionality

---

## Executive Summary

The codebase is **functional and well-architected** at the system level — Supabase Realtime, Edge Functions, three-app model — but has accumulated significant development artifacts, dead code, and monolithic components. This proposal targets a **~40% reduction in repository clutter** and a restructured codebase that's maintainable and production-ready.

| Metric | Before | After (Target) |
|--------|--------|----------------|
| Total source LOC | ~66,900 | ~52,000 |
| Root clutter files | 32 | 8 |
| Admin App.tsx | 1,988 lines | ~300 lines (+ extracted components) |
| Player App.tsx | 1,709 lines | ~400 lines (+ extracted hooks) |
| Kiosk App.tsx | 715 lines | ~350 lines (+ extracted hooks) |
| Backup/reference files | 19+ files (~310KB) | 0 |
| Copy-pasted functions | 3× slug, 3× media creation | 1× shared |
| Edge function shared code | 1 file (cors.ts) | 5 files (cors, client, auth, response, validation) |
| Migration backups | 16 files | 0 (git history preserves) |

---

## Phase 1: Delete Dead Code & Clutter (Low Risk)

### 1.1 Root-Level Cleanup

**DELETE — Debug/verification scripts (artifacts from past debugging sessions):**
- `check-queue.js` — one-time queue debug inspector
- `final-proof.js` — queue fix verification
- `simple-queue-test.js` — browser-based queue test
- `test-queue-fix.js` — debounce timing test
- `verify-fix.js` — code inspection script

**DELETE — Diagnostic SQL (not migrations, not needed in production):**
- `check_rls.sql` — RLS status checker
- `debug_kiosk.sql` — kiosk troubleshooting
- `enable_rls.sql` — manual RLS enablement
- `initialize-production.sql` — empty/unimplemented

**DELETE — Reference files (original V1 code, preserved in git history):**
- `REFERENCE_AdminSettingsTab.jsx` (44KB)
- `REFERENCE_setup_and_user_guide.md` (34KB)
- `REFERENCE-ObieAdminConsole.html` (84KB)
- `REFERENCE-ObieAdminConsole.jsx` (61KB)

**DELETE — Import logs and one-time scripts:**
- `import-log.txt` — historical import output
- `import-to-production.sh` — empty/unimplemented
- `retry-failed-playlists.sh` — hardcoded failed playlist IDs, one-time use

**DELETE — Obsolete/redundant docs:**
- `development_read_me.md` — superseded by `DEVELOPMENT.md`
- `system_overview_initial_snapshot.md` — point-in-time snapshot
- `player_log_analysis_27feb2026.md` — debugging session notes
- `PLAN-cloudflare-v1.md` — historical planning doc (implemented)
- `RENDER_DEPLOYMENT.md` + `render.yaml` — Render.com deployment (not used; using Supabase)

**KEEP at root:**
- `README.md`, `DEVELOPMENT.md`, `DEPLOYMENT.md`, `CHANGELOG.md`, `LICENSE`
- `PROJECT_SUMMARY.md`, `QUICK_REFERENCE.md`, `QUEUE_MANAGEMENT.md`
- `PLAYER_AUTOPLAY.md`, `YOUTUBE_SETUP.md`, `IMPORT_RESULTS.md`
- `package.json`, `playwright.config.ts`, `setup.sh`
- `import-all-playlists.sh`, `import-single-playlist.sh`, `populate-playlist.sh`

**Impact:** Remove ~15 dead files, ~225KB of reference code from root.

---

### 1.2 Admin App Cleanup

**DELETE — Backup/dead files:**
- `web/admin/src/App-OLD.tsx` — 27KB, old iteration with mock data
- `web/admin/src/App-Claude.tsx` — 0 bytes, empty placeholder
- `web/admin/ObieAdminConsole.jsx` (61KB) — V1 admin component
- `web/admin/ObieAdminConsole.html` (84KB) — V1 admin HTML
- `web/admin/AdminSettingsTab.jsx` (44KB) — V1 settings fragment
- `web/admin/setup_and_user_guide.md` — duplicate of root docs

**DELETE entire directory:**
- `web/admin_original_copy/` — 19 files, complete pre-refactor snapshot

**Impact:** Remove ~216KB of dead code from admin app alone.

---

### 1.3 Migration Backup Cleanup

**DELETE entire directory:**
- `supabase/migrations_backup/` — 16 files, exact duplicates of early migrations already in `supabase/migrations/`

**Impact:** Remove duplicate migration history (git preserves the real history).

---

### 1.4 Build Artifact Cleanup

**DELETE directories** (regenerated on build/test):
- `playwright-report/`
- `test-results/`

**Add to `.gitignore`** if not already:
```
playwright-report/
test-results/
```

---

## Phase 2: Extract Shared Utilities (Medium Risk)

### 2.1 Jukebox Slug Utilities → `web/shared/jukebox-utils.ts`

Currently copy-pasted **identically** in all 3 apps:
```
normalizeJukeboxSlug()    — admin L63, player L23, kiosk L29
getPathJukeboxSlug()      — admin L74, player L34, kiosk L40
```

**Create:** `web/shared/jukebox-utils.ts`
```typescript
export function normalizeJukeboxSlug(raw: string | null | undefined): string { ... }
export function getPathJukeboxSlug(): string { ... }
```

**Update:** All 3 apps to `import { normalizeJukeboxSlug, getPathJukeboxSlug } from '@shared/jukebox-utils'`

---

### 2.2 Clean Up `web/admin/src/lib/api.ts`

This file exports **21 functions**. Most are thin wrappers around `callQueueManager()` / `callPlayerControl()` / `callPlaylistManager()` which themselves are thin wrappers around `supabase.functions.invoke()`.

**Current pattern (3 layers of indirection):**
```
App.tsx → addToQueue() → callQueueManager('add', ...) → supabase.functions.invoke('queue-manager', ...)
```

**Many of these wrappers are never imported.** Audit and remove unused exports, then consolidate the remainder.

**Recommendation:** Keep only the actually-used functions. The generic `callQueueManager`/`callPlayerControl`/`callPlaylistManager` wrappers are sufficient — the specific wrappers add no value if unused.

---

### 2.3 Consolidate Preferences Hook

Two implementations exist:
- `web/admin/src/hooks/useAdminPrefs.ts` (~100 lines) — standalone hook file
- `web/admin/src/App.tsx` L154-177 — `usePrefs()` inline duplicate

**Action:** Use `useAdminPrefs.ts` as the single source, delete the inline `usePrefs()`.

---

## Phase 3: Component Extraction — Admin App (Medium Risk)

The admin `App.tsx` at **1,988 lines** contains 16 inline components. Extract them into a component directory while preserving the exact same UI and behavior.

### Target Structure:
```
web/admin/src/
├── App.tsx                          (~300 lines — root, routing, state)
├── components/
│   ├── ui/
│   │   ├── Spinner.tsx
│   │   ├── Toggle.tsx
│   │   ├── Btn.tsx
│   │   ├── SaveBtn.tsx
│   │   └── PanelHeader.tsx
│   ├── LoginForm.tsx
│   ├── Sidebar.tsx
│   ├── NowPlayingStage.tsx
│   ├── QueuePanel.tsx
│   │   └── SortableQueueItem.tsx
│   ├── PlaylistsPanel.tsx
│   ├── SettingsPanel.tsx
│   │   └── SettingsRow.tsx
│   ├── ConsolePrefsPanel.tsx
│   ├── LogsPanel.tsx
│   └── ScriptsPanel.tsx
│       └── ScriptCard.tsx
├── hooks/
│   └── useAdminPrefs.ts
├── lib/
│   ├── api.ts                      (cleaned up)
│   └── supabaseClient.ts
├── index.css
└── main.tsx
```

**Rules:**
- Zero UI changes — extract only, don't redesign
- Props flow down from App.tsx state
- Each component gets exactly the code it currently contains inline
- Types shared via a local `types.ts` or imported from `@shared/types`

---

## Phase 4: Component Extraction — Player & Kiosk (Medium Risk)

### 4.1 Player App — Extract Custom Hooks

The player's `App.tsx` (1,709 lines) is complex due to multiple media backends (YouTube iframe, YTM Desktop, local files). Rather than splitting into components (it's mostly one view), extract logic into hooks:

```
web/player/src/
├── App.tsx                          (~400 lines — rendering + orchestration)
├── hooks/
│   ├── usePlayerIdentity.ts         (slug resolution, player registration)
│   ├── useYouTubePlayer.ts          (iframe API, playback controls)
│   ├── useYTMDesktop.ts             (socket.io YTM Desktop integration)
│   ├── useQueueSubscription.ts      (realtime queue subscription + debounce)
│   ├── usePlayerHeartbeat.ts        (heartbeat, status reporting)
│   └── useKaraokeLyrics.ts          (lyrics fetching for karaoke mode)
├── lib/
│   └── supabaseClient.ts
├── index.css
└── main.tsx
```

### 4.2 Kiosk App — Extract Serial Port & Session Hooks

```
web/kiosk/src/
├── App.tsx                          (~350 lines)
├── hooks/
│   ├── useKioskSession.ts           (session init, slug resolution)
│   └── useCoinAcceptor.ts           (serial port connection, credit handling)
├── components/                      (keep existing)
├── lib/
│   └── supabaseClient.ts
├── index.css
└── main.tsx
```

---

## Phase 5: Edge Function Consolidation (Medium-High Risk)

### 5.1 Expand Shared Module

Currently `_shared/` has only `cors.ts` (10 lines). Extract repeated patterns:

```
supabase/functions/_shared/
├── cors.ts                          (existing)
├── supabase-client.ts               (createServiceRoleClient — duplicated 8×)
├── response.ts                      (errorResponse, successResponse — standardize format)
├── validation.ts                    (validateUUID, validateYouTubeUrl, validateRequired)
└── youtube.ts                       (extractVideoId, extractPlaylistId — duplicated 2×)
```

### 5.2 Remove or Complete Stub Function

`queue-manager-update-admin-bypass` is a **61-line stub** with:
- Unused import (`decode` from base64)
- Placeholder implementation ("Remove executed..." message)

**Decision needed:** Complete the implementation, or delete the function and add bypass logic to `queue-manager`.

### 5.3 Standardize Error Handling

Currently inconsistent:
- `queue-manager`: Generic catch-all messages
- `player-control`: Exposes `error.message` directly (leaks internals)
- `kiosk-handler`: Full error details in responses

**Standardize to:**
```typescript
// _shared/response.ts
export function errorResponse(message: string, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}
export function successResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}
```

### 5.4 Fix N+1 Query in playlist-manager

The scrape action fetches media items **one at a time** after batch insert:
```typescript
for (const video of videos) {
  const { data: fullItem } = await supabase.from('media_items')
    .select('*').eq('id', mediaId).maybeSingle();  // ← N+1
}
```
**Fix:** Collect all IDs, batch-fetch with `.in('id', mediaIds)`.

---

## Phase 6: Type Safety Hardening (Low Risk)

### 6.1 Remove `any` Casts in Admin App

36 `eslint-disable` comments bypass type checking. Key targets:
- `(item as any).media_item as any` — define `QueueItemWithMedia` type
- `set(k: keyof PlayerSettings, v: any)` — use discriminated union
- Supabase query results — use generated types from `supabase gen types`

### 6.2 Generate Supabase Types

```bash
supabase gen types typescript --project-id fcabzrkcsfjimpxxnvco > web/shared/database.types.ts
```

Use generated types to replace manual interface definitions and `any` casts.

---

## Phase 7: Production Hardening (Low Risk)

### 7.1 Security Fixes

| Issue | Location | Fix |
|-------|----------|-----|
| No auth on r2-sync | `r2-sync/index.ts` | Add service-role key verification |
| Error message leaking | `player-control/index.ts` | Return generic messages, log details server-side |
| Unvalidated array contents in reorder | `queue-manager/index.ts` | Validate queue_ids as UUIDs before RPC |
| YouTube URL not validated | `kiosk-handler/index.ts` | Validate URL format before forwarding to scraper |

### 7.2 Console.log Cleanup

Remove debug `console.log` statements from production code paths, or gate them behind a `DEBUG` env variable:
- Admin `App.tsx` has ~15 debug logs
- Player `App.tsx` has extensive `[Player]` prefixed logs (useful — keep but gate)
- Kiosk `App.tsx` has `[Queue Callback]` debug logs

### 7.3 `.gitignore` Additions

Ensure these are ignored:
```
playwright-report/
test-results/
web/*/dist/
*.DS_Store
import-log.txt
```

---

## Execution Plan

### Recommended Branch Strategy

```bash
git checkout -b cleanup/production-ready
```

Execute phases sequentially, committing after each:

| Phase | Commit Message | Risk | Reversible |
|-------|---------------|------|------------|
| 1 | `chore: remove dead code, backups, and debug scripts` | Low | Yes (git) |
| 2 | `refactor: extract shared jukebox utils, clean API layer` | Low | Yes |
| 3 | `refactor: extract admin components from monolithic App.tsx` | Medium | Yes |
| 4 | `refactor: extract player/kiosk hooks` | Medium | Yes |
| 5 | `refactor: consolidate edge function shared code` | Medium | Yes |
| 6 | `fix: replace any casts with generated Supabase types` | Low | Yes |
| 7 | `fix: production security hardening` | Low | Yes |

### Verification After Each Phase

1. `npm run build` — all 3 apps compile
2. `npm run dev` — all 3 apps start on correct ports
3. Visual inspection — UI unchanged
4. `npx playwright test` — E2E tests pass (if Supabase available)
5. Deploy edge functions to staging — verify endpoints

---

## What This Proposal Does NOT Change

- **UI/UX**: Zero visual changes. Same layouts, colors, animations, interactions
- **Database schema**: No migrations. Schema stays as-is
- **Functionality**: No features added or removed
- **API contracts**: Edge function request/response shapes unchanged
- **Dependencies**: No library upgrades (stable, synchronized versions)
- **Architecture**: Same three-app + Supabase + Edge Functions model
- **Test suite**: Tests preserved and should pass identically

---

## Files to Delete Summary

| Category | Count | Size |
|----------|-------|------|
| Root debug scripts (.js) | 5 | ~20KB |
| Root diagnostic SQL | 4 | ~8KB |
| Root reference files (REFERENCE_*) | 4 | ~225KB |
| Root obsolete docs/scripts | 6 | ~40KB |
| Admin backup files | 6 | ~217KB |
| Admin original copy directory | 19 files | ~150KB |
| Migration backups | 16 files | ~100KB |
| **Total** | **~60 files** | **~760KB** |

---

## Ready to Execute?

If approved, I'll create the `cleanup/production-ready` branch and begin executing Phase 1 through Phase 7, committing after each phase with full build verification.
