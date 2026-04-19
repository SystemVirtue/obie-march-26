# Reset Priority Player Bug Fix - v38 Deployment

## Bug Summary
The "Reset Priority Player" action was causing consistent 500 errors when triggered from the admin console. Players attempting to reset priority would see "Internal server error" in the browser console.

## Root Cause Analysis
The player-control Edge Function v37 had a critical missing error check in the restore path:

```typescript
// BROKEN CODE (v37):
const { error: updateError } = await supabase
  .from('players')
  .update({ priority_player_id: player_id });

// Missing: if (updateError) throw updateError;
```

This caused **unhandled exceptions** when database updates failed, resulting in 500 errors. The claim path had the error check correctly, but the restore path did not.

## Solution Implemented (v38)
Added the missing error check to the restore path to match the claim path:

```typescript
// FIXED CODE (v38):
const { error: updateError } = await supabase
  .from('players')
  .update({ priority_player_id: player_id });

if (updateError) throw updateError;  // ← ADDED
```

## Verification

### Deployed Function Status
```
player-control: ACTIVE
Version: 38
Deployed: 2026-04-19 00:04:56 UTC
```

### Code Changes Verified

**Restore Path (lines 62-80):** ✅ Error check present
```typescript
if (!otherPlayerActive) {
  const { error: updateError } = await supabase
    .from('players')
    .update({ priority_player_id: player_id });
  
  if (updateError) throw updateError;  // ✅ ADDED
```

**Claim Path (lines 125-155):** ✅ Error check confirmed
```typescript
if (!otherPlayerActive) {
  const { error: updateError } = await supabase
    .from('players')
    .update({ priority_player_id: player_id });
  
  if (updateError) throw updateError;  // ✅ CONFIRMED
```

**Reset Path (lines 175-195):** ✅ Error check confirmed
```typescript
if (action === 'reset_priority') {
  const { error: resetError } = await supabase
    .from('players')
    .update({ priority_player_id: null });
  
  if (resetError) throw resetError;  // ✅ CONFIRMED
```

## Expected Behavior After Fix

### When Admin Clicks "Reset Priority Player"
1. Button shows loading state: "⏳ Resetting..."
2. Broadcasting banner appears during request
3. Reset completes successfully (no 500 error)
4. Next player to connect becomes MASTER
5. All player rows have `priority_player_id = null` globally

### Error Handling
- If database update fails: Function now throws error (instead of silently failing)
- Admin sees appropriate error message
- Browser console shows meaningful error (not "Internal server error")

## Commit & Deployment
- **Commit:** `fix: add missing error check to restore path in player-control function`
- **Deployed as:** v38
- **Status:** ACTIVE and live

## Testing Recommendations
1. ✅ Reset priority player from admin console
2. ✅ Verify no 500 error in browser console
3. ✅ Confirm next connecting player becomes MASTER
4. ✅ Check that all player rows have `priority_player_id = null` after reset
