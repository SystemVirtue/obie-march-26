-- Add Cloudflare R2 file cache table
-- Mirrors the R2 bucket contents for browsing/searching from the kiosk

CREATE TABLE IF NOT EXISTS r2_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_name TEXT NOT NULL,
  object_key TEXT NOT NULL,
  file_name TEXT NOT NULL,
  content_type TEXT,
  size_bytes BIGINT,
  etag TEXT,
  last_modified TIMESTAMPTZ,
  public_url TEXT NOT NULL,
  -- Display metadata (populated manually or via enrichment)
  title TEXT,
  artist TEXT,
  duration INT,
  thumbnail TEXT,
  tags TEXT[],
  synced_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(bucket_name, object_key)
);

CREATE INDEX idx_r2_files_bucket ON r2_files(bucket_name);
CREATE INDEX idx_r2_files_content_type ON r2_files(content_type);
CREATE INDEX idx_r2_files_title ON r2_files USING gin (to_tsvector('simple', COALESCE(title, '') || ' ' || COALESCE(file_name, '')));

-- RLS
ALTER TABLE r2_files ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated full access to r2_files"
  ON r2_files FOR ALL
  USING (auth.role() = 'authenticated');

CREATE POLICY "Anon can read r2_files"
  ON r2_files FOR SELECT
  USING (true);

-- Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE r2_files;
