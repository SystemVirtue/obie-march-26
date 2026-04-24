-- ============================================================
-- Find most recently created version of each orphaned playlist (unique names)
-- ============================================================

WITH orphaned_playlists AS (
    SELECT
        p.id,
        p.name,
        p.player_id,
        p.created_at,
        p.updated_at,
        (SELECT COUNT(*) FROM playlist_items pi WHERE pi.playlist_id = p.id) AS song_count,
        ROW_NUMBER() OVER (PARTITION BY p.name ORDER BY p.created_at DESC) AS rn
    FROM playlists p
    WHERE NOT EXISTS (
        SELECT 1 FROM players pl WHERE pl.id = p.player_id
    )
)
SELECT
    id AS playlist_id,
    name AS playlist_name,
    player_id,
    created_at,
    updated_at,
    song_count
FROM orphaned_playlists
WHERE rn = 1
ORDER BY name ASC;
