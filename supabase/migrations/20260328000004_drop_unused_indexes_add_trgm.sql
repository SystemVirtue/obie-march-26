-- Drop unused indexes that waste write IO on every INSERT/UPDATE/DELETE.
-- All have 0 scans in pg_stat_user_indexes.

-- idx_players_priority_player_id: 0 scans
DROP INDEX IF EXISTS idx_players_priority_player_id;

-- idx_queue_player_type_position: 0 scans (duplicate of queue_player_type_pos_uniq which has 25K scans)
DROP INDEX IF EXISTS idx_queue_player_type_position;

-- idx_players_owner: 0 scans
DROP INDEX IF EXISTS idx_players_owner;

-- idx_r2_files_bucket: 0 scans
DROP INDEX IF EXISTS idx_r2_files_bucket;

-- idx_r2_files_title: GIN full-text index, 2.4MB, 0 scans (wrong index type for ILIKE queries)
DROP INDEX IF EXISTS idx_r2_files_title;

-- queue_player_id_id_key: 0 scans
DROP INDEX IF EXISTS queue_player_id_id_key;

-- ============================================================================
-- Add pg_trgm trigram indexes for r2_files ILIKE '%term%' queries.
-- Currently these queries do full sequential scans (1,635 scans reading 13.3M tuples).
-- pg_trgm GIN indexes support ILIKE with leading wildcards.
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX idx_r2_files_title_trgm ON public.r2_files USING gin (title public.gin_trgm_ops);
CREATE INDEX idx_r2_files_artist_trgm ON public.r2_files USING gin (artist public.gin_trgm_ops);
CREATE INDEX idx_r2_files_file_name_trgm ON public.r2_files USING gin (file_name public.gin_trgm_ops);

-- ============================================================================
-- Add missing foreign key index flagged by Supabase advisor:
-- playlists.player_id has FK constraint but no covering index.
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_playlists_player_id ON public.playlists(player_id);

-- ============================================================================
-- Add queue cleanup function to remove played items older than 24 hours.
-- The queue table has high write churn (20K inserts, 58K updates, 18K deletes)
-- and keeping old played items bloats the table unnecessarily.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.cleanup_old_queue_items()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM public.queue
  WHERE played_at IS NOT NULL
    AND played_at < now() - interval '24 hours';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;
