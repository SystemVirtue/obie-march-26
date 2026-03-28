-- Reduce Realtime publication to only tables that have active frontend subscriptions.
-- Tables like media_items, players, playlists, playlist_items, r2_files, and system_logs
-- were published but never subscribed to via Realtime, causing unnecessary WAL processing
-- and contributing to connection pool exhaustion.

ALTER PUBLICATION supabase_realtime DROP TABLE IF EXISTS public.media_items;
ALTER PUBLICATION supabase_realtime DROP TABLE IF EXISTS public.players;
ALTER PUBLICATION supabase_realtime DROP TABLE IF EXISTS public.playlist_items;
ALTER PUBLICATION supabase_realtime DROP TABLE IF EXISTS public.playlists;
ALTER PUBLICATION supabase_realtime DROP TABLE IF EXISTS public.r2_files;
ALTER PUBLICATION supabase_realtime DROP TABLE IF EXISTS public.system_logs;

-- Remaining in publication (actively subscribed by frontend):
--   app_config       (all apps - version reload)
--   kiosk_sessions   (kiosk - session state)
--   player_settings  (player/admin/kiosk - settings sync)
--   player_status    (player/admin - playback state)
--   queue            (player/admin/kiosk - queue updates)
