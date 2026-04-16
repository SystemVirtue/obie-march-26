-- Migration: Split Kiosk Requests playlist into three volumes
-- and set up automation for volume rotation when >400 songs

-- NB: This migration is idempotent. It can be safely run multiple times.
-- It will not create duplicate playlists if they already exist.

-- ════════════════════════════════════════════════════════════════════════════
-- 1. CREATE NEW PLAYLIST VOLUMES
-- ════════════════════════════════════════════════════════════════════════════

-- Create Kiosk_Requests_Vol_1 (items 0 to n/3)
-- Create Kiosk_Requests_Vol_2 (items n/3+1 to 2n/3)
-- Create Kiosk_Requests_Vol_3 (items 2n/3+1 to end)

DO $$
DECLARE
  v_player_id UUID;
  v_kiosk_requests_playlist_id UUID;
  v_vol1_id UUID;
  v_vol2_id UUID;
  v_vol3_id UUID;
  v_total_items INT;
  v_third INT;
  v_two_thirds INT;
  v_existing_vol_id UUID;
BEGIN
  -- Iterate through all players that have a Kiosk Requests playlist
  FOR v_player_id IN
    SELECT DISTINCT player_id
    FROM playlists
    WHERE LOWER(name) = LOWER('Kiosk Requests')
  LOOP
    -- Get the Kiosk Requests playlist
    SELECT id INTO v_kiosk_requests_playlist_id
    FROM playlists
    WHERE player_id = v_player_id
      AND LOWER(name) = LOWER('Kiosk Requests')
    LIMIT 1;

    IF v_kiosk_requests_playlist_id IS NULL THEN
      CONTINUE;
    END IF;

    -- Count items in Kiosk Requests
    SELECT COUNT(*) INTO v_total_items
    FROM playlist_items
    WHERE playlist_id = v_kiosk_requests_playlist_id;

    IF v_total_items = 0 THEN
      CONTINUE;
    END IF;

    -- Calculate split points
    v_third := v_total_items / 3;
    v_two_thirds := v_total_items * 2 / 3;

    -- ──────────────────────────────────────────────────────────────────────
    -- Vol 1: Create if not exists
    -- ──────────────────────────────────────────────────────────────────────
    SELECT id INTO v_existing_vol_id
    FROM playlists
    WHERE player_id = v_player_id
      AND name = 'Kiosk_Requests_Vol_1'
    LIMIT 1;

    IF v_existing_vol_id IS NULL THEN
      INSERT INTO playlists (player_id, name, description, is_active)
      VALUES (
        v_player_id,
        'Kiosk_Requests_Vol_1',
        'Kiosk requests volume 1 (archive)',
        FALSE
      )
      RETURNING id INTO v_vol1_id;
    ELSE
      v_vol1_id := v_existing_vol_id;
    END IF;

    -- Migrate first third of items to Vol 1
    -- Delete any existing items first to avoid duplicates
    DELETE FROM playlist_items
    WHERE playlist_id = v_vol1_id;

    INSERT INTO playlist_items (playlist_id, position, media_item_id)
    SELECT
      v_vol1_id,
      ROW_NUMBER() OVER (ORDER BY position) - 1,
      media_item_id
    FROM playlist_items
    WHERE playlist_id = v_kiosk_requests_playlist_id
      AND position < v_third;

    -- ──────────────────────────────────────────────────────────────────────
    -- Vol 2: Create if not exists
    -- ──────────────────────────────────────────────────────────────────────
    SELECT id INTO v_existing_vol_id
    FROM playlists
    WHERE player_id = v_player_id
      AND name = 'Kiosk_Requests_Vol_2'
    LIMIT 1;

    IF v_existing_vol_id IS NULL THEN
      INSERT INTO playlists (player_id, name, description, is_active)
      VALUES (
        v_player_id,
        'Kiosk_Requests_Vol_2',
        'Kiosk requests volume 2 (archive)',
        FALSE
      )
      RETURNING id INTO v_vol2_id;
    ELSE
      v_vol2_id := v_existing_vol_id;
    END IF;

    -- Migrate second third of items to Vol 2
    DELETE FROM playlist_items
    WHERE playlist_id = v_vol2_id;

    INSERT INTO playlist_items (playlist_id, position, media_item_id)
    SELECT
      v_vol2_id,
      ROW_NUMBER() OVER (ORDER BY position) - 1,
      media_item_id
    FROM playlist_items
    WHERE playlist_id = v_kiosk_requests_playlist_id
      AND position >= v_third
      AND position < v_two_thirds;

    -- ──────────────────────────────────────────────────────────────────────
    -- Vol 3: Create if not exists
    -- ──────────────────────────────────────────────────────────────────────
    SELECT id INTO v_existing_vol_id
    FROM playlists
    WHERE player_id = v_player_id
      AND name = 'Kiosk_Requests_Vol_3'
    LIMIT 1;

    IF v_existing_vol_id IS NULL THEN
      INSERT INTO playlists (player_id, name, description, is_active)
      VALUES (
        v_player_id,
        'Kiosk_Requests_Vol_3',
        'Kiosk requests volume 3 (archive)',
        FALSE
      )
      RETURNING id INTO v_vol3_id;
    ELSE
      v_vol3_id := v_existing_vol_id;
    END IF;

    -- Migrate remaining items to Vol 3
    DELETE FROM playlist_items
    WHERE playlist_id = v_vol3_id;

    INSERT INTO playlist_items (playlist_id, position, media_item_id)
    SELECT
      v_vol3_id,
      ROW_NUMBER() OVER (ORDER BY position) - 1,
      media_item_id
    FROM playlist_items
    WHERE playlist_id = v_kiosk_requests_playlist_id
      AND position >= v_two_thirds;

  END LOOP;

