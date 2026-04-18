# Revision Branch Deployment Checklist

**Current Status:** Revision branch has 2 commits with refactoring + hardening. Now awaiting post-0300 NZ deployment window.

## Pre-Deployment Verification (DO THIS FIRST)

### 1. Current Main Branch State
- [ ] Verify main branch is stable and not in the middle of any active deployments
- [ ] Check player and admin UIs are functioning normally
- [ ] Verify no active users are experiencing issues that would conflict with migration

### 2. Revision Branch Code Quality
- [ ] All TypeScript compiles: `npm run build` on both web/player and web/admin
- [ ] All files committed: `git log --oneline revision -5`
- [ ] No uncommitted changes: `git status`

**Expected commits on revision:**
- 8ea03f8: fix: admin toggle loop + priority player dead-master failover  
- 3bfdfcd: refactor(player): replace God Component with state machine architecture

### 3. Database Migration Safety Check
Total new migrations to apply:
1. `20260418000001_queue_position_trigger.sql` — add trigger for position resequencing
2. `20260418000002_queue_next_hardened.sql` — replace queue_next with hardened version
3. `20260418000003_heartbeat_priority_failover.sql` — clear dead master on heartbeat

All migrations:
- [ ] Use existing advisory locks (safe under load)
- [ ] Are backward compatible (no schema breaking changes)
- [ ] Are reversible (can add corresponding down migrations if needed)

## Deployment Steps (After 0300 NZ)

### Step 1: Apply Database Migrations (Production Supabase)
```bash
# Get current status
supabase migration list

# Apply new migrations (in order)
supabase db push
# OR apply individually
supabase migrations list --remote
supabase db push --remote
```

Expected: All three new migrations appear in `supabase migration list` with both Local and Remote columns showing the migration hash.

### Step 2: Deploy Updated Edge Functions

Only function that changed: `player-control`

```bash
supabase functions deploy player-control --no-verify-jwt
```

Expected: New version deployed, status ACTIVE.

Changed edge function files:
- `supabase/functions/player-control/index.ts` — added expected_state compare-and-swap
- No other edge functions changed

### Step 3: Merge Revision to Main

```bash
git checkout main
git pull origin main
git merge revision
git push origin main
```

### Step 4: Deploy Updated Web Apps

Player app:
```bash
cd web/player
npm run build
# Deploy to your hosting (Netlify/Vercel/etc)
```

Admin app: 
```bash
cd web/admin  
npm run build
# Deploy to your hosting
```

Changed files in web/player:
- `src/App.tsx` — refactored to use state machine (from 1,637 to 319 lines)
- `src/state/playbackMachine.ts` — NEW: state machine reducer
- `src/hooks/useQueueAdvance.ts` — NEW: consolidated queue advance logic
- `src/hooks/useLoadingGuard.ts` — NEW: loading timeout handler
- `src/hooks/usePlayerRealtime.ts` — NEW: realtime subscription manager
- `src/hooks/useFade.ts` — NEW: fade animation hook
- `src/hooks/usePlayerHeartbeat.ts` — MODIFIED: added auto-reclaim after failover
- `src/players/YouTubePlayer.tsx` — NEW: extracted YouTube iframe logic
- `src/players/LocalVideoPlayer.tsx` — NEW: extracted local video logic
- `src/players/YTMDesktopPlayer.tsx` — NEW: extracted YTM Desktop logic

Changed files in web/admin:
- `src/App.tsx` — MODIFIED: handlePlayPause now debounced with expected_state

## Post-Deployment Verification

### Test 1: Single Player Normal Flow
1. Open player, wait for heartbeat (should show as online)
2. Play a song, verify it advances normally
3. Skip song, verify queue advances
4. Close player — should show offline within 50 seconds

Expected: No errors in console, playback smooth, no queue stuck.

### Test 2: Two Admin Consoles Toggle
1. Open admin console in Tab A
2. Open admin console in Tab B
3. Rapidly click play/pause in both tabs
4. Expected: One wins, other gets noop response — no oscillation

Expected: Player state remains consistent, no toggle loop detected.

### Test 3: Dead Master Failover
1. Open player Tab A (becomes master)
2. Open player Tab B (becomes slave)
3. Hard-close Tab A (don't reload, just close)
4. Wait max 30 seconds
5. Tab B should auto-reclaim as master
6. Song should continue advancing

Expected: Queue progresses normally, Tab B shows as master after reclaim.

### Test 4: Queue Integrity Under Load
1. Add 100+ songs to queue
2. Play with shuffle enabled
3. Monitor for position gaps or constraint violations
4. Run for 5+ minutes

Expected: No database errors, positions stay contiguous, shuffle works.

## Rollback Plan (If Issues)

If anything breaks post-deployment:

```bash
# Revert to main
git checkout main
git reset --hard origin/main

# Rollback edge function
supabase functions deploy player-control --no-verify-jwt # (old version from git)

# Rollback DB migrations (create down migrations or use Supabase dashboard to delete last 3)
# This is why migrations use advisory locks — safe to reverse
```

## Known Risks & Mitigations

| Risk | Likelihood | Mitigation |
|------|------------|-----------|
| Players stuck in "loading" after deploy | Low | useLoadingGuard has 12s auto-recover |
| Admin clicks race | Eliminated | Compare-and-swap guard added |
| Dead master blocks queue | Eliminated | Failover migration clears dead master |
| Queue position gaps | Eliminated | Auto-resequence trigger added |
| Realtime dropped events | Low (unchanged) | 30s polling baseline unchanged |

## Sign-Off Checklist

Before considering deployment complete:

- [ ] All 3 new migrations applied successfully
- [ ] player-control edge function deployed
- [ ] Both web apps deployed
- [ ] Test 1 (single player): PASS
- [ ] Test 2 (admin toggle): PASS
- [ ] Test 3 (dead master failover): PASS
- [ ] Test 4 (queue integrity 5+ min): PASS
- [ ] No error logs in Supabase function logs
- [ ] Admin console shows all players online/offline correctly
- [ ] Queue advances between songs without manual intervention

---

**Ready to deploy?** Run through checklist above, then execute deployment steps in order after 0300 NZ time.

**Questions?** Check the individual migration files in `supabase/migrations/` for detailed comments on what each change does.
