-- Migration: Fix RLS policies to allow service_role for Edge Functions
-- Date: 2026-04-18
-- Issue: Heartbeat queries failing with 406 because service_role is blocked by RLS
-- Fix: Update all admin policies to allow both 'authenticated' and 'service_role'

-- Update players table policy
DROP POLICY IF EXISTS "Admin full access to players" ON public.players;
CREATE POLICY "Admin full access to players"
  ON public.players FOR ALL
  USING (auth.role() IN ('authenticated', 'service_role'));

-- Update playlists table policy
DROP POLICY IF EXISTS "Admin full access to playlists" ON public.playlists;
CREATE POLICY "Admin full access to playlists"
  ON public.playlists FOR ALL
  USING (auth.role() IN ('authenticated', 'service_role'));

-- Update playlist_items table policy
DROP POLICY IF EXISTS "Admin full access to playlist_items" ON public.playlist_items;
CREATE POLICY "Admin full access to playlist_items"
  ON public.playlist_items FOR ALL
  USING (auth.role() IN ('authenticated', 'service_role'));

-- Update media_items table policy
DROP POLICY IF EXISTS "Admin full access to media_items" ON public.media_items;
CREATE POLICY "Admin full access to media_items"
  ON public.media_items FOR ALL
  USING (auth.role() IN ('authenticated', 'service_role'));

-- Update queue table policy
DROP POLICY IF EXISTS "Admin full access to queue" ON public.queue;
CREATE POLICY "Admin full access to queue"
  ON public.queue FOR ALL
  USING (auth.role() IN ('authenticated', 'service_role'));

-- Update player_status table policy
DROP POLICY IF EXISTS "Admin full access to player_status" ON public.player_status;
CREATE POLICY "Admin full access to player_status"
  ON public.player_status FOR ALL
  USING (auth.role() IN ('authenticated', 'service_role'));

-- Update player_settings table policy
DROP POLICY IF EXISTS "Admin full access to player_settings" ON public.player_settings;
CREATE POLICY "Admin full access to player_settings"
  ON public.player_settings FOR ALL
  USING (auth.role() IN ('authenticated', 'service_role'));

-- Update system_logs table policy  
DROP POLICY IF EXISTS "Admin full access to system_logs" ON public.system_logs;
CREATE POLICY "Admin full access to system_logs"
  ON public.system_logs FOR SELECT
  USING (auth.role() IN ('authenticated', 'service_role'));
