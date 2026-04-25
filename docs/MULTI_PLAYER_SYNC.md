# Multi-Player & Sync Model (Current Revised Implementation)

## 1) Player identity and tenant scoping

- Each jukebox maps to a unique `player_id`.
- Slug-based routing resolves human-friendly URLs (for example `/MYBAR`) to the canonical `player_id` via `resolve_jukebox_slug`.
- Admin access is constrained to jukeboxes returned by membership lookups (`getMyJukeboxes`), then all app reads/writes are scoped by that active `player_id`.

## 2) Multi-player behavior in Admin

- Admin resolves the active jukebox from URL slug and memberships.
- Queue, status, settings, and kiosk session subscriptions are all filtered by the currently active `player_id`.
- Connected device visibility subscribes across *all* owned/accessible `player_id` values, so operators can monitor all instances while controlling one active jukebox context at a time.

## 3) Player runtime sync

- The player app subscribes to queue updates with `filter: player_id=eq.<PLAYER_ID>`.
- When queue rows transition to `status='playing'`, the player loads that media item and avoids duplicate loads by checking the active queue id.
- A separate identify-event subscription is also scoped by `player_id` for targeted device identification overlays.

## 4) Kiosk runtime sync

- Kiosk slug resolves to `player_id`, then all session/init/heartbeat operations use that id.
- Kiosk subscribes to:
  - player settings (by `player_id`),
  - player status (by `player_id`),
  - queue (by `player_id`),
  - kiosk session credits (by `session_id`).
- Kiosk heartbeat keeps session liveness current so admin can distinguish active vs stale sessions.

## 5) Realtime consistency strategy

- `subscribeToQueue` performs an initial fetch and debounced refetch after any relevant queue change event.
- `subscribeToPlayerStatus` uses payload-direct merges for lightweight progress updates and only refetches joined media rows when media identity changes.
- `subscribeToPlayerSettings` and `subscribeToKioskSession` do an initial fetch plus scoped realtime updates.

## 6) Server-side authority

- Clients are thin: queue progression/control remains server-authoritative via RPCs and database state.
- Queue operations and selection are partitioned per `player_id`, preventing cross-jukebox state bleed.

This design gives multi-tenant isolation by `player_id` while preserving low-latency cross-surface sync (admin/player/kiosk) through scoped Supabase Realtime subscriptions.
