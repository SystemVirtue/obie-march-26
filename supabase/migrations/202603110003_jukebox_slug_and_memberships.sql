-- 202603110003_jukebox_slug_and_memberships.sql
--
-- Adds canonical jukebox slug identity and multi-user player memberships.
-- Keeps players.id as the internal UUID key used by existing queue/player logic.

-- -----------------------------------------------------------------------------
-- 1) Slug and display columns on players
-- -----------------------------------------------------------------------------
ALTER TABLE players
  ADD COLUMN IF NOT EXISTS jukebox_slug TEXT,
  ADD COLUMN IF NOT EXISTS display_name TEXT;

-- Helper used by both migration backfills and runtime RPCs.
CREATE OR REPLACE FUNCTION public.normalize_jukebox_slug(p_raw TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_slug TEXT;
BEGIN
  v_slug := UPPER(COALESCE(TRIM(p_raw), ''));
  v_slug := REGEXP_REPLACE(v_slug, '\\s+', '_', 'g');
  v_slug := REGEXP_REPLACE(v_slug, '[^A-Z0-9_-]', '', 'g');
  v_slug := REGEXP_REPLACE(v_slug, '_{2,}', '_', 'g');
  v_slug := REGEXP_REPLACE(v_slug, '-{2,}', '-', 'g');
  v_slug := BTRIM(v_slug, '_-');
  RETURN v_slug;
END;
$$;

UPDATE players
SET display_name = name
WHERE display_name IS NULL;

-- Backfill slug values with deterministic uniqueness.
DO $$
DECLARE
  v_row RECORD;
  v_base TEXT;
  v_slug TEXT;
  v_n INT;
BEGIN
  FOR v_row IN
    SELECT id, jukebox_slug, COALESCE(display_name, name, 'JUKEBOX') AS src
    FROM players
  LOOP
    v_base := public.normalize_jukebox_slug(COALESCE(v_row.jukebox_slug, v_row.src));
    IF v_base = '' THEN
      v_base := 'JUKEBOX';
    END IF;

    v_slug := v_base;
    v_n := 1;

    WHILE EXISTS (
      SELECT 1
      FROM players p
      WHERE p.jukebox_slug = v_slug
        AND p.id <> v_row.id
    ) LOOP
      v_slug := v_base || '_' || v_n::TEXT;
      v_n := v_n + 1;
    END LOOP;

    UPDATE players
    SET jukebox_slug = v_slug
    WHERE id = v_row.id;
  END LOOP;
END;
$$;

ALTER TABLE players
  ALTER COLUMN jukebox_slug SET DEFAULT ('JUKEBOX_' || SUBSTR(REPLACE(gen_random_uuid()::TEXT, '-', ''), 1, 12)),
  ALTER COLUMN jukebox_slug SET NOT NULL,
  ALTER COLUMN display_name SET DEFAULT '';

ALTER TABLE players DROP CONSTRAINT IF EXISTS players_jukebox_slug_format_chk;
ALTER TABLE players ADD CONSTRAINT players_jukebox_slug_format_chk
  CHECK (jukebox_slug ~ '^[A-Z0-9_-]+$');

CREATE UNIQUE INDEX IF NOT EXISTS players_jukebox_slug_key ON players(jukebox_slug);

-- -----------------------------------------------------------------------------
-- 2) Membership model (many users per player)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS player_memberships (
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('owner', 'admin', 'operator', 'viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (player_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_player_memberships_user_id ON player_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_player_memberships_player_id ON player_memberships(player_id);

DROP TRIGGER IF EXISTS player_memberships_updated_at ON player_memberships;
CREATE TRIGGER player_memberships_updated_at
  BEFORE UPDATE ON player_memberships
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- Seed owner rows from existing owner_id data.
INSERT INTO player_memberships (player_id, user_id, role)
SELECT id, owner_id, 'owner'
FROM players
WHERE owner_id IS NOT NULL
ON CONFLICT (player_id, user_id)
DO UPDATE SET role = 'owner', updated_at = NOW();

CREATE OR REPLACE FUNCTION public.sync_player_owner_membership()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.owner_id IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.player_memberships (player_id, user_id, role)
  VALUES (NEW.id, NEW.owner_id, 'owner')
  ON CONFLICT (player_id, user_id)
  DO UPDATE SET role = 'owner', updated_at = NOW();

  IF TG_OP = 'UPDATE'
     AND OLD.owner_id IS DISTINCT FROM NEW.owner_id
     AND OLD.owner_id IS NOT NULL THEN
    DELETE FROM public.player_memberships
    WHERE player_id = NEW.id
      AND user_id = OLD.owner_id
      AND role = 'owner';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_player_owner_membership_trigger ON players;
CREATE TRIGGER sync_player_owner_membership_trigger
  AFTER INSERT OR UPDATE OF owner_id ON players
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_player_owner_membership();

-- -----------------------------------------------------------------------------
-- 3) Membership helper functions
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_player_member(
  p_player_id UUID,
  p_user_id UUID DEFAULT auth.uid()
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.players p
    LEFT JOIN public.player_memberships pm
      ON pm.player_id = p.id
     AND pm.user_id = p_user_id
    WHERE p.id = p_player_id
      AND (p.owner_id = p_user_id OR pm.user_id IS NOT NULL)
  );
$$;

CREATE OR REPLACE FUNCTION public.can_manage_player_memberships(
  p_player_id UUID,
  p_user_id UUID DEFAULT auth.uid()
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.players p
    LEFT JOIN public.player_memberships pm
      ON pm.player_id = p.id
     AND pm.user_id = p_user_id
    WHERE p.id = p_player_id
      AND (
        p.owner_id = p_user_id
        OR pm.role IN ('owner', 'admin')
      )
  );
$$;

-- -----------------------------------------------------------------------------
-- 4) RLS updates for membership-aware access
-- -----------------------------------------------------------------------------
ALTER TABLE player_memberships ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can read player memberships" ON player_memberships;
CREATE POLICY "Members can read player memberships"
  ON player_memberships FOR SELECT
  USING (public.is_player_member(player_id));

