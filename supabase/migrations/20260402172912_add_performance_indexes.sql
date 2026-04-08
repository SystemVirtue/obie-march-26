-- =============================================================================
-- Add performance indexes
-- Applied directly to DB on 2026-04-02; stub added to keep local migrations in sync.
--
-- Added indexes flagged by Supabase performance advisor:
--   - idx_player_status_current_media_id: speeds up idempotency guard lookups
--   - idx_players_priority_player_id: FK index for priority player joins
--   - idx_players_owner_id: FK index for ownership joins
--
-- Also converted queue_player_type_pos_uniq from partial (WHERE played_at IS NULL)
-- to non-partial, anticipating the queue_next DELETE-based rewrite.
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_player_status_current_media_id
  ON public.player_status (current_media_id);

CREATE INDEX IF NOT EXISTS idx_players_priority_player_id
  ON public.players (priority_player_id);

CREATE INDEX IF NOT EXISTS idx_players_owner_id
  ON public.players (owner_id);

-- Convert queue unique index from partial to non-partial.
-- Required by the queue_next DELETE approach (played items are removed,
-- so the WHERE played_at IS NULL condition is no longer needed).
DROP INDEX IF EXISTS public.queue_player_type_pos_uniq;
CREATE UNIQUE INDEX queue_player_type_pos_uniq
  ON public.queue (player_id, type, position);

-- Drop the idx_playlists_player_id index (flagged as unused by advisor).
DROP INDEX IF EXISTS public.idx_playlists_player_id;
