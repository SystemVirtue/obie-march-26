-- Fix 1: Set search_path = public on all SECURITY DEFINER functions that lack it.
--
-- A mutable search_path allows an attacker who can create objects in a schema
-- that appears earlier in the search_path to shadow system functions used
-- inside a SECURITY DEFINER function. Pinning search_path = public prevents
-- this class of search-path hijacking.
--
-- Fix 2: Tighten three overly-permissive RLS policies that use USING (true) /
-- WITH CHECK (true) for mutating operations, effectively bypassing row-level
-- security entirely for those operations.
--
-- kiosk_sessions  UPDATE: restrict to sessions belonging to a player the
--                         authenticated user is a member of.
-- player_status   UPDATE: same restriction.
-- system_logs     INSERT: restrict to service_role only (all application
--                         inserts go through SECURITY DEFINER log_event()).
--
-- NOTE: All kiosk operations (kiosk_increment_credit, kiosk_decrement_credit,
-- kiosk_request_enqueue) and all player-status mutations (queue_next,
-- queue_skip, etc.) are SECURITY DEFINER functions that bypass RLS, so
-- tightening direct-REST policies does not affect normal application flow.
--
-- Re-created from claude/session-management-system-7BhSv (deleted stale branch),
-- adapted for current main state:
-- - Removed ALTER for queue_next(uuid) which was dropped in 20260401000001
-- - Some newer functions already have search_path set; ALTER is idempotent

-- =============================================================================
-- Part 1: Fix mutable search_path on all flagged functions
-- =============================================================================

-- Trigger / utility functions
ALTER FUNCTION public.update_updated_at()                               SET search_path = public;
ALTER FUNCTION public.cleanup_expired_queue()                           SET search_path = public;

-- Player helper
ALTER FUNCTION public.player_heartbeat(uuid)                            SET search_path = public;

-- Logging helper
ALTER FUNCTION public.log_event(uuid, text, text, jsonb)                SET search_path = public;

-- Queue operations
ALTER FUNCTION public.queue_add(uuid, uuid, text, text)                 SET search_path = public;
ALTER FUNCTION public.queue_skip(uuid)                                  SET search_path = public;
ALTER FUNCTION public.queue_clear(uuid, text)                           SET search_path = public;
ALTER FUNCTION public.queue_remove(uuid)                                SET search_path = public;
-- queue_reorder has two overloads; fix both
ALTER FUNCTION public.queue_reorder(uuid, uuid[], text)                 SET search_path = public;
ALTER FUNCTION public.queue_reorder(uuid, uuid[], text, integer)        SET search_path = public;
ALTER FUNCTION public.queue_shuffle(uuid, text)                         SET search_path = public;
-- queue_next: only the 2-arg version exists (1-arg was dropped in 20260401000001)
ALTER FUNCTION public.queue_next(uuid, uuid)                            SET search_path = public;
ALTER FUNCTION public.queue_reorder_wrapper(uuid, uuid[], text)         SET search_path = public;
ALTER FUNCTION public.load_playlist(uuid, uuid, integer, boolean)       SET search_path = public;

-- Kiosk helpers
ALTER FUNCTION public.kiosk_increment_credit(uuid, integer)             SET search_path = public;
ALTER FUNCTION public.kiosk_decrement_credit(uuid, integer)             SET search_path = public;
ALTER FUNCTION public.kiosk_request_enqueue(uuid, uuid)                 SET search_path = public;

-- Playlist / player initialisation
ALTER FUNCTION public.initialize_player_playlist(uuid)                  SET search_path = public;

-- Slug normalisation (IMMUTABLE, not SECURITY DEFINER, but pin for consistency)
ALTER FUNCTION public.normalize_jukebox_slug(text)                      SET search_path = public;

-- Media item upsert
ALTER FUNCTION public.create_or_get_media_item(text, text, text, text, text, integer, text, jsonb) SET search_path = public;

-- =============================================================================
-- Part 2: Tighten overly-permissive RLS policies
-- =============================================================================

-- 2a. kiosk_sessions UPDATE
-- Old: USING (true) — any role could update any session row
-- New: USING (public.is_player_member(player_id))
--      Only users who are members of the player owning the session can update.
DROP POLICY IF EXISTS "Kiosk can update own session" ON public.kiosk_sessions;
CREATE POLICY "Kiosk can update own session"
  ON public.kiosk_sessions FOR UPDATE
  USING (public.is_player_member(player_id));

-- 2b. player_status UPDATE
-- Old: USING (true) — any role could update any player's status row
-- New: USING (public.is_player_member(player_id))
DROP POLICY IF EXISTS "Player can update own status" ON public.player_status;
CREATE POLICY "Player can update own status"
  ON public.player_status FOR UPDATE
  USING (public.is_player_member(player_id));

-- 2c. system_logs INSERT
-- Old: WITH CHECK (true) for all roles
-- New: restricted to service_role only.
--      Application code inserts logs exclusively via log_event() which is
--      SECURITY DEFINER and therefore unaffected by this policy change.
DROP POLICY IF EXISTS "Service role can insert system_logs" ON public.system_logs;
CREATE POLICY "Service role can insert system_logs"
  ON public.system_logs FOR INSERT
  TO service_role
  WITH CHECK (true);
