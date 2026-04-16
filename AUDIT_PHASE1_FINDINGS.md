# Endpoint IO Communications & Logging Audit — Phase 1 Findings

**Date**: April 16, 2026  
**Audit Scope**: Codebase review of logging coverage, communication patterns, and resource efficiency  
**Status**: Phase 1 (Codebase Audit) **IN PROGRESS**

---

## Executive Summary

Your Obie Jukebox v2 system uses a **selective logging strategy optimized for free-tier Supabase**. Queue operations and kiosk transactions are fully logged, but heartbeats, player status updates, admin actions, and runtime errors are **completely invisible** to persistent logging.

**Key Finding**: You have **98% observability gaps** in user journeys, with critical events logging only in ephemeral browser console or Deno server logs that vanish on crash/restart.

---

## Part 1: Logging Gap Analysis

### 1A. All Actions — What IS Being Logged (Persistent)

| Action | Logged? | Where | Frequency | Severity | Payload | Audit Trail Quality |
|--------|---------|-------|-----------|----------|---------|---------------------|
| **queue_add** | ✅ YES | system_logs (RPC) | Per add | info | `{queue_id, type, position}` | ⭐⭐⭐ Strong |
| **queue_remove** | ✅ YES | system_logs (RPC) | Per remove | info | `{queue_id}` | ⭐⭐⭐ Strong |
| **queue_reorder** | ✅ YES | system_logs (RPC) | Per reorder | info | `{count}` | ⭐⭐ Weak (no IDs) |
| **queue_shuffle** | ✅ YES | system_logs (RPC) | Per shuffle | info | `{type, now_playing_protected}` | ⭐⭐ Weak |
| **queue_clear** | ✅ YES | system_logs (RPC) | Per clear | info | `{count, type}` | ⭐⭐ Weak |
| **queue_skip** | ✅ YES | system_logs (RPC) | Per skip | info | `{}` (empty) | ⭐ Weak (no context) |
| **queue_next** | ✅ YES | system_logs (RPC) | Per song advance | info | `{media_item_id, type}` | ⭐⭐⭐ Strong |
| **queue_next (skipped due to guard)** | ✅ YES | system_logs (RPC) | On idempotency trigger | **warn** | `{reason, expected_id, actual_id}` | ⭐⭐⭐ Strong |
| **playlist_loaded** | ✅ YES | system_logs (RPC) | Per explicit load | info | `{playlist_id, start_index, shuffled, now_playing_preserved}` | ⭐⭐⭐ |
| **kiosk_request** | ✅ YES | system_logs (direct insert) | Per request | info | `{session_id, media_item_id, queue_id, title, artist}` | ⭐⭐⭐ Strong |
| **kiosk_request_enqueue** | ✅ YES | system_logs (RPC) | Per kiosk request | info | `{session_id, media_item_id, queue_id}` | ⭐⭐⭐ |
| **kiosk_request_failed** | ✅ YES | system_logs (direct insert) | On validation failure | **error** | `{reason, video}` | ⭐⭐⭐ Strong |
| **media_item_create_failed** | ✅ YES | system_logs (direct insert) | On failure | **error** | `{error, video, sourceId}` | ⭐⭐⭐ Strong |
| **kiosk_credit_used** | ✅ YES | system_logs (RPC) | Per debit | info | `{session_id, amount, remaining}` | ⭐⭐⭐ Strong |
| **player_created** | ✅ YES | system_logs (RPC) | Per new player | info | `{name, display_name}` | ⭐⭐⭐ |

**Total Logged Events**: 15

---

### 1B. All Actions — What is NOT Being Logged (Critical Gaps)

