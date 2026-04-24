-- ============================================================
-- List all Jukeboxes with statistics
-- Run via: npx supabase sql --file scripts/list-jukeboxes.sql
-- ============================================================

SELECT
    p.name AS jukebox,
    COALESCE(p.owner_id, 'system') AS created_by,
    (SELECT COUNT(*) FROM playlists WHERE player_id = p.id) AS playlist_count,
    (
        SELECT COUNT(*)
        FROM playlist_items pi
        JOIN playlists pl ON pi.playlist_id = pl.id
        WHERE pl.player_id = p.id
    ) AS song_count,
    (
        SELECT name
        FROM playlists
        WHERE player_id = p.id AND is_active = true
        LIMIT 1
    ) AS active_playlist,
    (
        SELECT mi.title
        FROM player_status ps
        LEFT JOIN media_items mi ON ps.current_media_id = mi.id
        WHERE ps.player_id = p.id
    ) AS now_playing_video
FROM players p
ORDER BY p.name;
