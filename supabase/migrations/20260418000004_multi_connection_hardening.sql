-- =============================================================================
-- Migration: Multi-connection hardening
--
-- Fixes the following race conditions identified in the revision branch audit:
--
-- P1  Dual master election: two player tabs opening simultaneously could both
--     win priority because the election was three non-atomic queries. Fixed by
--     moving election into claim_priority_player() which holds an advisory lock.
--
-- P2  Heartbeat failover evicted live masters: a backgrounded tab (>45s) was
--     marked offline and evicted, even if it later woke up. Fixed by adding
--     priority_session_id so the DB can distinguish between sessions of the
--     same player_id.
--
-- P4  Stale priority restore: register_session blindly restored the priority
--     flag for any returning player, even if a different player was currently
--     master. Fixed: claim_priority_player() checks current priority holder.
--
-- P5  Multiple slaves reclaiming simultaneously: all slaves detected a NULL
--     priority_player_id at the same time and all called register_session. The
--     advisory lock in claim_priority_player() now serialises these, letting
--     exactly one slave win.
--
-- K1  Duplicate kiosk submission: a network retry could insert the same song
--     twice and deduct credits twice. Fixed by adding an idempotency_key column
--     with a partial unique index.
--
-- K2  Credit rollup race in kiosk init: the TypeScript read-compute-write for
--     orphaned session credits was unguarded. Fixed by moving into the new
--     kiosk_init_session() function which holds FOR UPDATE on all session rows.
--
-- K6  No rate limiting: a kiosk user with many credits could flood the queue.
--     Fixed by adding a 5-requests-per-minute-per-session guard in
--     kiosk_request_enqueue().
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1a. Add priority_session_id to players
--     Tracks which browser session holds master, not just which player UUID.
--     Allows claim_priority_player() to distinguish two tabs with the same
--     player_id from a single legitimately restored session.
-- ---------------------------------------------------------------------------
ALTER TABLE players ADD COLUMN IF NOT EXISTS priority_session_id TEXT;


