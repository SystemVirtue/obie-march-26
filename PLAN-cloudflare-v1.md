# Cloudflare R2 Video Source Integration Plan

## Overview

Add Cloudflare R2 as a second video source alongside YouTube. Videos stored in an R2 bucket can be played in the existing iFrame Player, browsed/added from the Kiosk Search, and managed via Supabase database tables that mirror the R2 bucket contents.

---

## Architecture Summary

The existing system has three playback modes: YouTube iFrame, YTM Desktop, and local (yt-dlp downloaded `.mp4` via `<video>` tag). Cloudflare R2 videos will reuse the **local/`<video>` tag pathway** since R2 serves files over HTTPS just like any other video URL. The key changes are:

1. **Database**: New `r2_files` table to cache the R2 bucket file list; extend `media_items` and `player_status` to support `source_type = 'cloudflare'`
2. **Player**: Extend the video source switching logic to handle `source = 'cloudflare'` using the existing `<video>` element
3. **Kiosk Search**: Add a "Browse R2" tab/toggle alongside YouTube search, displaying R2 videos from the database cache
4. **Backend**: New edge function to sync R2 bucket contents into Supabase, and extend kiosk-handler to support R2 video requests

---

## Phase 1: Database Schema Changes

### 1A. New migration: `r2_files` table

Create a table that mirrors the Cloudflare R2 bucket file list:

```sql
CREATE TABLE r2_files (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bucket_name TEXT NOT NULL,              -- R2 bucket name
  object_key TEXT NOT NULL,               -- Full object key/path in bucket
  file_name TEXT NOT NULL,                -- Human-readable filename
  content_type TEXT,                      -- MIME type (video/mp4, etc.)
  size_bytes BIGINT,                      -- File size
  etag TEXT,                              -- R2 ETag for change detection
  last_modified TIMESTAMPTZ,             -- R2 last modified timestamp
  public_url TEXT NOT NULL,               -- Full public URL for playback
  -- Parsed metadata (can be populated manually or via an enrichment step)
  title TEXT,                             -- Display title (defaults to filename)
  artist TEXT,                            -- Artist/creator
  duration INT,                           -- Duration in seconds (if known)
  thumbnail TEXT,                         -- Thumbnail URL (if available)
  tags TEXT[],                            -- User-defined tags for filtering
  synced_at TIMESTAMPTZ DEFAULT NOW(),    -- When this row was last synced from R2
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(bucket_name, object_key)
);

CREATE INDEX idx_r2_files_bucket ON r2_files(bucket_name);
CREATE INDEX idx_r2_files_content_type ON r2_files(content_type);

-- Enable RLS
ALTER TABLE r2_files ENABLE ROW LEVEL SECURITY;

-- Authenticated users (admin) get full access
CREATE POLICY "Admin full access to r2_files"
  ON r2_files FOR ALL
  USING (auth.role() = 'authenticated');

-- Anon (kiosk/player) can read
CREATE POLICY "Anon can read r2_files"
  ON r2_files FOR SELECT
  USING (true);

-- Enable realtime
ALTER PUBLICATION supabase_realtime ADD TABLE r2_files;
```

### 1B. Extend `player_status.source` enum

Add `'cloudflare'` as a valid source value:

```sql
-- Update the source column to accept 'cloudflare'
-- (source column is TEXT, no CHECK constraint currently — just document the new value)
-- The player_status.source field currently accepts 'youtube' | 'local'
-- We add 'cloudflare' as a third option
COMMENT ON COLUMN player_status.source IS 'Playback source: youtube (iframe), local (yt-dlp download), or cloudflare (R2 bucket)';
```

### 1C. New RPC: `create_or_get_media_item_from_r2`

Extend the existing `create_or_get_media_item` pattern for R2 sources:

```sql
-- This can reuse the existing create_or_get_media_item RPC since it already
-- accepts source_type as a parameter. R2 items will use:
--   source_id = 'cloudflare:<object_key>'
--   source_type = 'cloudflare'
--   url = public R2 URL
-- No new RPC needed — the existing one handles it.
```

### 1D. Add `cloudflare_enabled` to `player_settings`

```sql
ALTER TABLE player_settings
  ADD COLUMN cloudflare_enabled BOOLEAN DEFAULT false,
  ADD COLUMN cloudflare_r2_public_url TEXT;  -- Base public URL for the R2 bucket
```

