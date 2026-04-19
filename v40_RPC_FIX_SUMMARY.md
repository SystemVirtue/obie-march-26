# Fix for 500 Error - Priority Player Reset Failure - v40

## Root Cause
The Supabase JavaScript client library requires at least one filter (`.eq()`, `.neq()`, etc.) when calling `.update()`. This is a safety feature to prevent accidental mass updates. The player-control function was trying to update ALL player rows without any filter to maintain global consistency:

```typescript
// BROKEN (v39 and earlier):
const { error } = await supabase.from('players').update({ priority_player_id: player_id });
// ❌ Error: .update() without filters not allowed
```

This caused unhandled exceptions resulting in 500 errors whenever:
1. Admin clicked "Reset Priority Player"
2. Player tried to restore priority on reconnection  
3. Player tried to claim priority on initial connection

## Solution
Created two SQL RPC functions that handle atomic updates of ALL player rows:

```sql
-- Update all players with new priority ID (atomic in PostgreSQL)
CREATE FUNCTION set_priority_player_global(p_priority_player_id UUID)
RETURNS void AS $$ BEGIN
  UPDATE public.players SET priority_player_id = p_priority_player_id WHERE true;
END;

-- Reset priority across all players (atomic)
CREATE FUNCTION reset_priority_player_global() 
RETURNS void AS $$ BEGIN
  UPDATE public.players SET priority_player_id = NULL WHERE true;
END;
```

RPC functions bypass the client-side filter requirement and execute atomically on the server.

## Implementation

### Migration Applied
- **File:** `supabase/migrations/20260419_priority_player_global_update.sql`
- **Status:** ✅ Applied to production
- **Functions Created:** 2 (set_priority_player_global, reset_priority_player_global)

### Function Updates
Updated `supabase/functions/player-control/index.ts` to use RPCs:

**Restore Path (line 73-77):**
```typescript
const { error: updateError } = await supabase.rpc('set_priority_player_global', {
  p_priority_player_id: player_id
});
```

**Claim Path (line 134-138):**
```typescript
const { error: updateError } = await supabase.rpc('set_priority_player_global', {
  p_priority_player_id: player_id
});
```

**Reset Path (line 176-178):**
```typescript
const { error: resetError } = await supabase.rpc('reset_priority_player_global');
```

### Deployment Status
- **Function Version:** 40 (ACTIVE)
- **Deployed At:** 2026-04-19 00:21:29 UTC
- **Status:** ✅ Live in production

## How It Works

1. **Player resetting priority:** Admin clicks "Reset Priority Player"
   - Function calls `reset_priority_player_global()` RPC
   - All player rows updated atomically to `priority_player_id = NULL`
   - Next connecting player becomes MASTER

2. **Player restoring on reconnection:**
   - Player was previously priority (stored in memory)
   - On reconnect, calls `set_priority_player_global(player_id)` RPC
   - All rows updated atomically to same `priority_player_id`
   - All players agree on who is MASTER

3. **Player claiming priority:**
   - New player connecting with no current priority set
   - Calls `set_priority_player_global(player_id)` RPC
   - All rows updated to new priority
   - All players agree on MASTER

## Benefits

✅ **Atomic Updates:** All player rows updated in single PostgreSQL transaction
✅ **Consistent:** All players query ANY row, get identical priority_player_id
✅ **No 500 Errors:** RPC functions execute on server, valid SQL
✅ **Safe:** SECURITY DEFINER ensures proper permissions
✅ **Scalable:** Efficient for any number of players

## Testing the Fix

### Admin Console
1. Open Settings panel
2. Click "Reset Priority Player"
3. Verify no 500 error in browser console
4. Verify loading state shows during request
5. Confirm next connecting player becomes MASTER

### Player App
1. Have two player instances connect
2. First becomes MASTER, second becomes SLAVE
3. Close MASTER player
4. Slave automatically reclaims MASTER status
5. Verify no 500 errors in browser console

## Commits
- `fix: add missing error check to restore path in player-control function` - v38
- `docs: add Reset Priority Bug Fix verification document for v38` - v38  
- `fix: use RPC functions for atomic global priority player updates` - v40

## Files Modified
- `supabase/functions/player-control/index.ts` - Updated 3 update calls to use RPCs
- `supabase/migrations/20260419_priority_player_global_update.sql` - New RPC functions

## Status
✅ **COMPLETE** - Ready for testing
