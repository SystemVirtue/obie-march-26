# Migration Strategy: Main vs Revision Branch

**CRITICAL DECISION:** Which migration set to deploy?

## The Migration Conflict

Your workspace currently has TWO sets of migrations fixing the same problems:

### Set A: Main Branch (004-007)
**File paths:**
- 20260418000004_multi_connection_hardening.sql
- 20260418000005_fix_reset_priority_claim.sql
- 20260418000006_fix_rls_service_role.sql
- 20260418000007_add_reset_priority_player_flag.sql

**Approach:** Incremental fixes to the old multi-query architecture. Each migration adds more guards:
- 004: Advisory lock for priority election (old approach)
- 005: Skip guard when priority is NULL
- 006: RLS permission fixes
- 007: Add flag-based reset protection

**Status:** These exist on main branch but may not all be applied to production yet.

### Set B: Revision Branch (001-003)
**File paths:**
- 20260418000001_queue_position_trigger.sql
- 20260418000002_queue_next_hardened.sql
- 20260418000003_heartbeat_priority_failover.sql

**Approach:** Clean redesign using state machine. Single solution:
- 001: Auto-resequence positions after DELETE (fixes queue corruption)
- 002: Atomically advance queue with position trigger
- 003: Auto-clear dead master on heartbeat (fixes failover)

**Status:** These exist on revision branch, ready to deploy.

## Critical Conflict: Migration 007 vs Revision Architecture

**Migration 007** adds `reset_priority_player BOOLEAN` column to create flag-based locking.

**Revision branch** deliberately DOES NOT USE this flag because:
- Advisory locks in migrations 001-002 make flags redundant
- Flags add complexity and state to track
- State machine in refactored App.tsx eliminates the problem the flag was solving

**Result:** If you deploy both sets, you'll have:
- The new reset_priority_player column (from 007)
- But the code won't use it (revision codebase ignores it)
- And migration 003 working around it with different logic

This creates technical debt and maintenance burden.

## What Migrations Actually Got Applied to Production?

**IMPORTANT DISCOVERY:** Migration 20260419000001 already exists in your repo!

This migration removes the reset_priority_player flag (from old approach 007) and explicitly commits to the revision branch architecture using advisory locks.

**This means someone already decided:** Use the revision approach and discard the old flag-based approach.

**You must verify THIS to confirm:**

```bash
# Check which migrations are in production Supabase right now
supabase migration list --remote

# Specifically look for:
# 20260419000001_remove_reset_priority_player_flag.sql
#
# If it shows in Remote column: Cleanup is applied, you're committed to revision
# If it's blank in Remote column: Cleanup is pending, need to apply it
```

## Decision Matrix

### Scenario A: Main Migrations (004-007) Already Applied to Production
**then:**
- Revision branch 001-003 should NOT be applied yet
- First deploy revision branch App.tsx code (which uses different approach)
- After confirming revision code works, migrations 004-007 can stay (won't hurt)
- Plan to remove them later as technical debt cleanup

**Reason:** Don't apply two different architectural solutions simultaneously.

### Scenario B: Main Migrations (004-007) NOT Yet Applied to Production
**then:**
- DO NOT apply them at all
- Deploy revision branch 001-003 ONLY
- Deploy revision branch code (new App.tsx, state machine, hooks)
- This is the clean path — revision is the better solution

**Reason:** Avoid accumulating multiple solutions to the same problem.

### Scenario C: ONLY Migration 006 Applied (RLS fixes)
**then:**
- This is SAFE to keep — it's orthogonal
- Migrations 001-003 can be applied on top
- Migrations 004, 005, 007 should NOT be applied

**Reason:** RLS fixes don't conflict with revision architecture. Migrations 004/005/007 are redundant with revision's superior approach.

## Recommended Action

**BEFORE DEPLOYING ANYTHING:**

1. Run `supabase migration list --remote` and document which of 004-007 are applied
2. If ANY of 004-005-007 are applied: Create a rollback plan (or accept them as legacy)
3. Deploy revision branch 001-003 (they're additive and don't conflict with 006)
4. Test revision branch code thoroughly
5. Document that 004-005-007 are superseded by 001-003 for future reference

## Migration Dependency Graph

```
Pre-April 18:
  ...previous migrations...

Main Branch (do NOT deploy all of these):
  004: multi_connection_hardening
  005: fix_reset_priority_claim (depends on 004)
  006: fix_rls_service_role ← SAFE, orthogonal to revision
  007: add_reset_priority_player_flag ← CONFLICTS with revision

Revision Branch (deploy this set):
  001: queue_position_trigger ← best solution for queue corruption
  002: queue_next_hardened (depends on 001) ← uses trigger, not flag-based
  003: heartbeat_priority_failover ← auto-clears dead master

Code changes in revision branch:
  App.tsx: uses playbackMachine (state machine)
  player-control/index.ts: compare-and-swap for admin race
  usePlayerHeartbeat.ts: auto-reclaim on failover
```

## Clean Deployment Path (Recommended)

**IF main migrations 004-005-007 have NOT been applied yet:**

1. Delete files 004, 005, 007 from your local repo
   ```bash
   rm supabase/migrations/20260418000004*.sql
   rm supabase/migrations/20260418000005*.sql  
   rm supabase/migrations/20260418000007*.sql
   ```

2. Keep 006 (RLS is important)

3. Deploy revision branch as-is with 001-003

4. This gives you a clean migration history with no superseded files.

**IF main migrations have already been applied to production:**

1. Leave them as-is (undoing applied migrations is messy)
2. Deploy revision 001-003 on top (they don't conflict)
3. Migrations 001-003 work independently of 004-005-007
4. Document that 004-005-007 are now superseded (technical debt)
5. In future updates, don't apply versions of those files

## Implementation Checklist

- [ ] Run `supabase migration list --remote` and document results
- [ ] Decide: Are 004-005-007 already applied?
- [ ] If no: Delete 004, 005, 007 locally to clean up history
- [ ] If yes: Document reason for keeping them
- [ ] Verify migration 006 (RLS) is essential for your setup
- [ ] Confirm revision branch has 001-003 ready
- [ ] Deploy exactly ONE set: either clean (just 001-003+006) or incremental (004-007 already done, then add 001-003)

---

**The key principle:** Don't deploy multiple solutions to the same problem on top of each other. Pick the best one (revision 001-003) and deploy that cleanly.
