# Master/Viewer Rollout Acceptance Gates

This project ships from Version 1 behavior by default.

- `VITE_ENABLE_MASTER_VIEWER_MODEL=false` is the safe default.
- Only flip to `true` after all gates below pass for the target jukebox environment.

## Required gates

1. **Failover drill (2+ tabs/devices)**
   - Start two `/player` clients.
   - Confirm one is master, one is viewer.
   - Kill/close master and verify viewer takeover within ~20–25s.
   - Verify queue advancement and status updates continue after takeover.

2. **No viewer writes**
   - Confirm only master emits playback control writes and queue-advance events.
   - Confirm viewers follow state changes but do not send ENDED/PLAYING/PAUSED queue-control writes.

3. **Admin observability**
   - Confirm admin Player Instances page shows master identity, connection health, and recent master-change logs.
   - Confirm “Refresh All Connections” receives live responses from connected players.
   - Confirm “Force Master” reassigns master deterministically.

4. **E2E + quality checks**
   - `npm run quality` passes.
   - `RUN_E2E_INTEGRATION=true npm test` passes with required Supabase/auth secrets.

5. **Rollback readiness**
   - Document who can toggle `VITE_ENABLE_MASTER_VIEWER_MODEL`.
   - Keep a one-step rollback plan: set the flag back to `false`.

## Production rollout recommendation

- Start with one low-risk venue.
- Observe for at least one business cycle.
- Expand gradually once no failover regressions are observed.

## PR sign-off template

Before merging any PR that enables `VITE_ENABLE_MASTER_VIEWER_MODEL=true` for a target environment, include:

- Date + environment tested (staging venue / production venue id).
- Failover drill evidence (timestamps for master drop + takeover).
- E2E command output summary (`RUN_E2E_INTEGRATION=true npm test`).
- Rollback operator + rollback steps confirmation.
