-- Reduce Realtime publication to only tables that have active frontend subscriptions.
-- Tables like media_items, players, playlists, playlist_items, r2_files, and system_logs
-- were published but never subscribed to via Realtime, causing unnecessary WAL processing
-- and contributing to connection pool exhaustion.
DO $$ BEGIN -- Drop tables from publication if they exist
IF EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'media_items'
) THEN ALTER PUBLICATION supabase_realtime DROP TABLE public.media_items;
END IF;
IF EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'players'
) THEN ALTER PUBLICATION supabase_realtime DROP TABLE public.players;
END IF;
IF EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'playlist_items'
) THEN ALTER PUBLICATION supabase_realtime DROP TABLE public.playlist_items;
END IF;
IF EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'playlists'
) THEN ALTER PUBLICATION supabase_realtime DROP TABLE public.playlists;
END IF;
IF EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'r2_files'
) THEN ALTER PUBLICATION supabase_realtime DROP TABLE public.r2_files;
END IF;
IF EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'system_logs'
) THEN ALTER PUBLICATION supabase_realtime DROP TABLE public.system_logs;
END IF;
END $$;
-- Remaining in publication (actively subscribed by frontend):
--   app_config       (all apps - version reload)
--   kiosk_sessions   (kiosk - session state)
--   player_settings  (player/admin/kiosk - settings sync)
--   player_status    (player/admin - playback state)
--   queue            (player/admin/kiosk - queue updates)