-- =============================================================================
-- Batch playlist operations to eliminate N+1 query patterns
--
-- 1. resequence_playlist_after_remove: single UPDATE to close position gap
--    after an item is removed (was: SELECT all + UPDATE each individually)
-- 2. playlist_reorder: batch position assignment from an ordered UUID array
--    (was: one UPDATE per item in a for-loop)
-- =============================================================================

-- Close the position gap after removing an item at a specific position.
-- All items with position > removed_position get decremented by 1.
CREATE OR REPLACE FUNCTION public.resequence_playlist_after_remove(
  p_playlist_id      UUID,
  p_removed_position INT
)
RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE playlist_items
  SET position = position - 1
  WHERE playlist_id = p_playlist_id
    AND position > p_removed_position;
$$;

GRANT EXECUTE ON FUNCTION public.resequence_playlist_after_remove(UUID, INT) TO authenticated, service_role;

-- Batch reorder: assign positions 0..N-1 from an ordered array of item IDs.
-- Uses unnest with ordinality to do it in a single UPDATE.
CREATE OR REPLACE FUNCTION public.playlist_reorder(
  p_playlist_id UUID,
  p_item_ids    UUID[]
)
RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE playlist_items pi
  SET position = arr.new_pos
  FROM (
    SELECT val AS item_id, (ordinality - 1)::int AS new_pos
    FROM unnest(p_item_ids) WITH ORDINALITY AS t(val, ordinality)
  ) arr
  WHERE pi.id = arr.item_id
    AND pi.playlist_id = p_playlist_id;
$$;

GRANT EXECUTE ON FUNCTION public.playlist_reorder(UUID, UUID[]) TO authenticated, service_role;