**Files to create/modify:**
- `supabase/migrations/XXXX_add_r2_files_table.sql` (new)
- `supabase/migrations/XXXX_add_cloudflare_settings.sql` (new)

---

## Phase 2: Backend Edge Functions

### 2A. New edge function: `r2-sync`

Syncs the R2 bucket file list into the `r2_files` table:

- **Input**: `{ action: 'sync' | 'list', bucket_name?: string }`
- **Sync behavior**:
  1. Call Cloudflare R2 S3-compatible API (ListObjectsV2) to get all objects
  2. Filter to video MIME types (video/mp4, video/webm, video/ogg)
  3. Upsert into `r2_files` table (match on `bucket_name + object_key`)
  4. Delete rows from `r2_files` that no longer exist in the bucket
  5. Return sync summary (added, updated, deleted counts)
- **Environment variables needed**:
  - `CLOUDFLARE_R2_ACCESS_KEY_ID`
  - `CLOUDFLARE_R2_SECRET_ACCESS_KEY`
  - `CLOUDFLARE_R2_ENDPOINT` (account-specific S3 endpoint)
  - `CLOUDFLARE_R2_BUCKET_NAME`
  - `CLOUDFLARE_R2_PUBLIC_URL` (the public access URL prefix)

**File**: `supabase/functions/r2-sync/index.ts` (new)

### 2B. Extend `kiosk-handler` for R2 search

Add a new action `'search_r2'` to the kiosk-handler:

- Queries `r2_files` table with text search on `title`, `file_name`, `artist`, and `tags`
- Returns results in the same `SearchResult` format as YouTube results
- Also add `'request_r2'` action that creates a media_item from an r2_file and enqueues it

**File**: `supabase/functions/kiosk-handler/index.ts` (modify)

### 2C. Extend `queue_next` behavior

When `queue_next` returns a media item with `source_type = 'cloudflare'`, the `player_status` should be updated with:
- `source = 'cloudflare'`
- `local_url = <the R2 public URL>`

This can be done by modifying `queue_next` to check the media item's `source_type` and set the appropriate source/URL fields. Alternatively, the player-control edge function can handle this mapping.

**File**: New migration to update `queue_next` function OR modify `player-control/index.ts`

---

## Phase 3: Player Modifications

### 3A. Extend `PlayerStatus` type

Update the TypeScript interface:

```typescript
export interface PlayerStatus {
  // ... existing fields ...
  source?: 'youtube' | 'local' | 'cloudflare';
  local_url?: string | null;       // Also used for cloudflare URLs
  cloudflare_url?: string | null;   // Dedicated field (optional, can reuse local_url)
}
```

**Decision**: Reuse `local_url` for Cloudflare URLs (since both use `<video>` element). The `source` field distinguishes the origin. This minimizes changes.

### 3B. Update Player `App.tsx` source switching

In the realtime subscription handler (around line 598-610), extend the source check:

```typescript
// Current:
if (newStatus.source === 'local' && newStatus.local_url) { ... }

// Updated:
if ((newStatus.source === 'local' || newStatus.source === 'cloudflare') && newStatus.local_url) {
  // Both local and cloudflare use the <video> element
  if (newStatus.local_url !== localPlaybackUrl) {
    console.log(`[Player][realtime] source=${newStatus.source} → activating <video>`);
    setLocalPlaybackUrl(newStatus.local_url);
  }
}
```

The `<video>` element at line 1202-1224 already handles any URL — no changes needed there.

### 3C. Update video loading logic

In the `useEffect` that creates/updates the YouTube player (line 954+), add a guard:

```typescript
// Skip YouTube player creation for cloudflare source items
if (currentMedia?.source_type === 'cloudflare') {
  // Cloudflare videos are handled by the <video> element via localPlaybackUrl
  return;
}
```

**File**: `web/player/src/App.tsx` (modify)

---

## Phase 4: Kiosk Search Modifications

### 4A. Add source toggle to SearchKeyboard

Add a toggle button (similar to the karaoke checkbox) to switch between YouTube search and R2 Browse:

```
[YouTube] [Cloudflare R2]  ← toggle/tab selector
```

When "Cloudflare R2" is selected:
- The search queries the `r2_files` table instead of YouTube API
- Results display as the same `VideoResultCard` grid
- The SEARCH button label could change to "BROWSE" or stay the same