DROP POLICY IF EXISTS "Managers can modify player memberships" ON player_memberships;
CREATE POLICY "Managers can modify player memberships"
  ON player_memberships FOR ALL
  USING (public.can_manage_player_memberships(player_id))
  WITH CHECK (public.can_manage_player_memberships(player_id));

DROP POLICY IF EXISTS "Owner access to own player" ON players;
CREATE POLICY "Member access to own players"
  ON players FOR ALL
  USING (
    owner_id = auth.uid()
    OR EXISTS (
      SELECT 1
      FROM player_memberships pm
      WHERE pm.player_id = players.id
        AND pm.user_id = auth.uid()
    )
  )
  WITH CHECK (
    owner_id = auth.uid()
    OR EXISTS (
      SELECT 1
      FROM player_memberships pm
      WHERE pm.player_id = players.id
        AND pm.user_id = auth.uid()
        AND pm.role IN ('owner', 'admin', 'operator')
    )
  );

DROP POLICY IF EXISTS "Owner access to own playlists" ON playlists;
CREATE POLICY "Member access to own playlists"
  ON playlists FOR ALL
  USING (public.is_player_member(player_id))
  WITH CHECK (public.is_player_member(player_id));

DROP POLICY IF EXISTS "Owner access to own playlist items" ON playlist_items;
CREATE POLICY "Member access to own playlist items"
  ON playlist_items FOR ALL
  USING (
    EXISTS (
      SELECT 1
      FROM playlists pl
      WHERE pl.id = playlist_items.playlist_id
        AND public.is_player_member(pl.player_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM playlists pl
      WHERE pl.id = playlist_items.playlist_id
        AND public.is_player_member(pl.player_id)
    )
  );

DROP POLICY IF EXISTS "Owner access to own queue" ON queue;
CREATE POLICY "Member access to own queue"
  ON queue FOR ALL
  USING (public.is_player_member(player_id))
  WITH CHECK (public.is_player_member(player_id));

DROP POLICY IF EXISTS "Owner full access to own player_status" ON player_status;
CREATE POLICY "Member full access to own player_status"
  ON player_status FOR ALL
  USING (public.is_player_member(player_id))
  WITH CHECK (public.is_player_member(player_id));

DROP POLICY IF EXISTS "Owner full access to own player_settings" ON player_settings;
CREATE POLICY "Member full access to own player_settings"
  ON player_settings FOR ALL
  USING (public.is_player_member(player_id))
  WITH CHECK (public.is_player_member(player_id));

DROP POLICY IF EXISTS "Owner can read own system_logs" ON system_logs;
CREATE POLICY "Member can read own system_logs"
  ON system_logs FOR SELECT
  USING (
    player_id IS NULL
    OR public.is_player_member(player_id)
  );

-- -----------------------------------------------------------------------------
-- 5) RPCs for landing/picker flow
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_my_jukeboxes()
RETURNS TABLE(
  player_id UUID,
  jukebox_slug TEXT,
  display_name TEXT,
  role TEXT,
  is_owner BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH candidates AS (
    SELECT
      p.id AS player_id,
      p.jukebox_slug,
      COALESCE(NULLIF(p.display_name, ''), p.name, p.jukebox_slug) AS display_name,
      'owner'::TEXT AS role,
      TRUE AS is_owner,
      0 AS role_rank
    FROM public.players p
    WHERE p.owner_id = auth.uid()

    UNION ALL

    SELECT
      p.id AS player_id,
      p.jukebox_slug,
      COALESCE(NULLIF(p.display_name, ''), p.name, p.jukebox_slug) AS display_name,
      pm.role,
      (p.owner_id = auth.uid()) AS is_owner,
      CASE pm.role
        WHEN 'owner' THEN 0
        WHEN 'admin' THEN 1
        WHEN 'operator' THEN 2
        ELSE 3
      END AS role_rank
    FROM public.player_memberships pm
    JOIN public.players p ON p.id = pm.player_id
    WHERE pm.user_id = auth.uid()
  )
  SELECT DISTINCT ON (c.player_id)
    c.player_id,
    c.jukebox_slug,
    c.display_name,
    c.role,
    c.is_owner
  FROM candidates c
  ORDER BY c.player_id, c.role_rank;
$$;

CREATE OR REPLACE FUNCTION public.resolve_jukebox_slug(p_slug TEXT)
RETURNS TABLE(
  player_id UUID,
  jukebox_slug TEXT,
  display_name TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    p.id AS player_id,
    p.jukebox_slug,
    COALESCE(NULLIF(p.display_name, ''), p.name, p.jukebox_slug) AS display_name
  FROM public.players p
  WHERE p.jukebox_slug = public.normalize_jukebox_slug(p_slug)
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.create_jukebox(
  p_slug TEXT,
  p_display_name TEXT DEFAULT NULL
)
RETURNS TABLE(
  player_id UUID,
  jukebox_slug TEXT,
  display_name TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_slug TEXT;
  v_display TEXT;
  v_player_id UUID;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  v_slug := public.normalize_jukebox_slug(p_slug);
  IF v_slug = '' THEN
    RAISE EXCEPTION 'Jukebox name is required';
  END IF;

  IF v_slug !~ '^[A-Z0-9_-]+$' THEN
    RAISE EXCEPTION 'Jukebox name must be A-Z, 0-9, underscore, or dash';
  END IF;

  v_display := COALESCE(NULLIF(TRIM(p_display_name), ''), v_slug);

  INSERT INTO public.players (name, display_name, jukebox_slug, status, owner_id)
  VALUES (v_display, v_display, v_slug, 'offline', v_user_id)
  RETURNING id INTO v_player_id;

  INSERT INTO public.player_status (player_id, state)
  VALUES (v_player_id, 'idle')
  ON CONFLICT (player_id) DO NOTHING;

  INSERT INTO public.player_settings (player_id, branding)
  VALUES (
    v_player_id,
    jsonb_build_object('name', v_display, 'logo', '', 'theme', 'dark')
  )
  ON CONFLICT (player_id) DO NOTHING;

  INSERT INTO public.player_memberships (player_id, user_id, role)
  VALUES (v_player_id, v_user_id, 'owner')
  ON CONFLICT (player_id, user_id)
  DO UPDATE SET role = 'owner', updated_at = NOW();

  PERFORM public.log_event(
    v_player_id,
    'player_created',
    'info',
    jsonb_build_object('owner', v_user_id, 'slug', v_slug)
  );

  RETURN QUERY
  SELECT v_player_id, v_slug, v_display;
END;
$$;

-- -----------------------------------------------------------------------------
-- 6) Compatibility updates to existing auth provisioning/RPCs
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_player_for_user(p_user_id UUID, p_email TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_player_id UUID;
  v_name TEXT;
  v_base_slug TEXT;
  v_slug TEXT;
  v_n INT := 1;
BEGIN
  v_name := split_part(p_email, '@', 1) || '''s Jukebox';
  v_base_slug := public.normalize_jukebox_slug(split_part(p_email, '@', 1));
  IF v_base_slug = '' THEN
    v_base_slug := 'JUKEBOX';
  END IF;

  v_slug := v_base_slug;
  WHILE EXISTS (SELECT 1 FROM public.players WHERE jukebox_slug = v_slug) LOOP
    v_slug := v_base_slug || '_' || v_n::TEXT;
    v_n := v_n + 1;
  END LOOP;

  INSERT INTO public.players (name, display_name, jukebox_slug, status, owner_id)
  VALUES (v_name, v_name, v_slug, 'offline', p_user_id)
  RETURNING id INTO v_player_id;

  INSERT INTO public.player_status (player_id, state)
  VALUES (v_player_id, 'idle');

  INSERT INTO public.player_settings (player_id, branding)
  VALUES (v_player_id, jsonb_build_object('name', v_name, 'logo', '', 'theme', 'dark'));

  INSERT INTO public.player_memberships (player_id, user_id, role)
  VALUES (v_player_id, p_user_id, 'owner')
  ON CONFLICT (player_id, user_id)
  DO UPDATE SET role = 'owner', updated_at = NOW();

  BEGIN
    PERFORM public.log_event(
      v_player_id,
      'player_created',
      'info',
      jsonb_build_object('owner', p_user_id, 'email', p_email, 'slug', v_slug)
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'log_event failed during user provisioning for %: %', p_user_id, SQLERRM;
  END;

  RETURN v_player_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_my_player_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_player_id UUID;
BEGIN
  SELECT src.player_id
  INTO v_player_id
  FROM (
    SELECT p.id AS player_id, 0 AS rank
    FROM public.players p
    WHERE p.owner_id = auth.uid()

    UNION ALL

    SELECT pm.player_id,
      CASE pm.role
        WHEN 'owner' THEN 0
        WHEN 'admin' THEN 1
        WHEN 'operator' THEN 2
        ELSE 3
      END AS rank
    FROM public.player_memberships pm
    WHERE pm.user_id = auth.uid()
  ) src
  ORDER BY src.rank, src.player_id
  LIMIT 1;

  RETURN v_player_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.is_player_member(UUID, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_manage_player_memberships(UUID, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_jukeboxes() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_jukebox_slug(TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_jukebox(TEXT, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_player_id() TO authenticated, service_role;
