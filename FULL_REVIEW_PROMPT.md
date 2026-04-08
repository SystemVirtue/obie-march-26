# Obie Jukebox — Full Codebase Review System Prompt

Use this prompt to initiate a full review session with Claude Code. Paste it as your opening message, or use it as a CLAUDE.md system-level context block.

---

## SYSTEM PROMPT

You are performing a **comprehensive code and schema audit** of the **Obie Jukebox v2** application. Your goal is to identify everything that should be edited, improved, streamlined, or removed — producing a prioritised list of actionable findings with file paths, line numbers, and specific recommendations.

### What this app is

A server-first real-time jukebox system. Three React+Vite frontends share a Supabase backend (PostgreSQL + Edge Functions + Realtime). The system has evolved rapidly through ~57 migrations and has accumulated technical debt, inconsistencies, and dead code.

**Apps:**
- `web/admin/` — Admin console: queue control, playlist curation, settings, real-time logs
- `web/player/` — Player display: YouTube/Cloudflare video playback, heartbeat, priority/slave logic
- `web/kiosk/` — Public song-request interface: coin/credit system, search, priority queue
- `web/shared/` — Shared Supabase client, types, utilities

**Backend:**
- `supabase/migrations/` — 57 SQL migrations (0001 through 20260409000001)
- `supabase/functions/` — 7 Edge Functions: `queue-manager`, `player-control`, `kiosk-handler`, `playlist-manager`, `radio-generator`, `youtube-scraper`, `download-video`, `r2-sync`

**Key architectural patterns:**
- All queue mutations go through Edge Functions → PostgreSQL RPC functions (never direct table writes from client)
- `pg_advisory_xact_lock` serialises all queue operations
- Realtime subscriptions on `queue`, `player_status`, `player_settings` tables
- Broadcast channel for progress updates (avoids DB writes)
- Priority player mechanism: one player "owns" queue advancement; others are read-only slaves
- Idempotency guard in `queue_next(p_player_id, p_expected_media_id)` prevents double-skip

---

### Review Areas

Work through each area below. For each finding, provide:
1. **File path + line number(s)**
2. **Issue category** (bug / dead-code / inconsistency / performance / simplification / security)
3. **Description** of the problem
4. **Recommended fix** (specific, actionable)

---

#### 1. Supabase Schema & Migrations (`supabase/migrations/`)

- **Stale columns**: Does the `queue` table still have a `played_at` column? Since migration `20260409000001`, played items are DELETEd immediately — `played_at` is never set and should be dropped.
- **Schema drift**: Compare what the migrations define vs what actually exists in the live DB (use `execute_sql` to query `pg_indexes`, `pg_proc`, `information_schema.columns`).
- **Migration conflicts**: Identify any migrations that contradict each other (e.g., an index created in one migration and re-created without DROP in a later one).
- **Dead RPC functions**: Are there PostgreSQL functions in the DB that are no longer called by any Edge Function or client code? (Check `queue_skip`, `cleanup_old_queue_items`, etc.)
- **`queue_skip` function**: Currently just sets `state = 'idle'` in `player_status` — it doesn't actually advance the queue. The real advancement happens in `player-control` edge function. Is `queue_skip` still needed as an RPC, or is it dead?
- **Overloaded functions**: Were there other 1-arg/2-arg overload pairs besides `queue_next` that might have stale overloads still in the DB?
- **`played_at` column**: Check all migrations — if `played_at` is still in the schema definition but never written to, it should be dropped.
- **Unused tables**: Is `kiosk_sessions` still actively used? Are all columns in all tables actively read/written?

#### 2. Edge Functions (`supabase/functions/`)

- **Duplicate `_shared/cors.ts` files**: `kiosk-handler/functions/_shared/cors.ts`, `player-control/functions/_shared/cors.ts`, `playlist-manager/functions/_shared/cors.ts`, `youtube-scraper/functions/_shared/cors.ts` all appear to be copies of the top-level `_shared/cors.ts`. Are these needed, or are they stale artefacts from a previous directory structure?
- **Orphaned subdirectory**: `queue-manager/user_fn_syccqoextpxifmumvxqw_e6fa4b56-0243-44c5-88bb-15d457d2547c_5/_shared/cors.ts` — this looks like an auto-generated or temporary file. Should it be deleted?
- **`queue-manager` `next` action**: Calls `queue_next` without `p_expected_media_id`. Is this correct, or should it pass an idempotency key? When is this action actually used vs the `ended` action in `player-control`?
- **`player-control` skip logic**: The skip path is complex — it reads pre-update state, updates state, then conditionally calls `queue_next`. Verify there are no races between the `skip` path and the `ended` path arriving simultaneously.
- **Error responses**: `player-control` returns `{ error: 'Internal server error' }` without the actual error message. This makes debugging hard. Should it expose more detail (at least to service-role callers)?
- **`register_session` priority logic**: Checks `player_status.state = 'playing'` across ALL players — but this could race if two players start simultaneously. Is this good enough, or should it use a DB-level lock?
- **Dead functions**: Is `radio-generator` actively used? Is `download-video` still wired up? Are all 8 edge functions deployed and invoked?

#### 3. Frontend — Shared (`web/shared/`)

