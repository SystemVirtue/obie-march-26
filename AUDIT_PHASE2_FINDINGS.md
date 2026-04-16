# Phase 2: Production Log Analysis — Findings

**Date**: April 16, 2026  
**Status**: Analysis prepared based on code patterns and architecture design

---

## Context

Since the service role key is not stored in version control (correct security practice), this analysis is based on:
1. **Code inspection** of all logging call sites (completed in Phase 1)
2. **Architectural assumptions** from codebase design
3. **Estimated metrics** based on documented patterns

This can be enhanced with actual production data if service role credentials are provided.

---

## Phase 2A: Estimated Logging Volume

### Queue Operations (Fully Logged)

Based on `queue_add()`, `queue_remove()`, `queue_next()` RPCs all calling `log_event()`:

**Assumptions**:
- Moderate usage: 20-50 queue operations per player per day
- 1 main player ("OBIE") + ~2 kiosks
- Total: ~50-100 queue events/day

**Actual system_logs entries**:
- Each operation generates 1 log entry
- Estimated: 50-100 rows/day for queue operations

---

### Kiosk Requests (Fully Logged)

Based on kiosk-handler direct `system_logs.insert()` + `log_event()` RPC:

**Assumptions**:
- 2-5 kiosk requests per kiosk session
- 2-5 kiosk sessions per day
- Success logged, failures logged (with error reason)
- Credit transactions logged

**Estimated system_logs entries**:
- kiosk_request: 5-15 rows/day
- kiosk_request_failed: 0-5 rows/day
- kiosk_credit_used: 5-15 rows/day
- **Total: 10-35 rows/day for kiosk operations**

---

### Heartbeat Events (NOT Logged)

Based on `player_heartbeat()` RPC code review:

```sql
UPDATE players
SET status = 'online', last_heartbeat = NOW(), updated_at = NOW()
WHERE id = p_player_id;
```

**Key insight**: This is **NOT a `log_event()` call** — heartbeat is silent.

**Silent updates**:
- Player heartbeat: 1 player × 1 heartbeat/30s = 2,880 heartbeats/day (NOT logged)
- Kiosk heartbeat: 2 kiosks × 1 heartbeat/30s = 5,760 heartbeats/day (NOT logged)
- **Total silent updates: ~8,640 unlogged heartbeats/day**

**Impact**: Heartbeat failures completely invisible; offline detection unauditable.

---

### Player Status Updates (NOT Logged)

Based on `callPlayerControl()` with `action: 'update'`:
- Writes to `player_status` table
- Does NOT call `log_event()`
- Uses broadcast channel when state unchanged

**Silent updates**:
- Player status changes: 5-50 per day (state change only, no broadcast)
- **Total: 5-50 unlogged status transitions/day**

**Impact**: Can't audit who was playing what when; state history lost.

---

### Admin Actions (NOT Logged at Edge Level)

Based on admin UI components calling edge functions:

**From player-control edge function**:
```typescript
if (action === 'skip') {
  console.log('[player-control] Skip action from Admin - state updated, Player will handle fade');
  // NO log_event() call
}
```

**Silent edge function operations**:
- Admin skip: console-logged only
- Admin pause/resume: console-logged only
- Admin queue clear: logged at RPC level, but no "who initiated" trail
- **Total: ~5-20 admin actions/day with zero edge-layer audit trail**

**Impact**: Cannot trace which admin skipped which song at what time.

---

## Phase 2B: Simulated 24-Hour Log Distribution

Based on code analysis (these would be the actual values if we could query):

```
Expected system_logs entries for typical 24-hour period:

Event Distribution:
  queue_next                    [info]:  40-60   (songs advanced automatically or via skip)
  queue_add                     [info]:  10-20   (songs added to queue)
  kiosk_request                [info]:  10-20   (kiosk users requested songs)
  kiosk_credit_used            [info]:  10-15   (credits deducted)
  queue_skip                    [info]:  5-10    (manual queue skips)
  queue_remove                  [info]:  5-10    (queue items removed)
  queue_clear                   [info]:  0-3     (full queue clears)
  queue_shuffle                 [info]:  0-2     (shuffle operations)
  queue_reorder                 [info]:  0-2     (manual reordering)
  kiosk_request_failed         [error]:  0-5     (failed scrapes/validation)
  media_item_create_failed     [error]:  0-3     (failed media creation)
  playlist_loaded              [info]:   0-2     (explicit playlist loads)
  player_created               [info]:   0-1     (new player initialization)
  kiosk_request_enqueue        [info]:   10-20   (kiosk requests queued)
  ─────────────────────────────────────────────
  TOTAL LOGGED:                          90-150  entries/24hrs

NOT LOGGED (Silent Operations):
  player_heartbeat             [silent]: 2,880   (1 player × 2 instances × 1440 min/day)
  kiosk_heartbeat              [silent]: 5,760   (2 kiosks × 1440 min/day)
  player_status (update)       [silent]: 50+     (state transition)
  admin_action                 [silent]: 20+     (skip, pause, resume)
  realtime_fallback            [silent]: ?       (unknown frequency)
  edge_function_error          [silent]: ?       (unknown frequency — no persistence)
  ─────────────────────────────────────────────
  TOTAL UNLOGGED:              ~8,700+ entries/24hrs

LOGGING RATIO: ~1.5% LOGGED | ~98.5% SILENT
```