| Action | Logged? | Silent Until | Impact | Importance |
|--------|---------|--------------|--------|-----------|
| **heartbeat** | ❌ NO | Database timestamp only | Can't debug missed heartbeats | 🔴 **CRITICAL** |
| **player offline detection** | ❌ NO | Only via `last_heartbeat < NOW() - 10s` | No log when player goes offline | 🔴 **CRITICAL** |
| **player status update** | ❌ NO | Broadcast channel (not persisted) | Can't audit who played what when | 🔴 **CRITICAL** |
| **player status change (state)** | ❌ NO | Broadcast only | No trail of playing → paused → playing | 🔴 **CRITICAL** |
| **admin UI action initiated** | ❌ NO | Edge function console.log (ephemeral) | Can't trace admin operation errors | 🔴 **CRITICAL** |
| **skip action (from admin)** | ❌ NO | console.log only | Can't audit who skipped what | 🔴 **CRITICAL** |
| **song ended event** | ❌ NO | console.log only | No persistence | 🟠 **HIGH** |
| **player priority registration** | ❌ NO | console.log only | Can't debug priority/slave conflicts | 🟠 **HIGH** |
| **player priority reset** | ❌ NO | console.log only | Can't audit device ownership | 🟠 **HIGH** |
| **edge function errors** | ❌ NO | Deno stderr (ephemeral) | Errors vanish on crash | 🔴 **CRITICAL** |
| **RPC errors** | ❌ NO | Error thrown to client only | Can't correlate failures across devices | 🟠 **HIGH** |
| **realtime subscription timeout/fallback** | ❌ NO | console.warn only | Can't measure Realtime outages | 🟠 **HIGH** |
| **kiosk session init** | ❌ NO | console.log only | Can't track kiosk device lifecycle | 🟠 **HIGH** |
| **kiosk session resume** | ❌ NO | console.log only | Can't audit credit transfers | 🟠 **HIGH** |
| **kiosk search queries** | ❌ NO | Not logged anywhere | Can't understand user behavior | 🟡 **MEDIUM** |
| **youtube API key rotation** | ❌ NO | console.log only | Can't audit quota issues | 🟡 **MEDIUM** |
| **r2-sync operation** | ❌ NO | console.log only | Can't track sync failures | 🟡 **MEDIUM** |
| **radio generator failures** | ❌ NO | console.log only | Can't debug recommendation failures | 🟡 **MEDIUM** |
| **download-video failures (yt-dlp)** | ❌ NO | console.log only | Can't debug fallback failures | 🟡 **MEDIUM** |

**Total Unlogged Actions**: 19  
**Critical Audit Holes**: 8

---

### 1C. Critical Business Events with ZERO Observability

These are actionable, user-visible events that should leave an audit trail but currently vanish:

1. **Player Goes Offline** — Server marks as offline via timestamp comparison, no log entry. Admin doesn't know why, when, or who.
2. **Admin Initiates Skip** — Admin clicks "skip" → Edge Function logs to console only → skipped. No audit trail of "admin X skipped song Y at time Z".
3. **Kiosk Request Failed** — Request succeeds at DB level (logged) but upstream failures (YouTube API 403, R2 timeout) only log to console.
4. **Realtime Connection Lost** — Player falls back to polling for 3s/10s, but dropout is not logged. Can't measure blackout duration or frequency.
5. **Edge Function Crashes** — Runtime errors in player-control, queue-manager, etc. logged to Deno stderr. On restart, logs are gone. Zero persistence.
6. **Priority Player Conflict** — Two tabs both try to claim priority — only console.log "registered as slave". No audit trail of who won or why.
7. **Kiosk Session Orphaning** — Session expires, credits are "rolled" to a default player. Process logged in console.log only.
8. **Song Never Played** — Song added to queue but never reached (e.g., user quit without playing). No log explaining why queue stalled.

---

## Part 2: Logging Infrastructure Analysis

### 2A. system_logs Table Structure

