-- Add yt-dlp local-source fallback columns to player_status
-- source: 'youtube' (default — use YouTube iframe) | 'local' (use Supabase Storage URL)
-- local_url: public URL of the downloaded .mp4 in the 'downloads' storage bucket
-- These columns are written by the download-video Edge Function and read by the
-- Player app to switch from the YT iframe to a native <video> element.

ALTER TABLE player_status
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'youtube'
    CHECK (source IN ('youtube', 'local')),
  ADD COLUMN IF NOT EXISTS local_url TEXT;
