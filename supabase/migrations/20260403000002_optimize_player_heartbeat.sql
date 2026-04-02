-- Decouple offline detection from player_heartbeat.
--
-- Previously, every heartbeat call scanned ALL online players to mark stale
-- ones offline — an O(N) scan per heartbeat. Now the heartbeat is a simple
-- self-update, and offline detection is a separate function that can be
-- scheduled via pg_cron (every 15s) or called manually.

-- Simplified heartbeat: only updates the calling player
CREATE OR REPLACE FUNCTION player_heartbeat(
  p_player_id UUID
)
RETURNS void AS $$
BEGIN
  UPDATE players
  SET
    status = 'online',
    last_heartbeat = NOW(),
    updated_at = NOW()
  WHERE id = p_player_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Standalone offline detection: mark players offline if no heartbeat in 30s.
-- Increased from 10s to 30s to be more tolerant of network hiccups.
-- Schedule this via Supabase Dashboard > Database > Cron Jobs:
--   SELECT mark_stale_players_offline();
--   every 15 seconds (*/15 * * * * *)
CREATE OR REPLACE FUNCTION mark_stale_players_offline()
RETURNS integer AS $$
DECLARE
  affected integer;
BEGIN
  UPDATE players
  SET status = 'offline', updated_at = NOW()
  WHERE status = 'online'
    AND last_heartbeat < NOW() - INTERVAL '30 seconds';

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Schedule via pg_cron if the extension is available.
-- This is wrapped in a DO block so it won't fail if pg_cron isn't enabled.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('mark-stale-players-offline');
    PERFORM cron.schedule(
      'mark-stale-players-offline',
      '15 seconds',
      $cron$SELECT mark_stale_players_offline()$cron$
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  -- pg_cron not available or schedule failed — can be set up manually
  RAISE NOTICE 'pg_cron scheduling skipped: %. Set up manually in Supabase Dashboard.', SQLERRM;
END
$$;
