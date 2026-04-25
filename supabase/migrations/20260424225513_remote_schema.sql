create extension if not exists "hypopg" with schema "extensions";
create extension if not exists "index_advisor" with schema "extensions";
drop extension if exists "pg_net";
drop trigger if exists "queue_resequence_after_delete" on "public"."queue";
drop function if exists "public"."delete_inactive_players"(p_offline_threshold_seconds integer);
drop function if exists "public"."delete_player_instance"(p_player_id uuid);
drop function if exists "public"."identify_player"(p_player_id uuid, p_display_name text);
drop function if exists "public"."queue_resequence_positions"();
drop function if exists "public"."reorder_players"(p_player_ids uuid [], p_priorities integer []);
alter table "public"."player_settings"
alter column "max_queue_size"
set default 1000;
alter table "public"."players"
add column "identify_tag" text;
alter table "public"."players"
add column "last_refresh" timestamp with time zone;
alter table "public"."queue"
alter column "expires_at" drop default;
CREATE INDEX idx_queue_player_id ON public.queue USING btree (player_id);
CREATE INDEX idx_system_logs_timestamp ON public.system_logs USING btree ("timestamp" DESC);
CREATE INDEX kiosk_sessions_last_active_idx ON public.kiosk_sessions USING btree (last_active);
CREATE INDEX playlist_items_media_item_id_idx ON public.playlist_items USING btree (media_item_id);
set check_function_bodies = off;
CREATE OR REPLACE FUNCTION public.create_player(p_name text, p_jukebox_slug text) RETURNS json LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public' AS $function$
DECLARE v_new_player RECORD;
BEGIN -- Create new player
INSERT INTO players (name, status, jukebox_slug, last_refresh)
VALUES (p_name, 'online', p_jukebox_slug, NOW())
RETURNING * INTO v_new_player;
RETURN json_build_object(
  'id',
  v_new_player.id,
  'name',
  v_new_player.name,
  'jukebox_slug',
  v_new_player.jukebox_slug,
  'status',
  v_new_player.status
);
END;
$function$;
CREATE OR REPLACE FUNCTION public.mark_stale_players_offline() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER AS $function$
DECLARE affected integer;
BEGIN
UPDATE players
SET status = 'offline',
  updated_at = NOW()
WHERE status = 'online'
  AND last_heartbeat < NOW() - INTERVAL '30 seconds';
