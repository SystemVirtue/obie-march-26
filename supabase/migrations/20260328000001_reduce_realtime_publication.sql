-- Reduce Realtime publication to only tables that have active frontend subscriptions.
-- Tables like media_items, players, playlists, playlist_items, r2_files, and system_logs
-- were published but never subscribed to via Realtime, causing unnecessary WAL processing
-- and contributing to connection pool exhaustion.

-- ALTER PUBLICATION does not support IF EXISTS, so we use a DO block to silently
-- skip tables that are not currently in the publication.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'public.media_items',
    'public.players',
    'public.playlist_items',
    'public.playlists',
    'public.r2_files',
    'public.system_logs'
  ] LOOP
    BEGIN
      EXECUTE format('ALTER PUBLICATION supabase_realtime DROP TABLE %s', t);
    EXCEPTION
      WHEN undefined_object  THEN NULL;  -- table not in publication
      WHEN undefined_table   THEN NULL;  -- table doesn't exist
    END;
  END LOOP;
END $$;

-- Remaining in publication (actively subscribed by frontend):
--   app_config       (all apps - version reload)
--   kiosk_sessions   (kiosk - session state)
--   player_settings  (player/admin/kiosk - settings sync)
--   player_status    (player/admin - playback state)
--   queue            (player/admin/kiosk - queue updates)