### 4B. Update `SearchInterface.tsx`

- Accept a new prop: `searchSource: 'youtube' | 'cloudflare'`
- Pass it through to the keyboard and result display
- When source is `'cloudflare'`, video selection calls a different handler that creates/gets a media item from R2

### 4C. Update `SearchResult` type

The existing `SearchResult` type works for R2 videos with minimal changes:
- `id` → r2_file UUID
- `title` → r2_file title or filename
- `artist` → r2_file artist
- `thumbnail` → r2_file thumbnail (or a default video icon)
- `url` → r2_file public_url
- `duration` → r2_file duration

Add an optional field:
```typescript
export interface SearchResult {
  // ... existing fields ...
  source?: 'youtube' | 'cloudflare';  // To distinguish result origin
}
```

### 4D. Update Kiosk App.tsx search flow

- Add state: `searchSource: 'youtube' | 'cloudflare'`
- When `searchSource === 'cloudflare'`: call `callKioskHandler({ action: 'search_r2', query })` instead of `{ action: 'search', query }`
- When confirming add for cloudflare: call `callKioskHandler({ action: 'request_r2', r2_file_id, player_id })` instead of `{ action: 'request', url }`

**Files to modify:**
- `web/shared/types.ts`
- `web/kiosk/src/App.tsx`
- `web/kiosk/src/components/SearchInterface.tsx`
- `web/kiosk/src/components/SearchKeyboard.tsx`

---

## Phase 5: Admin Panel (Optional/Future)

### 5A. R2 Management Page

- Trigger R2 sync from admin panel
- View/edit R2 file metadata (title, artist, tags)
- Toggle `cloudflare_enabled` setting
- Configure R2 bucket URL

### 5B. Queue source indicator

Show a small badge on queue items indicating YouTube vs Cloudflare source.

---

## File Change Summary

### New Files
| File | Purpose |
|------|---------|
| `supabase/migrations/XXXX_add_r2_files_table.sql` | R2 files cache table + RLS + indexes |
| `supabase/migrations/XXXX_add_cloudflare_settings.sql` | Player settings for Cloudflare |
| `supabase/functions/r2-sync/index.ts` | Edge function to sync R2 bucket → database |

### Modified Files
| File | Changes |
|------|---------|
| `web/shared/supabase-client.ts` | Add `'cloudflare'` to `PlayerStatus.source` type, add R2-related API helpers |
| `web/shared/types.ts` | Add `source` field to `SearchResult` |
| `web/player/src/App.tsx` | Extend source switching to handle `'cloudflare'` (3-4 lines changed) |
| `web/kiosk/src/App.tsx` | Add search source toggle state, R2 search/request handlers |
| `web/kiosk/src/components/SearchInterface.tsx` | Accept and pass through `searchSource` prop |
| `web/kiosk/src/components/SearchKeyboard.tsx` | Add YouTube/R2 source toggle UI |
| `supabase/functions/kiosk-handler/index.ts` | Add `search_r2` and `request_r2` actions |

---

## Implementation Order

1. **Database migrations** — Create `r2_files` table and settings columns
2. **R2 sync edge function** — Populate the R2 files table
3. **Player source switching** — Enable `<video>` playback for cloudflare source (minimal change)
4. **Kiosk handler backend** — R2 search and request actions
5. **Kiosk UI** — Source toggle and R2 browse/select flow
6. **Testing** — End-to-end: sync → browse → select → play

---

## Key Design Decisions

1. **Reuse `<video>` element**: R2 serves MP4/WebM over HTTPS — the existing `<video>` tag handles this perfectly. No new player component needed.

2. **Reuse `local_url` field**: Rather than adding a new column, Cloudflare URLs are stored in `player_status.local_url` with `source = 'cloudflare'` to distinguish from yt-dlp downloads.

3. **Reuse `create_or_get_media_item`**: R2 videos are stored in `media_items` with `source_type = 'cloudflare'` and `source_id = 'cloudflare:<object_key>'`. The existing deduplication logic works as-is.

4. **S3-compatible API**: R2 is S3-compatible, so the sync function uses standard AWS S3 SDK (ListObjectsV2) with Cloudflare's endpoint.

5. **Separate search action**: Rather than mixing YouTube and R2 results, the kiosk has a toggle to switch between sources. This keeps the UX clean and avoids confusion.