- **`database.types.ts` vs `types.ts`**: Two type files exist. Are they in sync? Does `database.types.ts` reflect the current schema (including `source`, `local_url`, `priority_player_id`, etc.)? Is it auto-generated or hand-maintained?
- **`supabase-client.ts`**: Check for hardcoded debounce values, magic numbers, or commented-out code. Verify the 800ms debounce is still necessary given the current architecture.
- **Unused exports**: Are all exports from `jukebox-utils.ts` and `media-utils.ts` actually imported somewhere?

#### 4. Frontend — Admin (`web/admin/`)

- **`App.tsx` state management**: Root state holds `queue`, `status`, `settings`, `isSkipping`. Are there stale state fields that are no longer used?
- **Realtime subscription handling**: Does the admin app handle the case where `queue_next` DELETEs items (rather than marking played_at)? The old architecture expected played items to stay in the queue — ensure nothing in the admin still filters by `played_at IS NULL`.
- **`QueuePanel.tsx`**: Does drag-reorder still work correctly with the non-partial unique index? The `queue_reorder` RPC does a two-phase update — verify the edge function is calling the right variant.
- **`ScriptsPanel.tsx`**: What is this? Is it production-ready or a development tool that shouldn't be in the production build?
- **`ServerPanel.tsx`**: Calls `get_server_metrics` RPC. Verify this RPC handles missing `pg_stat_statements` gracefully (migration `20260404000001` added the fallback — confirm it's applied).

#### 5. Frontend — Player (`web/player/`)

- **`App.tsx`**: This is the most critical file. Review the full playback state machine:
  - Does it correctly handle `state: loading → playing → idle` transitions?
  - Does it send `action: 'ended'` with `current_media_id` for idempotency?
  - Does it handle `source: 'cloudflare'` vs `source: 'youtube'` correctly?
  - Are there any debounce or setTimeout patterns that could cause race conditions?
  - Does the Realtime polling fallback (for rate-limit drops) still work?
- **`usePlayerHeartbeat.ts`**: Sends heartbeat every 30s. Confirm it correctly handles the priority/slave distinction and doesn't call `queue_next` itself.
- **YouTube iframe integration (`utils/youtube.ts`, `utils/ytm.ts`)**: Are there stale event listeners? Are errors from YouTube API (e.g., video unavailable) properly surfaced to trigger a skip?

#### 6. Frontend — Kiosk (`web/kiosk/`)

- **`useKioskSession.ts`**: Verify credit/freeplay mode works correctly after the coin denomination migration (`20260319000001`).
- **`useCoinAcceptor.ts`**: Is the virtual coin button still present? Is it protected from being shown in production?
- **Queue marquee**: Does `QueueMarquee.tsx` still filter correctly now that played items are deleted (not marked)?

#### 7. RLS Policies

- Check for any remaining duplicate permissive policies (migrations `20260328000002` and `20260328000003` consolidated many, but verify none were missed).
- Verify anon users can read `player_status`, `players`, `media_items`, `playlists` but cannot write.
- Verify `queue` table policies: who can insert/delete? Edge Functions use service role (bypasses RLS), but is there any direct client access that needs restricting?
- Check the `r2_files` table — is it publicly readable? Should it be?

#### 8. General Code Quality

- **Dead imports**: Scan all `.ts`/`.tsx` files for unused imports.
- **`console.log` / debug output**: Identify any `console.log` statements that should be removed or converted to proper logging before production.
- **TODO/FIXME comments**: List any outstanding TODO or FIXME comments in the codebase.
- **TypeScript `any` types**: Find uses of `any` that should be properly typed, especially in edge function handlers.
- **Magic numbers/strings**: Identify hardcoded values (timeouts, delays, UUIDs, etc.) that should be constants or config.
- **Inconsistent error handling**: Some edge functions throw raw errors; others catch and return structured responses. Standardise.

---

### Deliverable

Produce a **prioritised findings report** organised as:

**P0 — Bugs / Data integrity risks** (fix immediately)
**P1 — Correctness issues** (fix before next release)
**P2 — Dead code / cleanup** (safe to remove)
**P3 — Improvements / simplifications** (worth doing, not urgent)

For each finding include: file path, line numbers, category, description, recommended fix.

After listing findings, provide a **suggested execution order** for implementing the fixes, grouping related changes (e.g., "drop `played_at` column — do this after verifying no client code reads it").

---

### Key files to read first (suggested order)

1. `supabase/migrations/20260409000001_fix_queue_next_delete_based.sql` — most recent migration, anchors current DB state
2. `web/player/src/App.tsx` — core playback state machine
3. `supabase/functions/player-control/index.ts` — queue advancement logic
4. `supabase/functions/queue-manager/index.ts` — queue mutation operations
5. `web/shared/supabase-client.ts` — shared types and client
6. `supabase/migrations/0001_initial_schema.sql` — baseline schema (then skim forward)
7. `web/admin/src/App.tsx` — admin state management
8. `web/shared/database.types.ts` — check for schema drift

---

### Known issues resolved (don't re-report these)

- `queue_next` double-skip: fixed by idempotency guard (`p_expected_media_id`)
- Queue not advancing: fixed by `20260409000001` (DELETE-based queue_next)
- Premature video skips, persistent pauses: fixed in commit `9fab564`
- REST polling fallback for Realtime rate-limit drops: fixed in `6f179f5`
- Race condition causing indefinite pause: fixed in `e9e3351`

---

*Generated: 2026-04-09 — reflects DB state after migration `20260409000001_fix_queue_next_delete_based`*
