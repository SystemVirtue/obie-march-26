-- 0027_add_queue_shuffle.sql
-- Atomic server-side queue shuffle RPC.
-- Replaces client-side Fisher-Yates + retry logic that previously lived in:
--   - web/admin/src/App.tsx handleShuffle() (~46 lines, up to 5 retries on 23505)
--   - web/player/src/App.tsx shuffleOnLoad (~26 lines, direct queue read)
--
-- The client's retry loop existed because concurrent INSERT/UPDATE could trigger
-- UNIQUE(player_id, type, position) violations (Postgres error 23505).
-- Solving it here under pg_advisory_xact_lock eliminates that race entirely.

CREATE OR REPLACE FUNCTION queue_shuffle(
  p_player_id UUID,
  p_type      TEXT DEFAULT 'normal'
)
RETURNS void AS $$
BEGIN
  -- Acquire the same advisory lock used by all other queue RPCs.
  -- This prevents concurrent reorders, adds, or removes from conflicting.
  PERFORM pg_advisory_xact_lock(hashtext('queue_' || p_player_id::text));

  -- Assign new sequential positions (0-based) in a random order.
  -- The CTE computes all new positions before any UPDATE fires, so the
  -- UNIQUE(player_id, type, position) constraint is never transiently violated.
  WITH shuffled AS (
    SELECT
      id,
      ROW_NUMBER() OVER (ORDER BY RANDOM()) - 1 AS new_pos
    FROM queue
    WHERE player_id  = p_player_id
      AND type       = p_type
      AND played_at IS NULL
  )
  UPDATE queue q
  SET    position = s.new_pos
  FROM   shuffled s
  WHERE  q.id = s.id;

  -- Log the shuffle event (same pattern as other queue RPCs).
  PERFORM log_event(
    p_player_id,
    'queue_shuffle',
    'info',
    jsonb_build_object('type', p_type)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute to authenticated and service role
GRANT EXECUTE ON FUNCTION queue_shuffle(UUID, TEXT)
  TO authenticated, service_role;
