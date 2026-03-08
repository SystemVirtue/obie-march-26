-- 0026_add_create_or_get_media_item.sql
-- Consolidate media item deduplication logic into a single atomic RPC.
-- Previously this select-then-insert pattern was duplicated in:
--   - kiosk-handler/index.ts (lines 167-206)
--   - playlist-manager/index.ts (lines 319-329)
-- Both edge functions now call this RPC instead.

CREATE OR REPLACE FUNCTION create_or_get_media_item(
  p_source_id    TEXT,
  p_source_type  TEXT,
  p_title        TEXT,
  p_artist       TEXT    DEFAULT NULL,
  p_url          TEXT    DEFAULT NULL,
  p_duration     INT     DEFAULT NULL,
  p_thumbnail    TEXT    DEFAULT NULL,
  p_metadata     JSONB   DEFAULT '{}'
)
RETURNS UUID AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO media_items (
    source_id,
    source_type,
    title,
    artist,
    url,
    duration,
    thumbnail,
    metadata
  )
  VALUES (
    p_source_id,
    p_source_type,
    p_title,
    p_artist,
    p_url,
    p_duration,
    p_thumbnail,
    p_metadata
  )
  ON CONFLICT (source_id) DO UPDATE
    SET
      title     = EXCLUDED.title,
      artist    = EXCLUDED.artist,
      url       = EXCLUDED.url,
      duration  = EXCLUDED.duration,
      thumbnail = EXCLUDED.thumbnail,
      metadata  = EXCLUDED.metadata,
      updated_at = NOW()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute to authenticated and service role
GRANT EXECUTE ON FUNCTION create_or_get_media_item(TEXT, TEXT, TEXT, TEXT, TEXT, INT, TEXT, JSONB)
  TO authenticated, service_role;
