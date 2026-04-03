-- Consolidate duplicate permissive RLS policies that cause unnecessary per-query overhead.
-- When multiple permissive policies exist for the same role+action, Postgres must evaluate
-- ALL of them and OR the results, adding overhead to every query.

-- player_settings: "Kiosk can read player settings" is identical to "Anon can read player settings"
-- Both are SELECT with USING (true). Drop the duplicate.
DROP POLICY IF EXISTS "Kiosk can read player settings" ON public.player_settings;

-- player_status: "Player can read own status" is identical to "Anon can read player status"
-- Both are SELECT with USING (true). Drop the duplicate.
DROP POLICY IF EXISTS "Player can read own status" ON public.player_status;