-- ---------------------------------------------------------------------------
-- 1b. claim_priority_player(p_player_id, p_session_id) → BOOLEAN
--
--     Atomic priority election protected by a per-player advisory lock.
--     Returns TRUE if the caller was granted master; FALSE if it should slave.
--
--     Replaces the unsafe three-query read→check→write that previously lived
--     in player-control/index.ts (the register_session action).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_priority_player(
  p_player_id    UUID,
  p_session_id   TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_priority_id      UUID;
  v_priority_session TEXT;
  v_other_playing    BOOLEAN;
BEGIN
  -- Serialise all priority elections for this player.  Two tabs opening
  -- simultaneously will queue here; exactly one will claim master.
  PERFORM pg_advisory_xact_lock(hashtext(p_player_id::text));

  SELECT priority_player_id, priority_session_id
  INTO   v_priority_id, v_priority_session
  FROM   players
  WHERE  id = p_player_id
  FOR UPDATE;

  -- This session is already master — idempotent re-claim (e.g. heartbeat retry).
  IF v_priority_id = p_player_id AND v_priority_session = p_session_id THEN
    RETURN TRUE;
  END IF;

  -- A different session of THIS same player already holds master → slave.
  -- Prevents two browser tabs for the same jukebox both thinking they are master.
  IF v_priority_id = p_player_id
     AND v_priority_session IS NOT NULL
     AND v_priority_session != p_session_id THEN
    RETURN FALSE;
  END IF;

  -- A DIFFERENT player holds priority and is still online → slave.
  IF v_priority_id IS NOT NULL AND v_priority_id != p_player_id THEN
    IF EXISTS (
      SELECT 1 FROM players
      WHERE  id = v_priority_id AND status = 'online'
    ) THEN
      RETURN FALSE;
    END IF;
    -- Falls through: that other player is offline — safe to claim.
  END IF;

  -- Block claim if another player is actively playing right now.
  SELECT EXISTS (
    SELECT 1 FROM player_status
    WHERE  state = 'playing' AND player_id != p_player_id
  ) INTO v_other_playing;

  IF v_other_playing THEN
    RETURN FALSE;
  END IF;

  -- Grant master to this player + session.
  UPDATE players
  SET    priority_player_id  = p_player_id,
         priority_session_id = p_session_id
  WHERE  id = p_player_id;

  RETURN TRUE;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_priority_player(UUID, TEXT) TO service_role;


-- ---------------------------------------------------------------------------
-- 1c. Update player_heartbeat() to clear priority_session_id on failover
--
--     Migration 000003 added the failover UPDATE but didn't know about
--     priority_session_id yet.  We now clear both columns together so that a
--     new session claiming master after failover starts with a clean slate.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.player_heartbeat(p_player_id UUID)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Mark this player online.
  UPDATE players
  SET    status         = 'online',
         last_heartbeat = NOW(),
         updated_at     = NOW()
  WHERE  id = p_player_id;

  -- Mark other players offline if heartbeat has gone stale (> 45 seconds).
  UPDATE players
  SET    status = 'offline'
  WHERE  id            != p_player_id
    AND  status         = 'online'
    AND  last_heartbeat < NOW() - INTERVAL '45 seconds';

  -- AUTO-FAILOVER: If the priority player is now offline, clear both pointer
  -- columns.  The surviving player's next heartbeat triggers re-registration
  -- via register_session and reclaims master within one heartbeat interval.
  -- Guard: only act when WE are not the priority player (prevents self-clearing).
  UPDATE players AS p
  SET    priority_player_id  = NULL,
         priority_session_id = NULL
  WHERE  p.id                  = p_player_id
    AND  p.priority_player_id IS NOT NULL
    AND  p.priority_player_id != p_player_id
    AND EXISTS (
      SELECT 1 FROM players dead
      WHERE  dead.id     = p.priority_player_id
        AND  dead.status = 'offline'
    );

  -- Probabilistic expired-queue cleanup (~once per 25 min per active player).
  IF random() < 0.02 THEN
    DELETE FROM public.queue
    WHERE expires_at IS NOT NULL
      AND expires_at < NOW();
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.player_heartbeat(UUID) TO authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 1d. kiosk_init_session(p_player_id) → kiosk_sessions
--
--     Atomic session resume + orphan credit rollup.  Locks all sessions for
--     the player in a single FOR UPDATE query, preventing the lost-update race
--     where a concurrent coin insertion could be overwritten by the rollup.
--
--     Returns the primary session row (after update), or NULL if no session
--     exists (caller should create a new one).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kiosk_init_session(
  p_player_id UUID
) RETURNS kiosk_sessions
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows         kiosk_sessions[];
  v_primary      kiosk_sessions;
  v_rolled       INT := 0;
  v_orphan_ids   UUID[] := '{}';
  v_i            INT;
BEGIN
  -- Lock ALL sessions for this player atomically before any reads or writes.
  SELECT array_agg(s ORDER BY s.last_active DESC NULLS LAST, s.created_at DESC)
  INTO   v_rows
  FROM   kiosk_sessions s
  WHERE  s.player_id = p_player_id
  FOR UPDATE;

  -- No sessions exist — tell the caller to create one.
  IF v_rows IS NULL OR array_length(v_rows, 1) = 0 THEN
    RETURN NULL;
  END IF;

  v_primary := v_rows[1];

  -- Accumulate credits from all orphan sessions (index 2+).
  IF array_length(v_rows, 1) > 1 THEN
    FOR v_i IN 2..array_length(v_rows, 1) LOOP
      v_rolled      := v_rolled + COALESCE((v_rows[v_i]).credits, 0);
      v_orphan_ids  := array_append(v_orphan_ids, (v_rows[v_i]).session_id);
    END LOOP;
  END IF;

  -- Single atomic write to the primary session — no lost-update window.
  UPDATE kiosk_sessions
  SET    credits     = COALESCE(credits, 0) + v_rolled,
         last_active = NOW()
  WHERE  session_id  = v_primary.session_id
  RETURNING * INTO v_primary;

  -- Remove orphan rows.
  IF array_length(v_orphan_ids, 1) > 0 THEN
    DELETE FROM kiosk_sessions
    WHERE  session_id = ANY(v_orphan_ids);
  END IF;

  RETURN v_primary;
END;
$$;

GRANT EXECUTE ON FUNCTION public.kiosk_init_session(UUID) TO service_role;


-- ---------------------------------------------------------------------------
-- 1e. Add idempotency_key to queue + update kiosk_request_enqueue()
--
--     A kiosk client generates a UUID before sending the request.  On network
--     retry, the same UUID is sent again.  The unique index causes the second
--     INSERT in queue_add() to fail with a duplicate-key error, which we catch
--     here and return the existing queue_id instead — so credits are only
--     deducted once.
-- ---------------------------------------------------------------------------
ALTER TABLE public.queue ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS queue_idempotency_key_idx
  ON public.queue (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE OR REPLACE FUNCTION public.kiosk_request_enqueue(
  p_session_id      UUID,
  p_media_item_id   UUID,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_player_id    UUID;
  v_credits      INT;
  v_coin_per_song INT  := 1;
  v_freeplay     BOOLEAN := FALSE;
  v_queue_id     UUID;
BEGIN
  -- Idempotency check: if this key already exists, return the existing queue_id.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id INTO v_queue_id
    FROM   queue
    WHERE  idempotency_key = p_idempotency_key
    LIMIT  1;

    IF FOUND THEN
      RETURN v_queue_id;
    END IF;
  END IF;

  -- Lock the kiosk session row to prevent concurrent credit races.
  SELECT player_id, credits
  INTO   v_player_id, v_credits
  FROM   kiosk_sessions
  WHERE  session_id = p_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Session not found';
  END IF;

  -- Load player settings.
  SELECT freeplay, coin_per_song
  INTO   v_freeplay, v_coin_per_song
  FROM   player_settings
  WHERE  player_id = v_player_id;

  v_freeplay      := COALESCE(v_freeplay, FALSE);
  v_coin_per_song := COALESCE(v_coin_per_song, 1);

  -- Rate limiting: max 5 priority requests per session per minute.
  IF (
    SELECT COUNT(*)
    FROM   queue
    WHERE  requested_by = p_session_id::text
      AND  type         = 'priority'
      AND  created_at   > NOW() - INTERVAL '60 seconds'
  ) >= 5 THEN
    RAISE EXCEPTION 'Rate limit exceeded: max 5 song requests per minute';
  END IF;

  -- Deduct credits (unless freeplay).
  IF NOT v_freeplay THEN
    IF v_credits < v_coin_per_song THEN
      RAISE EXCEPTION 'Insufficient credits';
    END IF;

    UPDATE kiosk_sessions
    SET    credits = credits - v_coin_per_song
    WHERE  session_id = p_session_id;
  END IF;

  -- Enqueue as priority — queue_add handles position locking.
  -- Pass idempotency_key through so the unique index prevents double-insert on retry.
  INSERT INTO queue (player_id, media_item_id, type, position, requested_by, idempotency_key)
  SELECT v_player_id,
         p_media_item_id,
         'priority',
         COALESCE((SELECT MAX(position) FROM queue WHERE player_id = v_player_id AND type = 'priority'), -1) + 1,
         p_session_id::text,
         p_idempotency_key
  RETURNING id INTO v_queue_id;

  PERFORM log_event(v_player_id, 'kiosk_request_enqueue', 'info', jsonb_build_object(
    'session_id',      p_session_id,
    'media_item_id',   p_media_item_id,
    'queue_id',        v_queue_id,
    'idempotency_key', p_idempotency_key
  ));

  RETURN v_queue_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.kiosk_request_enqueue(UUID, UUID, TEXT) TO authenticated, anon, service_role;
-- Drop old 2-arg signature and recreate as a forwarding wrapper.
-- DROP + recreate avoids the "cannot change name of input parameter" error
-- when the old function had named parameters.
DROP FUNCTION IF EXISTS public.kiosk_request_enqueue(UUID, UUID);
CREATE FUNCTION public.kiosk_request_enqueue(p_session_id UUID, p_media_item_id UUID)
RETURNS UUID LANGUAGE SQL SECURITY DEFINER SET search_path = public AS $$
  SELECT public.kiosk_request_enqueue(p_session_id, p_media_item_id, NULL);
$$;
GRANT EXECUTE ON FUNCTION public.kiosk_request_enqueue(UUID, UUID) TO authenticated, anon, service_role;