END;
$$;


-- ════════════════════════════════════════════════════════════════════════════
-- 2. CREATE HELPER FUNCTION FOR AUDIO AUTOMATION
-- ════════════════════════════════════════════════════════════════════════════

-- Periodic check: If Kiosk_Requests exceeds 400 items, create a new volume
-- and move all items to it, clearing the main playlist.

CREATE OR REPLACE FUNCTION public.rotate_kiosk_requests_if_needed(p_player_id UUID)
RETURNS TABLE (
  playlist_id UUID,
  action TEXT,
  new_volume_number INT,
  items_archived INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_kiosk_requests_id UUID;
  v_item_count INT;
  v_new_volume_num INT;
  v_new_volume_name TEXT;
  v_new_volume_id UUID;
  v_item_count_archived INT;
BEGIN
  -- Get the Kiosk Requests playlist for this player
  SELECT id INTO v_kiosk_requests_id
  FROM playlists
  WHERE player_id = p_player_id
    AND LOWER(name) = LOWER('Kiosk Requests')
  LIMIT 1;

  IF v_kiosk_requests_id IS NULL THEN
    playlist_id := NULL;
    action := 'No Kiosk Requests playlist found';
    new_volume_number := NULL;
    items_archived := 0;
    RETURN NEXT;
    RETURN;
  END IF;

  -- Count items in Kiosk Requests
  SELECT COUNT(*) INTO v_item_count
  FROM playlist_items
  WHERE playlist_id = v_kiosk_requests_id;

  -- If under 400 items, no action needed
  IF v_item_count <= 400 THEN
    playlist_id := v_kiosk_requests_id;
    action := 'Under limit, no rotation needed';
    new_volume_number := NULL;
    items_archived := 0;
    RETURN NEXT;
    RETURN;
  END IF;

  -- Find the next volume number
  SELECT COALESCE(MAX(CAST(SUBSTRING(name FROM 'Vol_(\d+)$') AS INT)), 0) + 1
  INTO v_new_volume_num
  FROM playlists
  WHERE player_id = p_player_id
    AND name LIKE 'Kiosk_Requests_Vol_%';

  v_new_volume_name := 'Kiosk_Requests_Vol_' || v_new_volume_num;

  -- Create the new volume playlist
  INSERT INTO playlists (player_id, name, description, is_active)
  VALUES (
    p_player_id,
    v_new_volume_name,
    'Kiosk requests volume ' || v_new_volume_num || ' (archived)',
    FALSE
  )
  RETURNING id INTO v_new_volume_id;

  -- Count items before archiving
  v_item_count_archived := v_item_count;

  -- Move all items from Kiosk Requests to the new volume
  INSERT INTO playlist_items (playlist_id, position, media_item_id)
  SELECT
    v_new_volume_id,
    ROW_NUMBER() OVER (ORDER BY position),
    media_item_id
  FROM playlist_items
  WHERE playlist_id = v_kiosk_requests_id;

  -- Clear the original Kiosk Requests playlist
  DELETE FROM playlist_items
  WHERE playlist_id = v_kiosk_requests_id;

  playlist_id := v_new_volume_id;
  action := 'Rotated to new volume, Kiosk_Requests cleared';
  new_volume_number := v_new_volume_num;
  items_archived := v_item_count_archived;
  RETURN NEXT;

END;
$$;

GRANT EXECUTE ON FUNCTION public.rotate_kiosk_requests_if_needed(UUID) TO authenticated, service_role;