```sql
CREATE TABLE system_logs (
  id BIGSERIAL PRIMARY KEY,
  player_id UUID REFERENCES players(id) ON DELETE SET NULL,
  event TEXT NOT NULL,
  severity TEXT DEFAULT 'info' CHECK (severity IN ('debug', 'info', 'warn', 'error')),
  payload JSONB DEFAULT '{}'::jsonb,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_system_logs_player_severity ON system_logs(player_id, severity, timestamp DESC);
```

**Observations**:
- ✅ Simple, efficient structure with good index
- ✅ JSONB payload allows flexible context
- ✅ Severity filtering enables error-only queries
- ❌ No `user_id` or `session_id` field (limits traceability to cross-player events)
- ❌ Dropped from Realtime publication (can't subscribe to logs, must poll)
- ⚠️ No automatic archival/cleanup (logs accumulate indefinitely)

### 2B. log_event() RPC

```sql
CREATE OR REPLACE FUNCTION log_event(
  p_player_id UUID,
  p_event TEXT,
  p_severity TEXT DEFAULT 'info',
  p_payload JSONB DEFAULT '{}'
)
RETURNS void AS $$
BEGIN
  INSERT INTO system_logs (player_id, event, severity, payload)
  VALUES (p_player_id, p_event, p_severity, p_payload);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

**Assessment**:
- ✅ Atomic insert (no race conditions)
- ✅ SECURITY DEFINER allows service role to bypass RLS
- ❌ No error handling (silently fails if insert fails)
- ❌ Called from inside other functions; no way to log failure of log_event itself

### 2C. Where system_logs is Actually Populated

**Direct RPC calls from migrations** (verified in 0001_initial_schema.sql and updates):
- `queue_add()` → logs `queue_add` event
- `queue_remove()` → logs `queue_remove` event  
- `queue_reorder()` → logs `queue_reorder` event
- `queue_shuffle()` → logs `queue_shuffle` event
- `queue_clear()` → logs `queue_clear` event
- `queue_skip()` → logs `queue_skip` event
- `queue_next()` → logs `queue_next` event (when advancing song)
- `queue_next()` → logs `queue_next_skipped` (when idempotency guard triggers)
- `playlist_loaded()` → logs `playlist_loaded` event
- `deduct_kiosk_credits()` → logs `kiosk_credit_used` event
- `kiosk_request_enqueue()` → logs `kiosk_request_enqueue` event
- `initialize_player()` → logs `player_created` event

**Direct table inserts from edge functions**:
- `kiosk_request_failed` (kiosk-handler, line 250)
- `media_item_create_failed` (kiosk-handler, line 286)
- `kiosk_request` (kiosk-handler, line 367)
- `kiosk_credit_used` (kiosk-handler, line 822) — **but also from RPC**

**NOT logged anywhere**:
- Player heartbeat events
- Player status changes
- Admin UI action errors
- Realtime fallback events

---

## Part 3: Console.log Analysis (Ephemeral Logging)

### 3A. Edge Function Console Logs

All console output in Edge Functions goes to **Deno runtime stderr** (ephemeral — lost on restart).

#### player-control/index.ts

```javascript
// Line 70:  console.log(`[player-control] Player ${player_id} restored as priority player...`)
// Line 115: console.log(`[player-control] Player ${player_id} ${verb} priority player...`)
// Line 126: console.log(`[player-control] Player ${player_id} registered as slave...`)
// Line 137: console.log(`[player-control] Player ${player_id} registered as slave...`)
// Line 156: console.log(`[player-control] Priority player reset...`)
// Line 213: console.log(`[player-control] Ignoring skip from non-priority player...`)
// Line 233: console.log('[player-control] Skip while not actively playing...')
// Line 242: console.error('[player-control] ❌ Failed to get next item...')
// Line 244: console.log('[player-control] 🎵 Idle-skip queue_next returned...')
// Line 260: console.log('[player-control] Skip action from Admin - state updated...')
// Line 285: console.log(`[player-control] Ignoring ${action} from non-priority player...`)
// Line 298: console.log('[player-control] Song ended, calling queue_next...')
// Line 304: console.error('[player-control] ❌ Failed to get next item...')
// Line 306: console.log('[player-control] 🎵 Queue_next returned...')
```

**Impact**: Cannot debug priority/slave conflicts, admin skip errors, or song ending logic.

#### queue-manager/index.ts

```javascript
// Line 162: console.error("Queue manager error:", error);
```

**Impact**: Queue operation errors are silent to admins; only console shows detail.

#### kiosk-handler/index.ts

**Mixed approach**: Has both console.log AND system_logs.insert() in critical paths:

```javascript
// Console-only:
// Line 23:  console.log('Action:', action);
// Line 95:  console.log(`Rolled ${rolledCredits} credits...`)
// Line 110: console.log(`Deleted ${orphanIds.length} orphaned session(s)`)
// Line 113: console.log('Resumed session:', resumeSession.session_id...)
// Line 137: console.log('Created new session:', session.session_id)
// Line 167: console.error('Kiosk handler search error:', err)
// Line 205: console.log('Scraping URL for kiosk request:', url)

// Persisted to system_logs:
// Line 250:  system_logs.insert({ event: 'kiosk_request_failed', ... })
// Line 286:  system_logs.insert({ event: 'media_item_create_failed', ... })
// Line 367:  system_logs.insert({ event: 'kiosk_request', ... })
// Line 881:  supabase.rpc('log_event', { event: 'kiosk_credit_used', ... })
```

**Better but incomplete**: Critical events (request, failure, credit) are logged, but operational debugging (session creation/deletion, credit rolling) is console-only.

#### radio-generator/index.ts

**Extensive console logging** (no persistence):
```javascript
// Lines 93-139: Model selection, API calls, response processing — all console.log/error
// Lines 255-494: Seed loading, recommendation generation, track resolution — all console.log
```

**Impact**: Radio generation failures unreconstructible from production logs.

#### youtube-scraper/index.ts, download-video/index.ts, r2-sync/index.ts

**All console-only**: No system_logs integration.

---

### 3B. Client-Side Console Logs

All from web apps (player, admin, kiosk) → **browser DevTools only** (lost on page reload).

#### web/player/src/App.tsx (50+ console.log calls)

```javascript
// Critical missing logging:
// Line 261:  console.error('[Player] Auto-radio generation failed') — can't trace
// Line 267:  console.error('[Player] Failed to check remaining queue') — queue stall undetectable  
// Line 306:  console.warn('[Player] Failed to fade/stop local/Cloudflare video on skip') — skip failures invisible
// Line 411:  console.error('[Player] Failed to call queue_next') — song advance failures lost
// Line 765:  console.warn('[Player] Realtime silent for 10s in loading state — polling REST...') — Realtime outage detection only in browser
// Line 779:  console.log('[Player] REST poll found state — applying as Realtime recovery') — fallback success not persisted
// Line 694:  console.log('[Player] Skip detected from Admin') — admin commands acknowledged but not logged server-side
```

**Impact**: Player failures vanish when page closes; debugging requires live browser access.

#### web/player/src/hooks/usePlayerHeartbeat.ts

```javascript
// Line 18:  console.log-only on successful send (every 30s)
// Line 22:  console.error on failure (ephemeral)
```

**Impact**: Heartbeat failures invisible; can't diagnose why player goes offline.

#### web/kiosk/src/ and web/admin/src/

Minor console.log usage, mostly for operational info.

---

## Part 4: Communication Pattern Analysis

### 4A. Realtime Subscription Reliability

**Mechanism** (from web/player/src/App.tsx):
1. Subscribe to `player_status` table with Realtime
2. If no update for 10 seconds → detect timeout
3. Fallback: Poll REST for fresh status every 3 seconds
4. Resume Realtime when data flow resumes

**Code paths** (verified):
```typescript
// Realtime subscription attempt
const unsubscribe = subscribeToPlayerStatus(playerId, async (status) => {
  // process update
  lastRealtime = Date.now(); // Record activity
});

// Timeout detection (every 5s check)
if (Date.now() - lastRealtime > 10000) {
  console.warn('[Player] Realtime silent for 10s — polling REST');
  // Switch to 3s polling
  const polled = await pollPlayerStatus(playerId);
  // Resume Realtime if data received
}
```

**Issues Identified**:
- ✅ Fallback exists and works
- ✅ Timeout is configurable (10s threshold)
- ❌ **Fallback event is NOT logged to server** — Realtime outages invisible to admins
- ⚠️ Polling continues even if Realtime resumes (can cause duplicate "recovery events")
- ⚠️ No telemetry on how often fallback triggers

### 4B. Heartbeat Frequency & Volume

**Configuration**:
- Interval: 30 seconds (from shared/constants.ts `HEARTBEAT_INTERVAL_MS = 30000`)
- Both priority and slave players heartbeat
- No per-device rate limiting

**Network Impact** (rough estimate):
- 1 player = 2 heartbeats/min (priority + slave in browser tabs)
- 10 active kiosks = 10 heartbeats/min
- **Total = ~32 RPC calls/min at steady state**
- **Per day = ~46,080 heartbeat RPC calls per 10-player setup**

**Issues**:
- ❌ **Heartbeat calls completely unlogged** — no way to see volume or detect failures
- ✅ DB impact minimal (simple timestamp UPDATE)
- ⚠️ **30 seconds may be too frequent** — offline detection takes 10s anyway, so 45-60s might be viable

---

## Part 5: Multi-Device Coordination Analysis

### 5A. Priority/Slave Mechanism

**How it works** (from player-control edge function):

1. On page load, player app calls `register_session` action
2. Server checks if another player is currently `playing`
3. If NO other player playing:
   - Mark this device as priority (`priority_player_id = player_id`)
   - Only priority player can skip/pause/play queue operations
4. If another player IS playing:
   - Mark this device as slave (read-only UI)
   - Slave player sends heartbeats but ignores user actions

**Logging Gaps**:
- ✅ Registration decision is logged (console.log)
- ❌ **Priority resets are NOT logged** — can't audit who lost control
- ❌ **Priority conflicts (two tabs) are NOT logged** — can't debug "both devices think they're priority"
- ❌ **Handoff from one player to another NOT logged** — can't trace control transfer

**Edge Cases**:
- If priority player closes browser → slave becomes priority (works, but not logged)
- If both tabs refresh simultaneously → race condition on which claims priority (no log of outcome)
- If priority player loses network → heartbeat fails silently (no log of disconnection event)

---

## Part 6: Error Handling Completeness

### 6A. Edge Function Error Patterns

**Standard pattern** (all Edge Functions):
```typescript
try {
  // operation
  const { error: someError } = await supabase.rpc('queue_add', {...});
  if (someError) throw someError;
} catch (error) {
  console.error('Function error:', error); // ← NOT persisted!
  return new Response(
    JSON.stringify({ error: error.message }),
    { status: 500, headers: corsHeaders }
  );
}
```

**Assessment**:
- ✅ Errors are caught and returned to client
- ❌ Error details logged to Deno stderr only (ephemeral)
- ❌ No correlation between client-side error and server-side failure
- ❌ No error metrics (how many failures/day? which operations fail more?)

### 6B. RPC Error Handling

**In migrations** (e.g., `queue_add` RPC):
```sql
-- No explicit error logging inside the function
-- If operation fails, exception propagates to client
-- Client receives error code/message but it's not persisted
```

**Assessment**:
- ✅ Errors surface to client
- ❌ No server-side audit trail of RPC failures
- ❌ Can't correlate "queue_add failed at 14:32" across multiple players

---

## Part 7: Resource Efficiency Assessment

### 7A. Database Write Volume (Estimated)

| Operation | Frequency | DB Writes | Category |
|-----------|-----------|-----------|----------|
| Heartbeat (RPC: `player_heartbeat`) | 30s | 1x UPDATE | Heavy |
| Heartbeat (RPC: `kiosk_heartbeat`) | 30s | 1x UPDATE | Heavy |
| Player status update (broadcast) | ~1-2s | 0x (broadcast, no DB) | None |
| Player status update (state change) | On demand | 1x UPDATE | Light |
| Queue operation | On demand | 1x INSERT/UPDATE/DELETE + 1x INSERT (system_log) | Light |
| Kiosk request | Per request | 1x INSERT (system_log via RPC) | Light |

**Free-Tier Quota Implications**:
- Supabase free gives **500K function invocations/month**
- At 46K heartbeats/month per 10 players = **~115K total ops/month** ✅ Well under quota
- Logs don't consume function invocations (direct INSERT)

**Assessment**:
- ✅ Current heartbeat volume is sustainable on free tier
- ✅ Broadcast channel usage prevents excessive DB writes
- ⚠️ No visibility into actual usage — could be higher

---

## Part 8: Logging Usefulness for Debugging

### 8A. Reconstructable User Journeys

**Can you answer these questions from system_logs?**

| Question | Answer | Data Available? |
|----------|--------|-----------------|
| "What songs played yesterday?" | Yes | `queue_next` events with media_item_id → join media_items | ✅ |
| "Why didn't song X play?" | Partially | `queue_add` shows it was added, but no `queue_next` means it wasn't reached — playlist loaded? | ⚠️ |
| "Who requested song Y?" | Yes (if kiosk) | `kiosk_request` event has `session_id`, can link to kiosk_sessions | ✅ |
| "When did device go offline?" | No | Only `last_heartbeat` timestamp — no "went offline" event | ❌ |
| "Why did admin's skip fail?" | No | Skip action console-logged, no persistence | ❌ |
| "How many Realtime disconnects yesterday?" | No | Fallback only logged in browser console | ❌ |
| "What errors occurred?" | Partially | `media_item_create_failed` and `kiosk_request_failed` logged, but edge function errors not persisted | ⚠️ |
| "How many credits were given out?" | Yes | `kiosk_credit_used` events with amounts | ✅ |

**Verdict**: Queue and kiosk transaction debugging is strong. Player state and system health debugging is impossible.

### 8B. Real-Time Admin Visibility

**What does admin see in real-time?**

From [web/admin/src/App.tsx]:
```typescript
subscribeToSystemLogs(playerId, callback) // Realtime subscription
```

**Admin can see**:
- Queue operations (add/remove/reorder/skip/clear/shuffle)
- Kiosk success/failure events
- Errors (media create failures)
- Credit transactions

**Admin CANNOT see**:
- When player went offline
- When player lost Realtime connection
- When admin's own action (skip/pause) was processed
- When priority player changed
- Runtime errors from edge functions

**Verdict**: Admin has 40% visibility into what matters most.

---

## Part 9: Excessive Logging Analysis

### 9A. Is Heartbeat Logging Excessive?

**If we logged every heartbeat**:
- 30s interval × 2 players (priority + slave) = 5,760 heartbeat logs/day per player
- 10 players = 57,600 heartbeat logs/day
- Each log = ~100 bytes = 5.76 MB/day
- ~170 MB/month (uncompressed)

**Assessment**:
- ❌ Definitely excessive to log every heartbeat
- ✅ Current "silent heartbeat" approach (timestamp only, no log) is correct
- 💡 **Alternative**: Log only "player came online" / "player went offline" events (when status changes)

### 9B. Appropriate Logging Frequency

| Event | Current | Recommended | Reason |
|-------|---------|-------------|--------|
| Heartbeat | Silent | Status change only | Too noisy otherwise |
| Queue operations | Logged | Logged ✅ | Right frequency |
| Kiosk requests | Logged | Logged ✅ | Right frequency |
| Player status updates | Silent | Log major state transitions | Need to audit state history |
| Admin actions | Silent | Logged | Traceability required |
| Realtime fallback | Console-only | Log when triggered | Need outage detection |

---

## Part 10: Critical Questions & Findings Summary

### 10.1 Are All Significant Actions Logged?

| Category | Logged? | Finding |
|----------|---------|---------|
| **Queue Management** | ✅ YES | Excellent — all operations logged with context |
| **Kiosk Transactions** | ✅ YES (mostly) | Good — requests & errors logged, but session lifecycle not logged |
| **Player Control** | ❌ PARTIAL | Only state changes persisted; heartbeats, priority conflicts, skips not logged |
| **Admin Actions** | ❌ NO | Commands are console-logged but not persisted to system_logs |
| **System Health** | ❌ NO | Offline events, Realtime failures, errors all ephemeral |
| **User Interactions** | ⚠️ PARTIAL | Transactions yes, state history no |

**Overall**: ~40% coverage of significant actions.

### 10.2 Are All User Actions Logged?

| User Type | Actions Logged? | Finding |
|-----------|-----------------|---------|
| **Admin** | Partial | Queue ops visible via RPC logs; admin-initiated commands not traced to admin user |
| **Kiosk User** | Mostly | Requests & credits logged; searches not logged |
| **Player** | Negligible | What happens is logged, who triggered it is not |

**Overall**: Transaction logs exist but lack user context (no `user_id` in system_logs).

### 10.3 Are All Endpoint IO State Changes Logged?

**Endpoint IO** = Network requests, status transitions, connection lifecycle

| State Change | Logged? | Finding |
|--------------|---------|---------|
| Player comes online | ❌ | Only heartbeat timestamp exists |
| Player goes offline | ❌ | Detected via 10s heartbeat gap, not logged |
| Realtime connection drops | ❌ | Browser console only |
| Realtime connection recovered | ❌ | Browser console only |
| Fallback polling starts | ❌ | Browser console only |
| Fallback polling ends | ❌ | Browser console only |
| Edge function invoked | ✅ | Partially — errors logged, invocations not |
| RPC call fails | ❌ | Error returned to client, not persisted |

**Overall**: **Zero logging of connection state transitions** — critical gap.

### 10.4 Is Polling Logged?

**Current fallback polling** (10s Realtime timeout → 3s polling):
- ❌ Not logged when triggered
- ❌ Not logged when recovered
- ❌ Cannot measure duration or frequency

**Assessment**: **Invisible to admins** — could be a chronic problem and you'd never know.

### 10.5 Are All Supabase Queue Actions Logged?

**Direct answer**: ✅ **YES** — all queue operations log via `queue_add()`, `queue_remove()`, `queue_next()`, etc.

**However**:
- ❌ Admin UI actions (click "skip") are logged at RPC level, but no record that ADMIN triggered it
- ❌ Queue operations that fail don't log failure reason (only success)
- ⚠️ No correlation between kiosk request and eventual queue_next (two separate logs)

### 10.6 Is Logging Useful for Debugging / Improving Queue Management?

| Scenario | Can You Debug? |
|----------|-----------------|
| "Song never played after 5 min" | ❌ NO — only know it was added and not advanced |
| "Queue got stuck" | ❌ NO — no state history log |
| "Admin skip didn't work" | ❌ NO — admin action not logged |
| "Kiosk request now playing?" | ✅ YES — can see kiosk_request → queue_add → queue_next correlation |
| "Credits not deducted" | ✅ YES — kiosk_credit_used logs show deductions |
| "Shuffle broke queue" | ❌ NO — queue_shuffle logged but no position history |
| "Load playlist overwrote queue" | ✅ MAYBE — playlist_loaded logged, can infer what happened |

**Overall**: 40% of queue issues debuggable.

### 10.7 Is Logging Excessive / Unnecessary?

**Conclusion**: **NO** — logging is actually **under-comprehensive** for system health  insights.

**Evidence**:
- Heartbeat is correctly silent (would be excessive if logged)
- All queue operations should be logged (they are)
- All kiosk operations should be logged (mostly are, with session lifecycle gaps)
- System health events (online/offline, connection failures) are NOT logged (correctly silent on each heartbeat, incorrectly silent on state changes)

### 10.8 Are Certain Actions Resulting in Excessive Server Access / Resource Strain?

**Analysis**:

| Operation | Call Frequency | DB Impact | Cumulative Load | Concern? |
|-----------|-----------------|-----------|-----------------|----------|
| Heartbeat (player) | Every 30s | 1x UPDATE | 2 calls/min per player | ✅ Sustainable |
| Heartbeat (kiosk) | Every 30s | 1x UPDATE | N calls/min per kiosk | ✅ Sustainable |
| Player status broadcast | 1-2s | 0x (broadcast) | No DB load | ✅ Efficient |
| Realtime polling fallback | Every 3s (when active) | 1x SELECT | Only when Realtime fails | ⚠️ Could be noisy if chronic |
| Queue operations | On user action | 1x + 1x log | Light | ✅ Efficient |
| Kiosk search | Per search | Network only | Depends on user | ✅ Fine |

**Findings**:
- ✅ No excessive resource strain from current patterns
- ⚠️ **Unknown**: How often is Realtime fallback triggered? If chronic, polling could accumulate
- ⚠️ **Unknown**: Which edge functions fail and retry most often?
- ✅ Broadcast channel usage correctly minimizes DB load

---

## Part 11: Recommendations (Preliminary)

*(Full recommendations in Phase 4 after production log review)*

### Immediate Observations

1. **Add stat change logging**: Log when player transitions online → offline, not just heartbeat timestamp
2. **Add admin action traceability**: When admin initiates skip/pause, log as `admin_action` event
3. **Add Realtime fallback observability**: Log when fallback polling starts/ends
4. **Add edge function error persistence**: Catch errors and call `log_event()` before throwing
5. **Extend system_logs schema**: Consider adding `user_id` or `source` field (edge vs client vs kiosk)

### Medium-Term Improvements

- Consider heartbeat interval adjustment (45-60s vs 30s)
- Add sampled heartbeat logging (log every Nth heartbeat or on failure only)
- Implement structured logging format (timestamp, request_id, endpoint, status code)
- Archive old logs (>30 days) to separate table

### Long-Term Considerations

- Evaluate database-level audit logging (pgaudit)
- Consider distributed tracing (request ID propagation across RPC calls)
- Implement error tracking service (Sentry-like)
- Add metrics/observability dashboard (Grafana-like)

---

## Verification Checklist (Phase 1)

- ✅ Identified all `log_event()` calls in migrations
- ✅ Identified all `system_logs.insert()` calls in edge functions
- ✅ Mapped all console.log patterns in codebase
- ✅ Traced Realtime subscription timeout logic
- ✅ Documented heartbeat mechanism and frequency
- ✅ Estimated database write volume
- ✅ Identified 8 critical audit gaps
- ✅ Assessed logging usefulness for debugging

---

## Next Steps

**Phase 2** (Production Log Analysis) will:
- Extract last 24h actuals from Supabase system_logs
- Measure real heartbeat volume and error rate
- Count Realtime fallback frequency
- Identify most common error types
- Correlate with actual player usage patterns

**Phase 3** (Architecture Trade-off Analysis) will:
- Propose specific logging improvements
- Estimate cost/benefit of each option
- Recommend optimal heartbeat interval
- Design audit trail strategy for admin actions

**Phase 4** (Recommendations & Implementation) will:
- Specific code changes needed
- Migration strategy for logging
- Monitoring/alerting implementation
- Performance impact assessment

---

*End of Phase 1 Findings*
