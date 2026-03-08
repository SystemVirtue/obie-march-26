-- 0034_fix_create_or_get_media_item.sql
-- Fix: media_items has fetched_at, not updated_at.
-- Migration 0026 incorrectly referenced updated_at in the ON CONFLICT clause,
-- causing every kiosk request to fail with "Failed to create media item".

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
      title      = EXCLUDED.title,
      artist     = EXCLUDED.artist,
      url        = EXCLUDED.url,
      duration   = EXCLUDED.duration,
      thumbnail  = EXCLUDED.thumbnail,
      metadata   = EXCLUDED.metadata,
      fetched_at = NOW()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION create_or_get_media_item(TEXT, TEXT, TEXT, TEXT, TEXT, INT, TEXT, JSONB)
  TO authenticated, service_role;