GET DIAGNOSTICS affected = ROW_COUNT;
RETURN affected;
END;
$function$;
CREATE OR REPLACE FUNCTION public.set_priority_player_global(p_priority_player_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $function$ BEGIN
UPDATE public.players
SET priority_player_id = p_priority_player_id
WHERE true;
-- Updates all rows
END;
$function$;
CREATE OR REPLACE FUNCTION public.initialize_player_playlist(p_player_id uuid) RETURNS TABLE(
    success boolean,
    playlist_id uuid,
    playlist_name text,
    loaded_count integer
  ) LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public' AS $function$
DECLARE v_unplayed_count INT;
v_playlist_id UUID;
v_playlist_name TEXT;
v_loaded_count INT := 0;
v_slug TEXT;
BEGIN -- Ensure the player row exists (and use a jukebox_slug that satisfies
-- players_jukebox_slug_format_chk).
v_slug := 'JUKEBOX_' || upper(
  substr(replace(md5(p_player_id::text), '-', ''), 1, 12)
);
INSERT INTO public.players (id, name, jukebox_slug)
VALUES (p_player_id, 'Player', v_slug) ON CONFLICT (id) DO NOTHING;
SELECT COUNT(*) INTO v_unplayed_count
FROM public.queue
WHERE player_id = p_player_id
  AND type = 'normal'
  AND played_at IS NULL;
IF v_unplayed_count > 0 THEN RETURN QUERY
SELECT TRUE,
  NULL::UUID,
  NULL::TEXT,
  0;
RETURN;
END IF;
SELECT active_playlist_id INTO v_playlist_id
FROM public.players
WHERE id = p_player_id;
IF v_playlist_id IS NOT NULL THEN
SELECT name INTO v_playlist_name
FROM public.playlists
WHERE id = v_playlist_id;
IF NOT FOUND THEN v_playlist_id := NULL;
END IF;
END IF;
IF v_playlist_id IS NULL THEN
SELECT p.id,
  p.name INTO v_playlist_id,
  v_playlist_name
FROM public.playlists p
WHERE EXISTS (
    SELECT 1
    FROM public.playlist_items pi
    WHERE pi.playlist_id = p.id
  )
ORDER BY p.created_at DESC
LIMIT 1;
END IF;
IF v_playlist_id IS NULL THEN RETURN QUERY
SELECT FALSE,
  NULL::UUID,
  NULL::TEXT,
  0;
RETURN;
END IF;
SELECT lp.loaded_count INTO v_loaded_count
FROM public.load_playlist(p_player_id, v_playlist_id, 0, FALSE) lp;
RETURN QUERY
SELECT TRUE,
  v_playlist_id,
  v_playlist_name,
  v_loaded_count;
END;
$function$;
CREATE OR REPLACE FUNCTION public.kiosk_request_enqueue(p_session_id uuid, p_media_item_id uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $function$
DECLARE v_player_id UUID;
v_credits INT;
v_coin_per_song INT := 1;
v_freeplay BOOLEAN := false;
v_queue_id UUID;
BEGIN
SELECT player_id,
  credits INTO v_player_id,
  v_credits
FROM kiosk_sessions
WHERE session_id = p_session_id FOR
UPDATE;
IF NOT FOUND THEN RAISE EXCEPTION 'Session not found';
END IF;
SELECT freeplay,
  coin_per_song INTO v_freeplay,
  v_coin_per_song
FROM player_settings
WHERE player_id = v_player_id;
v_freeplay := COALESCE(v_freeplay, false);
v_coin_per_song := COALESCE(v_coin_per_song, 1);
IF NOT v_freeplay THEN IF v_credits < v_coin_per_song THEN RAISE EXCEPTION 'Insufficient credits';
END IF;
UPDATE kiosk_sessions
SET credits = credits - v_coin_per_song
WHERE session_id = p_session_id;
END IF;
v_queue_id := queue_add(
  v_player_id,
  p_media_item_id,
  'priority',
  p_session_id::text
);
PERFORM log_event(
  v_player_id,
  'kiosk_request_enqueue',
  'info',
  jsonb_build_object(
    'session_id',
    p_session_id,
    'media_item_id',
    p_media_item_id,
    'queue_id',
    v_queue_id
  )
);
RETURN v_queue_id;
END;
$function$;
CREATE OR REPLACE FUNCTION public.load_playlist(
    p_player_id uuid,
    p_playlist_id uuid,
    p_start_index integer DEFAULT 0,
    p_skip_shuffle boolean DEFAULT false
  ) RETURNS TABLE(loaded_count integer) LANGUAGE plpgsql SECURITY DEFINER AS $function$
DECLARE v_loaded_count INT := 0;
v_shuffle BOOLEAN;
v_currently_playing_id UUID;
-- non-NULL means a video is actively playing
v_currently_playing_position INT;
-- position of the currently playing item in the queue
v_insert_start_pos INT;
BEGIN PERFORM pg_advisory_xact_lock(hashtext('queue_' || p_player_id::text));
SELECT shuffle INTO v_shuffle
FROM player_settings
WHERE player_id = p_player_id;
-- Check player_status for an actively playing video.
-- The playing video's queue row is DELETED by queue_next, so the queue
-- itself may be empty even while a video is mid-playback. We must check
-- player_status directly.
SELECT ps.current_media_id INTO v_currently_playing_id
FROM player_status ps
WHERE ps.player_id = p_player_id
  AND ps.current_media_id IS NOT NULL
  AND ps.state NOT IN ('idle', 'error');
-- Find the position of the currently playing item in the queue (if it exists)
SELECT q.position INTO v_currently_playing_position
FROM queue q
WHERE q.player_id = p_player_id
  AND q.type = 'normal'
  AND q.media_item_id = v_currently_playing_id
LIMIT 1;
-- Delete everything except the currently playing item (if it exists)
DELETE FROM queue
WHERE player_id = p_player_id
  AND type = 'normal'
  AND (
    v_currently_playing_id IS NULL
    OR id NOT IN (
      SELECT id
      FROM queue
      WHERE player_id = p_player_id
        AND type = 'normal'
        AND media_item_id = v_currently_playing_id
      LIMIT 1
    )
  );
-- Insertion start position logic:
--   • Something is playing and in queue → start after its position
--   • Something playing but not in queue → start at 0 (it was deleted by queue_next)
--   • Truly idle (nothing playing) → start at 0 (play immediately)
IF v_currently_playing_id IS NOT NULL
AND v_currently_playing_position IS NOT NULL THEN v_insert_start_pos := v_currently_playing_position + 1;
ELSIF v_currently_playing_id IS NOT NULL THEN v_insert_start_pos := 0;
ELSE v_insert_start_pos := 0;
END IF;
INSERT INTO queue (
    player_id,
    type,
    media_item_id,
    position,
    requested_by
  )
SELECT p_player_id,
  'normal',
  pi.media_item_id,
  v_insert_start_pos + (
    ROW_NUMBER() OVER (
      ORDER BY pi.position
    ) - 1
  ),
  'playlist'
FROM playlist_items pi
WHERE pi.playlist_id = p_playlist_id
ORDER BY pi.position;
GET DIAGNOSTICS v_loaded_count = ROW_COUNT;
UPDATE players
SET active_playlist_id = p_playlist_id,
  updated_at = NOW()
WHERE id = p_player_id;
-- Only update player_status when nothing is playing AND queue was empty.
-- If anything is in-flight, leave player_status untouched — the current
-- video will finish naturally and the new playlist will follow.
IF v_currently_playing_id IS NULL
AND v_position_0_id IS NULL THEN IF v_loaded_count > 0
OR EXISTS (
  SELECT 1
  FROM queue
  WHERE player_id = p_player_id
    AND type = 'priority'
) THEN
UPDATE player_status
SET current_media_id = (
    SELECT media_item_id
    FROM queue
    WHERE player_id = p_player_id
    ORDER BY CASE
        WHEN type = 'priority' THEN 0
        ELSE 1
      END,
      position ASC
    LIMIT 1
  ), state = 'loading', progress = 0, now_playing_index = p_start_index, last_updated = NOW()
WHERE player_id = p_player_id;
END IF;
END IF;
-- Shuffle only on explicit playlist loads, never on loop-refills.
IF v_shuffle
AND v_loaded_count > 1
AND NOT p_skip_shuffle THEN PERFORM queue_shuffle(p_player_id, 'normal');
END IF;
PERFORM log_event(
  p_player_id,
  'playlist_loaded',
  'info',
  jsonb_build_object(
    'playlist_id',
    p_playlist_id,
    'start_index',
    p_start_index,
    'loaded_count',
    v_loaded_count,
    'shuffled',
    v_shuffle
    AND v_loaded_count > 1
    AND NOT p_skip_shuffle,
    'currently_playing_id',
    v_currently_playing_id,
    'currently_playing_position',
    v_currently_playing_position,
    'insert_start_pos',
    v_insert_start_pos
  )
);
RETURN QUERY
SELECT v_loaded_count;
END;
$function$;
CREATE OR REPLACE FUNCTION public.queue_add(
    p_player_id uuid,
    p_media_item_id uuid,
    p_type text DEFAULT 'normal'::text,
    p_requested_by text DEFAULT NULL::text
  ) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public' AS $function$
DECLARE v_next_pos INT;
v_queue_id UUID;
BEGIN PERFORM pg_advisory_xact_lock(hashtext('queue_' || p_player_id::text));
SELECT COALESCE(MAX(position), -1) + 1 INTO v_next_pos
FROM queue
WHERE player_id = p_player_id
  AND type = p_type;
INSERT INTO queue (
    player_id,
    type,
    media_item_id,
    position,
    requested_by,
    expires_at
  )
VALUES (
    p_player_id,
    p_type,
    p_media_item_id,
    v_next_pos,
    p_requested_by,
    CASE
      WHEN p_type = 'priority' THEN NOW() + INTERVAL '30 minutes'
      ELSE NULL
    END
  )
RETURNING id INTO v_queue_id;
RETURN v_queue_id;
END;
$function$;
CREATE OR REPLACE FUNCTION public.queue_next(
    p_player_id uuid,
    p_expected_media_id uuid DEFAULT NULL::uuid
  ) RETURNS TABLE(
    media_item_id uuid,
    title text,
    url text,
    duration integer
  ) LANGUAGE plpgsql SECURITY DEFINER AS $function$
DECLARE v_next_queue_item RECORD;
v_media RECORD;
v_loop BOOLEAN;
v_active_playlist_id UUID;
v_loaded_count INT;
v_current_media_id UUID;
BEGIN PERFORM pg_advisory_xact_lock(hashtext('queue_' || p_player_id::text));
IF p_expected_media_id IS NOT NULL THEN
SELECT ps.current_media_id INTO v_current_media_id
FROM player_status ps
WHERE ps.player_id = p_player_id;
IF v_current_media_id IS DISTINCT
FROM p_expected_media_id THEN RETURN QUERY
SELECT NULL::UUID,
  NULL::TEXT,
  NULL::TEXT,
  NULL::INT
WHERE FALSE;
RETURN;
END IF;
END IF;
IF EXISTS (
  SELECT 1
  FROM queue
  WHERE player_id = p_player_id
    AND type = 'priority'
) THEN
SELECT q.id,
  q.media_item_id,
  q.type INTO v_next_queue_item
FROM queue q
WHERE q.player_id = p_player_id
  AND q.type = 'priority'
ORDER BY q.position ASC
LIMIT 1;
ELSE
SELECT q.id,
  q.media_item_id,
  q.type INTO v_next_queue_item
FROM queue q
WHERE q.player_id = p_player_id
  AND q.type = 'normal'
ORDER BY q.position ASC
LIMIT 1;
END IF;
IF v_next_queue_item IS NULL THEN
SELECT ps.loop INTO v_loop
FROM player_settings ps
WHERE ps.player_id = p_player_id;
IF v_loop THEN
SELECT active_playlist_id INTO v_active_playlist_id
FROM players
WHERE id = p_player_id;
IF v_active_playlist_id IS NOT NULL THEN
SELECT lp.loaded_count INTO v_loaded_count
FROM load_playlist(p_player_id, v_active_playlist_id, 0, TRUE) lp;
IF v_loaded_count > 0 THEN
SELECT q.id,
  q.media_item_id,
  q.type INTO v_next_queue_item
FROM queue q
WHERE q.player_id = p_player_id
  AND q.type = 'normal'
ORDER BY q.position ASC
LIMIT 1;
END IF;
END IF;
END IF;
IF v_next_queue_item IS NULL THEN RETURN QUERY
SELECT NULL::UUID,
  NULL::TEXT,
  NULL::TEXT,
  NULL::INT
WHERE FALSE;
RETURN;
END IF;
END IF;
DELETE FROM queue
WHERE id = v_next_queue_item.id;
SELECT m.id,
  m.source_type,
  m.url,
  m.title,
  m.duration INTO v_media
FROM media_items m
WHERE m.id = v_next_queue_item.media_item_id;
UPDATE player_status
SET current_media_id = v_next_queue_item.media_item_id,
  state = 'loading',
  progress = 0,
  now_playing_index = CASE
    WHEN v_next_queue_item.type = 'normal' THEN COALESCE(now_playing_index, 0) + 1
    ELSE now_playing_index
  END,
  source = CASE
    WHEN v_media.source_type = 'cloudflare' THEN 'cloudflare'
    ELSE 'youtube'
  END,
  local_url = CASE
    WHEN v_media.source_type = 'cloudflare' THEN v_media.url
    ELSE NULL
  END,
  last_updated = NOW()
WHERE player_id = p_player_id;
PERFORM log_event(
  p_player_id,
  'queue_next',
  'info',
  jsonb_build_object(
    'media_item_id',
    v_next_queue_item.media_item_id,
    'type',
    v_next_queue_item.type,
    'source_type',
    v_media.source_type
  )
);
RETURN QUERY
SELECT m.id,
  m.title,
  m.url,
  m.duration
FROM media_items m
WHERE m.id = v_next_queue_item.media_item_id;
END;
$function$;
CREATE OR REPLACE FUNCTION public.queue_reorder(
    p_player_id uuid,
    p_queue_ids uuid [],
    p_type text,
    p_start_position integer
  ) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public' AS $function$
DECLARE v_count int := coalesce(array_length(p_queue_ids, 1), 0);
v_affected int := 0;
v_ids uuid [];
v_pos int [];
BEGIN PERFORM pg_advisory_xact_lock(hashtext('queue_' || p_player_id::text));
-- Build the desired id→position mapping:
--   1. Items in p_queue_ids in the supplied order.
--   2. Any remaining unplayed items not in p_queue_ids, in their current order.
WITH provided AS (
  SELECT id,
    ord
  FROM unnest(p_queue_ids) WITH ORDINALITY AS t(id, ord)
  WHERE id IS NOT NULL
),
remaining AS (
  SELECT q.id
  FROM queue q
  WHERE q.player_id = p_player_id
    AND q.type = p_type
    AND q.played_at IS NULL
    AND (
      p_queue_ids IS NULL
      OR NOT (q.id = ANY(p_queue_ids))
    )
  ORDER BY q.position,
    q.requested_at NULLS LAST,
    q.id
),
combined AS (
  SELECT id,
    ord
  FROM provided
  UNION ALL
  SELECT id,
    (
      v_count + ROW_NUMBER() OVER (
        ORDER BY (
            SELECT 1
          )
      )
    )::bigint AS ord
  FROM remaining
),
numbered AS (
  SELECT id,
    (
      p_start_position + ROW_NUMBER() OVER (
        ORDER BY ord
      ) - 1
    )::int AS final_pos
  FROM combined
)
SELECT array_agg(
    id
    ORDER BY final_pos
  ),
  array_agg(
    final_pos
    ORDER BY final_pos
  ) INTO v_ids,
  v_pos
FROM numbered
WHERE EXISTS (
    SELECT 1
    FROM queue q
    WHERE q.id = numbered.id
      AND q.player_id = p_player_id
      AND q.type = p_type
      AND q.played_at IS NULL
  );
IF v_ids IS NULL
OR array_length(v_ids, 1) < 1 THEN RETURN;
END IF;
-- ── Phase 1: move all items to unique negative temp positions ──────────────
--   -ROW_NUMBER() OVER (ORDER BY id) gives -1, -2, -3 … — always distinct,
--   always negative, never conflict with existing positive positions.
UPDATE queue q
SET position = temp.neg_pos
FROM (
    SELECT id,
      (
        - ROW_NUMBER() OVER (
          ORDER BY id
        )
      )::int AS neg_pos
    FROM unnest(v_ids) AS t(id)
  ) temp
WHERE q.id = temp.id
  AND q.player_id = p_player_id
  AND q.type = p_type
  AND q.played_at IS NULL;
-- ── Phase 2: assign final desired positions ────────────────────────────────
--   All original slots are now free (cleared in Phase 1).
UPDATE queue q
SET position = t.final_pos
FROM unnest(v_ids, v_pos) AS t(item_id, final_pos)
WHERE q.id = t.item_id
  AND q.player_id = p_player_id
  AND q.type = p_type
  AND q.played_at IS NULL;
GET DIAGNOSTICS v_affected = ROW_COUNT;
PERFORM log_event(
  p_player_id,
  'queue_reorder',
  'info',
  jsonb_build_object(
    'count_provided',
    v_count,
    'affected_count',
    v_affected,
    'start_position',
    p_start_position,
    'type',
    p_type
  )
);
END;
$function$;
CREATE OR REPLACE FUNCTION public.sync_obie_v5_playlists_to_player(p_player_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public' AS $function$
DECLARE v_source_player_id UUID := '00000000-0000-0000-0000-000000000001';
v_shared_names TEXT [] := ARRAY [
    'DJAMMMS Default Playlist',
    'Karaoke',
    'Obie #1',
    'Obie #2',
    'Obie #3',
    'Obie #4',
    'Obie #5',
    'Obie Jo',
    'Obie Johno',
    'Obie Nights',
    'Obie Playlist',
    'Poly'
  ];
BEGIN IF p_player_id IS NULL THEN RETURN;
END IF;
-- Remove duplicate target playlists per shared name, keeping newest.
WITH ranked AS (
  SELECT id,
    ROW_NUMBER() OVER (
      PARTITION BY name
      ORDER BY created_at DESC,
        id DESC
    ) AS rn
  FROM public.playlists
  WHERE player_id = p_player_id
    AND name = ANY(v_shared_names)
)
DELETE FROM public.playlists p USING ranked r
WHERE p.id = r.id
  AND r.rn > 1;
-- Insert any missing shared playlists from canonical source, one per name.
WITH source_playlists AS (
  SELECT DISTINCT ON (p.name) p.id,
    p.name,
    p.description
  FROM public.playlists p
  WHERE p.player_id = v_source_player_id
    AND p.name = ANY(v_shared_names)
  ORDER BY p.name,
    p.created_at DESC,
    p.id DESC
)
INSERT INTO public.playlists (player_id, name, description, is_active)
SELECT p_player_id,
  sp.name,
  sp.description,
  FALSE
FROM source_playlists sp
WHERE NOT EXISTS (
    SELECT 1
    FROM public.playlists tp
    WHERE tp.player_id = p_player_id
      AND tp.name = sp.name
  );
-- Only names with non-empty source items are eligible for overwrite.
WITH source_playlists AS (
  SELECT DISTINCT ON (p.name) p.id,
    p.name
  FROM public.playlists p
  WHERE p.player_id = v_source_player_id
    AND p.name = ANY(v_shared_names)
  ORDER BY p.name,
    p.created_at DESC,
    p.id DESC
),
source_nonempty AS (
  SELECT sp.id,
    sp.name
  FROM source_playlists sp
  WHERE EXISTS (
      SELECT 1
      FROM public.playlist_items spi
      WHERE spi.playlist_id = sp.id
    )
),
target_playlists AS (
  SELECT DISTINCT ON (p.name) p.id,
    p.name
  FROM public.playlists p
  WHERE p.player_id = p_player_id
    AND p.name = ANY(v_shared_names)
  ORDER BY p.name,
    p.created_at DESC,
    p.id DESC
)
DELETE FROM public.playlist_items pi USING target_playlists tp
  JOIN source_nonempty sn ON sn.name = tp.name
WHERE pi.playlist_id = tp.id;
WITH source_playlists AS (
  SELECT DISTINCT ON (p.name) p.id,
    p.name
  FROM public.playlists p
  WHERE p.player_id = v_source_player_id
    AND p.name = ANY(v_shared_names)
  ORDER BY p.name,
    p.created_at DESC,
    p.id DESC
),
source_nonempty AS (
  SELECT sp.id,
    sp.name
  FROM source_playlists sp
  WHERE EXISTS (
      SELECT 1
      FROM public.playlist_items spi
      WHERE spi.playlist_id = sp.id
    )
),
target_playlists AS (
  SELECT DISTINCT ON (p.name) p.id,
    p.name
  FROM public.playlists p
  WHERE p.player_id = p_player_id
    AND p.name = ANY(v_shared_names)
  ORDER BY p.name,
    p.created_at DESC,
    p.id DESC
)
INSERT INTO public.playlist_items (playlist_id, media_item_id, position)
SELECT tp.id,
  spi.media_item_id,
  spi.position
FROM source_nonempty sn
  JOIN public.playlist_items spi ON spi.playlist_id = sn.id
  JOIN target_playlists tp ON tp.name = sn.name
ORDER BY tp.id,
  spi.position;
END;
$function$;
create policy "Admin full access to media_items" on "public"."media_items" as permissive for all to public using ((auth.role() = 'authenticated'::text));
create policy "Admin full access to player_settings" on "public"."player_settings" as permissive for all to public using ((auth.role() = 'authenticated'::text));
create policy "Admin full access to player_status" on "public"."player_status" as permissive for all to public using ((auth.role() = 'authenticated'::text));
create policy "Admin full access to players" on "public"."players" as permissive for all to public using ((auth.role() = 'authenticated'::text));
create policy "Admin full access to playlist_items" on "public"."playlist_items" as permissive for all to public using ((auth.role() = 'authenticated'::text));
create policy "Admin full access to playlists" on "public"."playlists" as permissive for all to public using ((auth.role() = 'authenticated'::text));
create policy "Admin full access to queue" on "public"."queue" as permissive for all to public using ((auth.role() = 'authenticated'::text));
create policy "Admin full access to system_logs" on "public"."system_logs" as permissive for
select to public using ((auth.role() = 'authenticated'::text));
CREATE TRIGGER enforce_bucket_name_length_trigger BEFORE
INSERT
  OR
UPDATE OF name ON storage.buckets FOR EACH ROW EXECUTE FUNCTION storage.enforce_bucket_name_length();
CREATE TRIGGER protect_buckets_delete BEFORE DELETE ON storage.buckets FOR EACH STATEMENT EXECUTE FUNCTION storage.protect_delete();
CREATE TRIGGER protect_objects_delete BEFORE DELETE ON storage.objects FOR EACH STATEMENT EXECUTE FUNCTION storage.protect_delete();
CREATE TRIGGER update_objects_updated_at BEFORE
UPDATE ON storage.objects FOR EACH ROW EXECUTE FUNCTION storage.update_updated_at_column();