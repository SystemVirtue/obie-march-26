# IMMEDIATE ACTION: Deploy Revision Branch Now

**You have:**
- ✅ Revision branch code ready (App.tsx refactored, state machine, hooks)
- ✅ Three critical production issues fixed (toggle loop, dead master failover, queue corruption)
- ✅ All migrations in place (001-003 + cleanup 419001)
- ✅ Full production build verified clean

**This is your step-by-step deployment script (copy and paste):**

---

## STEP 1: Verify Current Production State

```bash
cd /Users/mikeclarkin/obie-march-26

# Check which migrations are applied to your live Supabase
supabase migration list --remote

# Copy the output here for reference:
# Look for these lines (should be in Remote column):
# - 20260418000001_queue_position_trigger
# - 20260418000002_queue_next_hardened  
# - 20260418000003_heartbeat_priority_failover
# - 20260419000001_remove_reset_priority_player_flag
```

**Expected result:** If all four show in Remote column, migrations are already applied. If blank or missing, proceed to Step 2.

---

## STEP 2: Apply Pending Migrations (if needed)

Only run this if Step 1 showed blank Remote columns:

```bash
cd /Users/mikeclarkin/obie-march-26

# Apply all pending migrations
supabase db push

# Wait for completion, then verify again
supabase migration list --remote | grep 20260418
```

**Expected result:** All four migrations now show in Remote column with matching hashes.

---

## STEP 3: Verify Edge Functions Are Current

```bash
# Check player-control function version
supabase functions list | grep player-control

# Should show status ACTIVE with recent timestamp
# If outdated, redeploy:
supabase functions deploy player-control --no-verify-jwt
```

**Expected result:** player-control ACTIVE status.

---

## STEP 4: Merge Revision to Main

```bash
git checkout main
git pull origin main
git merge revision

# Verify no conflicts
git status

# Push to GitHub (auto-deploys if you have CI/CD set up)
git push origin main
```

**Expected result:** Clean merge, main branch now has revision code.

---

## STEP 5: Deploy Web Apps

### Player App:
```bash
cd web/player

# Build production bundle
npm run build

# The build output goes to dist/
# If you use Netlify/Vercel/manual server, deploy `dist/` folder
# Instructions depend on your hosting setup

# If using Netlify CLI:
netlify deploy --prod --dir=dist

# If using Vercel CLI:
vercel --prod

# If manual server deployment, copy dist/* to your production server
```

**Expected result:** New player app deployed. Visit your player URL and refresh.

### Admin App:
```bash
cd ../admin

# Build production bundle
npm run build

# Deploy same way as player app:
# netlify deploy --prod --dir=dist
# OR: vercel --prod
# OR: scp dist/* user@server:/path/to/admin/
```

**Expected result:** New admin app deployed. Visit your admin URL and refresh.

---

## STEP 6: Verify Deployment Success

### Test 1: Single Player Flow (5 minutes)
```
1. Open player app in one browser tab
2. Wait 5 seconds (let heartbeat register)
3. Verify player shows online in admin console
4. Play a song, let it run for 1 minute
5. Verify it advances to next song automatically
6. Skip a song manually
7. Verify queue advances correctly
8. Expected: No console errors, smooth operation
```

### Test 2: Admin Toggle Race (2 minutes)
```
1. Open admin console in two browser tabs (Tab A and Tab B)
2. In Tab A: Click Play
3. Immediately in Tab B: Click Pause (within 200ms)
4. Expected: One wins, state is consistent, no oscillation
5. If you see rapid play/pause toggle: deployment failed, rollback
```

### Test 3: Dead Master Failover (3 minutes)
```
1. Open player in Tab A and Tab B
2. Wait 5 seconds (Tab A becomes master, Tab B becomes slave)
3. Hard-close Tab A (don't reload, just close it completely)
4. At 30-second mark: Check Tab B console
5. Expected: Should see log "[Player] Reclaimed master after priority player died"
6. Play a song in the next 30s
7. Expected: Song advances normally after it finishes (should NOT get stuck)
```

### Test 4: Queue Integrity (5+ minutes)
```
1. Ensure 50+ songs in queue
2. Enable shuffle
3. Play for 5+ minutes while monitoring
4. Check admin console queue panel
5. Expected: Position numbers are continuous (no gaps), no database errors
```

---

## STEP 7: Check Logs for Errors

```bash
# Check Supabase function logs for errors
supabase functions list

# Look at player-control logs in Supabase dashboard:
# https://supabase.com/dashboard/project/YOUR_PROJECT_ID/functions

# Should see entries but no ERROR lines
```

---

## STEP 8: Monitor for 1 Hour

After deployment, observe for one hour:
- No error notifications in admin console
- Players can play songs, advance queues, pause/resume
- No "Player offline" errors appearing/disappearing rapidly
- Queue doesn't corrupt

---

## Rollback Plan (If Something Breaks)

If anything fails during tests:

```bash
# Revert to main
git checkout main
git reset --hard origin/main

# Redeploy previous version
npm run build
# Redeploy via Netlify/Vercel/manual method

# Revert edge function
supabase functions deploy player-control --no-verify-jwt

# The database migrations are backward compatible (migrations added, not changed),
# so no DB rollback needed
```

---

## Success Criteria

You'll know deployment is complete when:

- ✅ All 4 migrations applied (step 1/2)
- ✅ Player-control edge function deployed (step 3)
- ✅ Both web apps deployed (step 5)
- ✅ Test 1: Single player flow works
- ✅ Test 2: Admin toggle doesn't oscillate
- ✅ Test 3: Dead master auto-reclaims
- ✅ Test 4: Queue positions stay contiguous
- ✅ 1-hour monitoring shows no errors

---

## What Was Fixed

| Issue | Symptom | Solution |
|-------|---------|----------|
| Race conditions | Master/slave toggle, stale state | State machine (App.tsx) |
| Queue corruption | Position gaps after shuffle | Position trigger (migration 001) |
| Admin toggle loop | Two consoles conflict | Compare-and-swap guard + debounce |
| Dead master blocks queue | Song plays but doesn't advance | Heartbeat failover (migration 003) |
| Realtime dropped events | Polling fallback unreliable | 30-second baseline polling |
| 1,600-line God Component | Unmaintainable, hard to debug | Split into 5 specialized hooks + 3 player components |

---

## Timeline

- **Step 1-3:** 5 minutes (verify and deploy migrations/functions)
- **Step 4-5:** 10 minutes (merge and deploy web apps)
- **Step 6:** 15 minutes (run all 4 tests)
- **Step 7:** 2 minutes (check logs)
- **Step 8:** 60 minutes (monitor)

**Total: ~90-100 minutes** (mostly monitoring)

---

**Ready? Start with Step 1 above.**
