-- Fix: playlists_with_counts view has SECURITY DEFINER behaviour
--
-- By default PostgreSQL views execute as the view creator (superuser/postgres),
-- which allows any caller to read all rows regardless of RLS policies.
-- Adding WITH (security_invoker = true) makes the view execute as the querying
-- user, so the membership-based RLS policy on playlists is properly enforced.
--
-- The column shape is unchanged so no TypeScript consumer changes are needed.

DROP VIEW IF EXISTS public.playlists_with_counts;

CREATE VIEW public.playlists_with_counts
WITH (security_invoker = true)
AS
SELECT
  p.*,
  COALESCE(count(pi.id), 0) AS item_count
FROM public.playlists p
LEFT JOIN public.playlist_items pi ON pi.playlist_id = p.id
GROUP BY p.id;