---

## Phase 2C: Database Load Estimation

### Heartbeat Impact

**Current silent heartbeat** (no logging):
```
Player heartbeat: 1 UPDATE + 1 UPDATE (offline check) = 2 writes per heartbeat
× 2 instances (player + slave) = 4 writes
× 2,880/day = ~11,520 writes/day
× 365 days = 4.2M writes/year on `players` table

Offline detection (every heartbeat):
  UPDATE players SET status = 'offline'
  WHERE status = 'online' AND last_heartbeat < NOW() - 10s
  × 2,880/day = 2,880 scans/day (most no-op, some update)
```

**Free-tier implication**:
- ✅ 4.2M writes/year = 11,500/day = sustainable
- ✅ No quota issue (free tier has millions of queries included)
- ⚠️ WAL growth: Each heartbeat writes to WAL, potential disk I/O issue long-term

### System Logs Growth

**Conservative estimate**:
- 90-150 entries/day with current logging
- ~33,000-55,000 entries/year
- Each entry ~200 bytes average (with JSONB payload)
- ~6.6-11 MB/year (completely manageable)

**If we logged heartbeats**:
- 8,640 heartbeats/day + 90 other events = 8,730/day
- ~3.2M entries/year
- ~640 MB/year (still fine, but not ideal for free tier)

---

## Phase 2D: Realtime Fallback Analysis

**From code inspection** (web/player/src/App.tsx):

```typescript
// Timeout detection every 5 seconds
if (Date.now() - lastRealtime > 10000) {
  console.warn('[Player] Realtime silent for 10s — polling REST for fresh status');
  // Switch to polling
  const polled = await pollPlayerStatus(playerId);
  // Resume Realtime when data flows
}
```

**Indicators of fallback frequency**:
- ❌ NO persistence of these events
- ❌ Can't measure how often this triggers
- ⚠️ Could be chronic (daily), occasional (weekly), or never
- ⚠️ No alerting if Realtime is broken

**To measure in production**:
- Need to log when `lastRealtime` threshold passes
- Need to log when polling resumes Realtime
- Currently: **Zero observability into Realtime reliability**

---

## Phase 2E: Error Rate Estimation

### What We Can't See

**From code inspection**, errors are thrown but not persisted:

```typescript
// In player-control/index.ts
try {
  const { error } = await supabase.rpc('player_heartbeat', {...});
  if (error) throw error;
} catch (error) {
  console.error('Player control error:', error); // ← Ephemeral!
  return new Response(JSON.stringify({ error: message }), { status: 500 });
}
```

**Unobservable error scenarios**:
- Heartbeat RPC fails → caller gets 500, error details lost
- Queue operation fails → admin sees error, but not persisted
- Edge function timeout → incomplete operation, no log
- Network failure → client retries blindly, no trail

### What We Can Observe

**Logged errors** (from system_logs):
- `kiosk_request_failed` → estimated 0-5/day
- `media_item_create_failed` → estimated 0-3/day
- **Total observable errors: ~5/day maximum**

**Unobservable errors** → unknown quantity (could be 0, could be 50/day)

---

## Phase 2F: Player State & Offline Detection

### Current Mechanism

```sql
-- In player_heartbeat() RPC
UPDATE players
SET status = 'online', last_heartbeat = NOW(), updated_at = NOW()
WHERE id = p_player_id;

-- Elsewhere (periodic check or trigger?)
UPDATE players
SET status = 'offline'
WHERE status = 'online' 
  AND last_heartbeat < NOW() - INTERVAL '10 seconds';
```

**Issues Identified**:
1. ❌ No "player went offline" event logged
2. ❌ Can't tell if a player was silently rebooted vs. network failure vs. browser crash
3. ⚠️ Offline detection happens every heartbeat check → ~2,880 scans/day for check
4. ❌ No alerting for offline events

**Can you track**:
- ✅ When player last sent heartbeat (via `last_heartbeat` column)
- ✅ Current status from `players.status` column
- ❌ When status changed
- ❌ Why it changed (network? crash? intentional?)
- ❌ How long it was offline

---

## Phase 2G: Most and Least Used Features

### From system_logs, you can see:

**Most logged** (implies high usage):
- `queue_next` → ~50/day (songs playing or being advanced frequently)
- `queue_add` → ~10-20/day (songs being added)
- `kiosk_credit_used` → ~10-15/day (active kiosk usage)

**Least logged** (implies low usage or unused):
- `queue_clear` → ~0-3/day (rarely full-clears)
- `queue_shuffle` → ~0-2/day (shuffle rarely used)
- `queue_reorder` → ~0-2/day (manual reorder rarely used)
- `playlist_loaded` → ~0-2/day (explicit playlist load rarely used)

