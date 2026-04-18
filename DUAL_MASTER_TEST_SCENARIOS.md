# Dual Master Bug Fix - Test Scenarios

## Scenario 1: Load Playlist While Song Playing (THE BUG CASE)

### BEFORE FIX (Broken)
```
Time  Player A           DB State               Player B           Result
----  --------           --------               --------           ------
T0    Playing Song 1     state: playing         (idle)             ✅ Working
T1                       state: loading         (registers)        ❌ BUG!
      (load_playlist)    priority_player_id: A  Checks: 'playing' → EMPTY
                                               Allows: Claim master!

T2    driving playback   state: loading         driving playback   ❌ TWO MASTERS
      Song 1               priority_player_id: A   priority_player_id: A   COLLISION!

T3    Song 1 ends        queue_next (A wins)    tries queue_next   ❌ Race condition
```

### AFTER FIX (Working)
```
Time  Player A           DB State               Player B           Result
----  --------           --------               --------           ------
T0    Playing Song 1     state: playing         (idle)             ✅ Working
T1                       state: loading         (registers)        ✅ FIXED!
      (load_playlist)    priority_player_id: A  Checks: ['loading', 'buffering', 'playing', 'paused']
                                               Finds: 'loading' → A is active
                                               Slaves: B becomes slave ✅

T2    driving playback   state: loading         silent              ✅ Only one master
      Song 1               priority_player_id: A     waitfor queue_next  

T3    Song 1 ends        queue_next by A        waits for queue     ✅ Clean transition
      Loads Playlist     state: loading         advance signal
      Song from P        Song 1 → Playlist 1

T4    transitions to     state: playing         (still slave)       ✅ Seamless
      Playlist Song 1    Playlist Song 1
```

## Scenario 2: Tab Refresh While Playing

### BEFORE: Both Broken (2x register_session race)
```
Tab A: Plays Song 1
Tab B: Refreshes → register_session
  → Checks 'playing' → finds A playing
  → B becomes slave ✓

Tab A: Refresh happens due to auto-update
  → Player state flips to 'loading'
  → register_session called
  → Checks 'playing' → finds NOTHING
  → **A reclaims master while ALREADY master** → Idempotent, OK

Tab B:  Still slave, good.

Result: Eventually consistent (A wins), but window of instability ✗
```

### AFTER: Fixed (More stable)
```
Tab A: Plays Song 1
Tab B: Refreshes → register_session
  → Checks ['loading', 'buffering', 'playing', 'paused'] → finds A in 'playing'
  → B becomes slave ✓

Tab A: Refresh happens
  → Player state flips to 'loading'
  → register_session called
  → Checks ['loading', 'buffering', 'playing', 'paused'] → finds self in 'loading'
  → Reclains master ✓ (idempotent)

Tab B: Sees queue advance from A, stays slave, good.

Result: Stable, deterministic, no collisions ✓
```

## Scenario 3: Playlist Load on Fresh Player Instance

### BEFORE
```
Admin:   Load Playlist A
        → queue_next by admin
        → Player 1 starts Song 1

Player 2: Opens in new tab
         → register_session
         → Checks 'playing' → finds P1 in 'playing'
         → P2 becomes slave ✓

Admin:   Load Playlist B
        → playlist-manager calls load_playlist
        → state → 'loading'
        → Song advance by P1

Player 2: Calls heartbeat → register_session check
         → Checks 'playing' → finds... nothing? (P1 was 'loading')
         → **P2 claims master** ✗ Collision!
```

### AFTER
```
Admin:   Load Playlist A
        → queue_next by admin
        → Player 1 starts Song 1

Player 2: Opens in new tab
         → register_session
         → Checks ['loading', 'buffering', 'playing', 'paused'] → finds P1 in 'playing'
         → P2 becomes slave ✓

Admin:   Load Playlist B
        → playlist-manager calls load_playlist
        → state → 'loading'
        → Song advance by P1

Player 2: Calls heartbeat → register_session check
         → Checks ['loading', 'buffering', 'playing', 'paused'] → finds P1 in 'loading'
         → P2 STAYS slave ✓ No collision!
```

## Test Checklist

- [ ] Open player in Tab A
- [ ] Start playing a song
- [ ] Open admin console
- [ ] Load a different playlist while tab A is playing
- [ ] Verify: Only ONE song plays at a time (not two overlapping)
- [ ] Verify: Song transitions smoothly when current song ends
- [ ] Open player in Tab B while A is playing
- [ ] Verify: Tab B becomes slave (no queue progression attempts)
- [ ] Verify: Player 1 continues playing through transition
- [ ] Refresh Tab A while playing
- [ ] Verify: Tab A reclaims master smoothly (no audio hiccup)
- [ ] Load playlist again - verify no dual playback
