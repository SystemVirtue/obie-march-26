-- ============================================================
-- Find orphaned playlists (no valid owner/admin)
-- ============================================================

-- Orphaned playlists: playlists whose player has no owner_id
-- OR player doesn't exist
-- OR player has no memberships with 'admin' or 'owner' role

SELECT
    p.id AS playlist_id,
    p.name AS playlist_name,
    p.player_id,
    pl.name AS player_name,
    pl.owner_id,
    pl.jukebox_slug,
    pl.created_at AS player_created_at,
    (SELECT COUNT(*) FROM playlist_items WHERE playlist_id = p.id) AS song_count,
    -- Check for admin memberships
    EXISTS(
        SELECT 1 FROM player_memberships pm
        WHERE pm.player_id = p.player_id
        AND pm.role IN ('admin', 'owner')
    ) AS has_admin,
    -- List all memberships for this player
    (SELECT string_agg(pm.user_id || ':' || pm.role, ', ')
     FROM player_memberships pm
     WHERE pm.player_id = p.player_id
    ) AS memberships
FROM playlists p
LEFT JOIN players pl ON p.player_id = pl.id
WHERE
    -- Case 1: Player doesn't exist (broken FK reference)
    pl.id IS NULL
    OR
    -- Case 2: Player has no owner_id and no admin memberships
    (pl.owner_id IS NULL
     AND NOT EXISTS(
         SELECT 1 FROM player_memberships pm
         WHERE pm.player_id = p.player_id
         AND pm.role IN ('admin', 'owner')
     ))
    OR
    -- Case 3: Player exists but has no memberships at all (owner_id may be stale)
    NOT EXISTS(
        SELECT 1 FROM player_memberships pm
        WHERE pm.player_id = p.player_id
    )
ORDER BY p.created_at DESC;
