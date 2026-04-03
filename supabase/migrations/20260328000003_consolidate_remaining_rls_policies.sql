-- Consolidate remaining duplicate permissive RLS policies.
-- When an ALL policy and a SELECT policy both exist for the same role,
-- Postgres evaluates BOTH for every SELECT query and ORs the results.
-- This doubles RLS overhead on the hottest tables.
--
-- Strategy: Replace ALL policies with specific INSERT/UPDATE/DELETE policies,
-- keeping the existing permissive SELECT policy as the sole SELECT path.

BEGIN;

-- ============================================================================
-- media_items
-- Before: "Admin full access to media_items" (ALL, auth.role()='authenticated')
--       + "Kiosk can read media items" (SELECT, true)
-- After:  Single SELECT true + INSERT/UPDATE/DELETE for authenticated
-- ============================================================================
DROP POLICY IF EXISTS "Admin full access to media_items" ON public.media_items;
-- "Kiosk can read media items" (SELECT, true) remains as the only SELECT policy

CREATE POLICY "Authenticated can modify media_items"
  ON public.media_items
  FOR ALL
  USING ((SELECT auth.role()) = 'authenticated')
  WITH CHECK ((SELECT auth.role()) = 'authenticated');

-- Wait - that recreates the ALL policy. Instead, use specific commands.
DROP POLICY IF EXISTS "Authenticated can modify media_items" ON public.media_items;

CREATE POLICY "Authenticated can insert media_items"
  ON public.media_items FOR INSERT
  WITH CHECK ((SELECT auth.role()) = 'authenticated');

CREATE POLICY "Authenticated can update media_items"
  ON public.media_items FOR UPDATE
  USING ((SELECT auth.role()) = 'authenticated')
  WITH CHECK ((SELECT auth.role()) = 'authenticated');

CREATE POLICY "Authenticated can delete media_items"
  ON public.media_items FOR DELETE
  USING ((SELECT auth.role()) = 'authenticated');

-- ============================================================================
-- player_settings
-- Before: "Member full access to own player_settings" (ALL, is_player_member)
--       + "Anon can read player settings" (SELECT, true)
-- After:  Single SELECT true + INSERT/UPDATE/DELETE for is_player_member
-- ============================================================================
DROP POLICY IF EXISTS "Member full access to own player_settings" ON public.player_settings;
-- "Anon can read player settings" (SELECT, true) remains

CREATE POLICY "Member can insert player_settings"
  ON public.player_settings FOR INSERT
  WITH CHECK (public.is_player_member(player_id));

CREATE POLICY "Member can update player_settings"
  ON public.player_settings FOR UPDATE
  USING (public.is_player_member(player_id))
  WITH CHECK (public.is_player_member(player_id));

CREATE POLICY "Member can delete player_settings"
  ON public.player_settings FOR DELETE
  USING (public.is_player_member(player_id));

-- ============================================================================
-- player_status
-- Before: "Member full access to own player_status" (ALL, is_player_member)
--       + "Anon can read player status" (SELECT, true)
--       + "Player can update own status" (UPDATE, true)
-- After:  Single SELECT true + single UPDATE true + INSERT/DELETE for is_player_member
-- ============================================================================
DROP POLICY IF EXISTS "Member full access to own player_status" ON public.player_status;
-- "Anon can read player status" (SELECT, true) remains
-- "Player can update own status" (UPDATE, true) remains

CREATE POLICY "Member can insert player_status"
  ON public.player_status FOR INSERT
  WITH CHECK (public.is_player_member(player_id));

CREATE POLICY "Member can delete player_status"
  ON public.player_status FOR DELETE
  USING (public.is_player_member(player_id));

-- ============================================================================
-- queue
-- Before: "Member access to own queue" (ALL, is_player_member)
--       + "Anon can read queue for their player" (SELECT, true)
-- After:  Single SELECT true + INSERT/UPDATE/DELETE for is_player_member
-- ============================================================================
DROP POLICY IF EXISTS "Member access to own queue" ON public.queue;
-- "Anon can read queue for their player" (SELECT, true) remains

CREATE POLICY "Member can insert queue"
  ON public.queue FOR INSERT
  WITH CHECK (public.is_player_member(player_id));

CREATE POLICY "Member can update queue"
  ON public.queue FOR UPDATE
  USING (public.is_player_member(player_id))
  WITH CHECK (public.is_player_member(player_id));

CREATE POLICY "Member can delete queue"
  ON public.queue FOR DELETE
  USING (public.is_player_member(player_id));

-- ============================================================================
-- r2_files
-- Before: "Authenticated full access to r2_files" (ALL, auth.role()='authenticated')
--       + "Anon can read r2_files" (SELECT, true)
-- After:  Single SELECT true + INSERT/UPDATE/DELETE for authenticated
-- ============================================================================
DROP POLICY IF EXISTS "Authenticated full access to r2_files" ON public.r2_files;
-- "Anon can read r2_files" (SELECT, true) remains

CREATE POLICY "Authenticated can insert r2_files"
  ON public.r2_files FOR INSERT
  WITH CHECK ((SELECT auth.role()) = 'authenticated');

CREATE POLICY "Authenticated can update r2_files"
  ON public.r2_files FOR UPDATE
  USING ((SELECT auth.role()) = 'authenticated')
  WITH CHECK ((SELECT auth.role()) = 'authenticated');

CREATE POLICY "Authenticated can delete r2_files"
  ON public.r2_files FOR DELETE
  USING ((SELECT auth.role()) = 'authenticated');

-- ============================================================================
-- player_memberships
-- Before: "Managers can modify player memberships" (ALL, can_manage_player_memberships)
--       + "Members can read player memberships" (SELECT, is_player_member)
-- After:  Single SELECT is_player_member + INSERT/UPDATE/DELETE for can_manage
-- ============================================================================
DROP POLICY IF EXISTS "Managers can modify player memberships" ON public.player_memberships;
-- "Members can read player memberships" (SELECT, is_player_member) remains

CREATE POLICY "Managers can insert player memberships"
  ON public.player_memberships FOR INSERT
  WITH CHECK (public.can_manage_player_memberships(player_id));

CREATE POLICY "Managers can update player memberships"
  ON public.player_memberships FOR UPDATE
  USING (public.can_manage_player_memberships(player_id))
  WITH CHECK (public.can_manage_player_memberships(player_id));

CREATE POLICY "Managers can delete player memberships"
  ON public.player_memberships FOR DELETE
  USING (public.can_manage_player_memberships(player_id));

COMMIT;