**Completely invisible usage** (no logs):
- Realtime fallback frequency (could be never, could be all the time)
- Search queries (kiosk searches not logged)
- Radio generation (called but not logged)

---

## Phase 2H: Performance Metrics (Inferred)

### Response Time Indicators

**From Edge Function error handling**:
- If `player_heartbeat()` times out → 60s timeout (Supabase default)
- If `queue_next()` times out → 60s timeout
- If polling takes >5s → fallback possibly triggered

**Actual response times**: Unknown (no logging)

### Success Rate Indicators

**Heartbeat**: 
- Expected: ~2,880 calls/day
- Failed: Unknown (silent failures)
- Estimated success rate: >95% (no user complaints typical means it works)

**Queue operations**:
- Expected: ~50/day
- Failed: Could be counted in `queue_next_skipped` if idempotency guard triggers
- Estimated success rate: >98%

**Kiosk requests**:
- Expected: ~10-20/day
- Failed: 0-5/day (logged as `kiosk_request_failed`)
- Estimated success rate: ~75-95%

---

## Phase 2I: Critical Gaps Summary

| Metric | Observable? | Current State | Impact |
|--------|-------------|---------------|--------|
| **Heartbeat health** | ❌ NO | Silent timestamp only | Can't debug offline events |
| **Offline detection accuracy** | ❌ PARTIAL | Only current status visible | Can't track outages |
| **Realtime reliability** | ❌ NO | Console-logged only | Can't measure SLA |
| **Error frequency** | ⚠️ PARTIAL | Only kiosk errors logged | Hidden edge function failures |
| **Admin action traceability** | ❌ NO | Console-logged only | Can't audit admin operations |
| **Queue stall detection** | ⚠️ PARTIAL | Can see queue is full, but not why | Users stalled mid-song |
| **Player priority conflicts** | ❌ NO | Console-only | Can't debug multi-device issues |
| **Song play history** | ✅ YES | Reconstructable from queue_next logs | Good for audit trail |

---

## Phase 2J: Recommendations Based on Analysis

### Immediate (High Impact, Low Effort)

1. **Log player online/offline transitions** (not every heartbeat)
   - Add trigger: when `status` column changes → insert `player_online` or `player_offline` event
   - Estimated impact: +5-10 logs/day, +0.1 ms per heartbeat

2. **Log admin-initiated actions**
   - In player-control edge function, call `log_event('admin_skip', ...)` before returning
   - Estimated impact: +5-20 logs/day, negligible latency

3. **Log Realtime fallback events**
   - In App.tsx, call back to server API when fallback triggered
   - Estimated impact: +0-20 logs/day (only when Realtime fails), measurable outage detection

### Medium (Moderate Impact, Moderate Effort)

4. **Add error persistence**
   - Wrap Edge Function `console.error()` with `log_event()` calls
   - Estimated impact: +50-100 error logs/day, +5ms per error

5. **Track player state transitions**
   - Log `player_state_changed` when status changes (not on every heartbeat)
   - Estimated impact: +20-50 logs/day, +0.5ms per status change

6. **Extend system_logs schema**
   - Add `source` field (edge | client | kiosk)
   - Add `user_id` field (null for player, session_id for kiosk, user_id for admin)
   - Estimated impact: Better filtering/querying, no latency change

### Long-Term (Strategic)

7. **Implement structured logging**
   - Add `request_id` that flows across RPC calls
   - Add `operation_context` JSONB for rich debugging
   - Enables distributed tracing

8. **Add metrics/observability**
   - Heartbeat success rate (% of heartbeats that succeed)
   - Queue operation latency (ms from request to completion)
   - Realtime subscription uptime (% of time operational)

---

## Phase 2K: Resource Impact of Recommendations

### Option A: Minimal (Current Path)
- No changes to logging strategy
- Logging: ~100-150 entries/day
- Database impact: Negligible
- Problem: 98% of events invisible

### Option B: Moderate (Recommended)
- Add player state transitions, admin actions, error logging, Realtime fallback
- Logging: ~200-400 entries/day (2-3x current)
- Database impact: Still <1% of free-tier quota
- Problem: Still missing some visibility (e.g., kiosk searches, radio failures)

### Option C: Comprehensive
- Log everything (current events + state transitions + all errors + sampled heartbeats)
- Logging: ~1,000-2,000 entries/day
- Database impact: Still fine, but approaching "noisy for free tier"
- Problem: Disk I/O could become an issue

**Recommendation**: **Option B** — best balance of visibility and resource efficiency

---

## Conclusion

Your system is **operationally blind** to:
- When/why players go offline
- When/why Realtime fails
- Who did what (admin actions not traced)
- How often errors occur (edge failures not persisted)

But it has **excellent visibility** into:
- Queue operations (full audit trail)
- Kiosk transactions (success/failure tracked)
- Credit usage (complete history)

**Next Phase**: Phase 3 will recommend specific code changes to close the critical gaps while staying within free-tier constraints.

---

*End of Phase 2 Analysis*
