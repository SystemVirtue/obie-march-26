# Deployment Decision Point

**Status**: You have two deployment scenarios to choose between. This document clarifies which one.

## What You Have Right Now

In your local repository `/supabase/migrations/`:

**Old Approach (Migrations 004-007):**
- 20260418000004_multi_connection_hardening.sql ← advisory locks first attempt
- 20260418000005_fix_reset_priority_claim.sql ← fixes for 004
- 20260418000006_fix_rls_service_role.sql ← RLS permission fixes
- 20260418000007_add_reset_priority_player_flag.sql ← flag-based locking

**New Revision Approach (Migrations 001-003):**
- 20260418000001_queue_position_trigger.sql ← auto-resequence positions
- 20260418000002_queue_next_hardened.sql ← hardened queue advancement
- 20260418000003_heartbeat_priority_failover.sql ← auto-clear dead master

**Cleanup Migration (419):**
- 20260419000001_remove_reset_priority_player_flag.sql ← removes old flag approach

## Where You Are in the Decision Tree

Someone has already created migration 419001, which indicates: **The decision was already made to use the revision approach.**

Migration 419001 exists ONLY to clean up after the old approach - it explicitly removes the `reset_priority_player` flag and commits to advisory locks as the solution.

## Your Two Choices Now

### Choice A: COMMIT to Revision Approach (Recommended)

This is what migration 419001 indicates was already decided.

**Steps:**
1. Verify migration 419001 is applied to production
   ```bash
   supabase migration list --remote | grep 20260419000001
   ```
   - If it shows: Your production already committed ✓ 
   - If blank: Apply it next:
     ```bash
     supabase db push
     ```

2. Deploy your App.tsx refactored code
   - Merge revision branch → main
   - Deploy new player app (state machine, 319 lines)
   - Deploy new admin app (debounced play/pause)

3. Verify migrations 001-003 are applied
   ```bash
   supabase migration list --remote | grep 20260418000[123]
   ```

**Result:** 
- Migration 001: Queue position trigger active
- Migration 002: Hardened queue advancement active
- Migration 003: Heartbeat failover active
- Migration 419001: Flag removed, old approach gone
- Code: State machine + hooks
- Outcome: Clean, reliable playback

### Choice B: Revert Everything (Not Recommended)

If you want to stick with the old approach (migrations 004-007), you'd need to:
1. Delete migrations 001-003 and 419001 
2. Keep 004-007
3. NOT deploy the revision branch code
4. Keep App.tsx at 1,637 lines

**Why not recommended:**
- The old approach has race conditions (why you're making these changes)
- Migration 419001 already committed the team to the new approach
- The revision code is 80% smaller and eliminates root causes

## What Needs Verification

Run this command and share results:

```bash
supabase migration list --remote
```

This will show you exactly which migrations are already applied to your production database. Based on the output, you'll know whether:
1. Everything is already done (if 419001 is applied)
2. Only pending final deployment (if 419001 exists locally but not remote)
3. Something is stuck mid-migration (if mixed state)

## The Role of Each Migration

| Migration | Branch | Purpose | Safe to Deploy | Notes |
|-----------|--------|---------|---|---|
| 001 | revision | Position trigger | YES | Orthogonal, additive only |
| 002 | revision | Hardened queue_next | YES | Uses trigger from 001 |
| 003 | revision | Heartbeat failover | YES | Clears dead masters |
| 004 | main | Multi-connection (old) | SUPERSEDED | Replaced by 003 |
| 005 | main | Reset claim fix (old) | SUPERSEDED | Replaced by 002 |
| 006 | main | RLS service_role | YES | Still needed for permissions |
| 007 | main | Flag-based locking | REMOVE | Explicitly removed by 419001 |
| 419001 | cleanup | Remove flag | MUST DEPLOY | Commits to revision approach |

## Recommended Next Step

1. **Run:** `supabase migration list --remote`
2. **Look for:** 20260419000001
   - If present: Deployment is committed, just need to verify all three app code changes are deployed
   - If absent: Deploy it via `supabase db push`
3. **If 001-003 are also absent:** Deploy those too
4. **Deploy web apps** with new code (revision branch)
5. **Test** the three scenarios: single player, admin toggle, dead master failover

## Decision Summary

**Based on migration 419001 existing in your repo, the decision has already been made:**

✅ Use revision approach (migrations 001-003 + 419001)  
✅ Abandon old approach (effectively remove 004-007 from consideration)  
✅ Deploy refactored code (App.tsx state machine + hooks)  

This document exists to confirm that decision and guide the final deployment steps.

---

**Next action:** Run `supabase migration list --remote` and report which 20260418/20260419 migrations are already applied. Then proceed accordingly.
