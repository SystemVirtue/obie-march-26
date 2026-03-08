#!/usr/bin/env node
/**
 * audit-playlists-vs-cloudflare.mjs
 *
 * Checks ALL playlists in Supabase and identifies which videos are also
 * available in Cloudflare R2 (via the r2_files table).
 *
 * Matching strategies (in priority order):
 *   1. YouTube video ID match — extracts the 11-char YT ID from the media_item
 *      source_id ("youtube:XYZ") and searches r2_files file_name / object_key
 *   2. Artist + Title match — case-insensitive comparison of title and artist
 *      fields between media_items and r2_files
 *
 * Usage:
 *   node scripts/audit-playlists-vs-cloudflare.mjs
 *
 * Env vars (auto-loaded from .env at repo root):
 *   VITE_SUPABASE_URL       — project URL
 *   VITE_SUPABASE_ANON_KEY  — anon JWT (or VITE_SUPABASE_SERVICE_KEY)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Bootstrap env vars ──────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

function parseEnvFile(filepath) {
  try {
    const lines = readFileSync(filepath, 'utf8').split('\n');
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch { /* file absent — rely on shell env */ }
}

parseEnvFile(join(repoRoot, '.env'));
parseEnvFile(join(repoRoot, 'web', 'player', '.env'));

// ── Config ──────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.VITE_SUPABASE_SERVICE_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERROR: VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (or VITE_SUPABASE_SERVICE_KEY) must be set.');
  console.error('Create a .env file at the repo root or export them in your shell.');
  process.exit(1);
}

// ── Supabase REST helpers ───────────────────────────────────────────────────
async function sbGet(path) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase GET ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

/**
 * Paginated fetch — Supabase REST limits to max_rows (default 1000).
 * Uses Range header for offset pagination.
 */
async function sbGetAll(path) {
  const results = [];
  const pageSize = 1000;
  let offset = 0;
  while (true) {
    const res = await fetch(`${SUPABASE_URL}${path}`, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Range': `${offset}-${offset + pageSize - 1}`,
        'Prefer': 'count=exact',
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Supabase GET ${path} failed (${res.status}): ${text}`);
    }
    const data = await res.json();
    results.push(...data);
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  return results;
}

// ── YouTube ID helpers ──────────────────────────────────────────────────────
function extractYtIdFromSourceId(sourceId) {
  // source_id format: "youtube:dQw4w9WgXcQ"
  const match = sourceId.match(/^youtube:(.+)$/);
  return match ? match[1] : null;
}

function extractYtIdFromFilename(filename) {
  const nameNoExt = filename.replace(/\.[^.]+$/, '');
  const patterns = [
    /\[([A-Za-z0-9_-]{11})\]\s*$/,
    /\(([A-Za-z0-9_-]{11})\)\s*$/,
    /[-_\s]([A-Za-z0-9_-]{11})\s*$/,
    /^([A-Za-z0-9_-]{11})$/,
  ];
  for (const pattern of patterns) {
    const match = nameNoExt.match(pattern);
    if (match) return match[1];
  }
  return null;
}

/** Normalize a string for fuzzy title/artist comparison */
function normalize(s) {
  if (!s) return '';
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')  // strip non-alphanumeric
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Fetching playlists from Supabase...');
  const playlists = await sbGet('/rest/v1/playlists?order=name.asc&select=id,name,player_id');
  console.log(`Found ${playlists.length} playlist(s)\n`);

  if (playlists.length === 0) {
    console.log('No playlists found. Nothing to audit.');
    return;
  }

  console.log('Fetching all R2 files from Supabase...');
  const r2Files = await sbGetAll('/rest/v1/r2_files?select=id,object_key,file_name,title,artist');
  console.log(`Found ${r2Files.length} R2 file(s)\n`);

  // Build R2 lookup indexes
  // 1. YouTube ID → r2_file (check both file_name and full object_key)
  const r2ByYtId = new Map();
  for (const f of r2Files) {
    // Try file_name first (just the filename part)
    let ytId = extractYtIdFromFilename(f.file_name || '');
    // Also try the full object_key (may contain YT ID in folder paths)
    if (!ytId) ytId = extractYtIdFromFilename(f.object_key || '');
    // Also check if the YT ID appears anywhere in the object_key as a substring
    if (!ytId && f.object_key) {
      const idMatch = f.object_key.match(/[A-Za-z0-9_-]{11}/g);
      if (idMatch) {
        // Store all 11-char candidates — we'll match against known YT IDs only
        for (const candidate of idMatch) {
          if (!r2ByYtId.has(candidate)) r2ByYtId.set(candidate, f);
        }
      }
    }
    if (ytId) r2ByYtId.set(ytId, f);
  }
  // 2. Normalized "artist|title" → r2_file
  const r2ByArtistTitle = new Map();
  for (const f of r2Files) {
    if (f.title) {
      const key = `${normalize(f.artist)}|${normalize(f.title)}`;
      r2ByArtistTitle.set(key, f);
    }
    // Also index by just title (no artist) for fallback
    if (f.title) {
      const titleOnly = normalize(f.title);
      if (!r2ByArtistTitle.has(`|${titleOnly}`)) {
        r2ByArtistTitle.set(`|${titleOnly}`, f);
      }
    }
  }

  console.log(`R2 index: ${r2ByYtId.size} files with YouTube IDs, ${r2ByArtistTitle.size} with title keys\n`);
  console.log('='.repeat(80));

  // Track global stats
  let globalTotal = 0;
  let globalFound = 0;
  const allMissing = [];

  for (let pi = 0; pi < playlists.length; pi++) {
    const playlist = playlists[pi];
    console.log(`\nPlaylist ${pi + 1}/${playlists.length}: "${playlist.name}"`);
    console.log('-'.repeat(60));

    // Fetch playlist items with their media_items
    const items = await sbGet(
      `/rest/v1/playlist_items?playlist_id=eq.${playlist.id}&order=position.asc&select=position,media_item_id,media_items(id,source_id,source_type,title,artist,url,thumbnail)`
    );

    if (items.length === 0) {
      console.log('  (empty playlist)');
      continue;
    }

    let found = 0;
    const missing = [];

    for (const item of items) {
      const media = item.media_items;
      if (!media) {
        missing.push({ position: item.position, title: '(unknown)', ytId: null, reason: 'no media_item' });
        continue;
      }

      const ytId = extractYtIdFromSourceId(media.source_id || '');
      let matchedR2 = null;
      let matchMethod = '';

      // Strategy 1: YouTube ID match
      if (ytId && r2ByYtId.has(ytId)) {
        matchedR2 = r2ByYtId.get(ytId);
        matchMethod = 'youtube_id';
      }

      // Strategy 2: Artist + Title match
      if (!matchedR2 && media.title) {
        const keyWithArtist = `${normalize(media.artist)}|${normalize(media.title)}`;
        const keyTitleOnly = `|${normalize(media.title)}`;
        if (r2ByArtistTitle.has(keyWithArtist)) {
          matchedR2 = r2ByArtistTitle.get(keyWithArtist);
          matchMethod = 'artist+title';
        } else if (r2ByArtistTitle.has(keyTitleOnly)) {
          matchedR2 = r2ByArtistTitle.get(keyTitleOnly);
          matchMethod = 'title_only';
        }
      }

      if (matchedR2) {
        found++;
      } else {
        missing.push({
          position: item.position,
          title: media.title || '(untitled)',
          artist: media.artist || '',
          ytId: ytId || '(no YT ID)',
          sourceId: media.source_id,
        });
      }
    }

    const total = items.length;
    globalTotal += total;
    globalFound += found;
    const pct = total > 0 ? ((found / total) * 100).toFixed(1) : '0.0';
    console.log(`  [${found}] of [${total}] videos found in Cloudflare (${pct}%)`);

    if (missing.length > 0) {
      console.log(`  Missing ${missing.length} video(s):`);
      for (const m of missing.slice(0, 5)) {
        const artistStr = m.artist ? `${m.artist} - ` : '';
        console.log(`    #${m.position}: ${artistStr}${m.title}  (${m.ytId})`);
      }
      if (missing.length > 5) {
        console.log(`    ... and ${missing.length - 5} more`);
      }
    }

    allMissing.push(...missing.map(m => ({ ...m, playlist: playlist.name })));
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(80));
  console.log('SUMMARY');
  console.log('='.repeat(80));
  const globalPct = globalTotal > 0 ? ((globalFound / globalTotal) * 100).toFixed(1) : '0.0';
  console.log(`Total playlist videos:    ${globalTotal}`);
  console.log(`Found in Cloudflare:      ${globalFound} (${globalPct}%)`);
  console.log(`NOT found in Cloudflare:  ${globalTotal - globalFound}`);
  console.log(`Total R2 files:           ${r2Files.length}`);
  console.log(`Playlists scanned:        ${playlists.length}`);
  console.log('='.repeat(80));

  // ── Export ──────────────────────────────────────────────────────────────────
  const outputPath = join(repoRoot, 'audit-playlists-vs-cloudflare.txt');
  const lines = [];
  lines.push('PLAYLIST vs CLOUDFLARE AUDIT');
  lines.push(`Date: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('SUMMARY');
  lines.push(`Total playlist videos:    ${globalTotal}`);
  lines.push(`Found in Cloudflare:      ${globalFound} (${globalPct}%)`);
  lines.push(`NOT found in Cloudflare:  ${globalTotal - globalFound}`);
  lines.push(`Total R2 files:           ${r2Files.length}`);
  lines.push(`Playlists scanned:        ${playlists.length}`);
  lines.push('');

  if (allMissing.length > 0) {
    lines.push('='.repeat(80));
    lines.push('VIDEOS NOT FOUND IN CLOUDFLARE');
    lines.push('='.repeat(80));
    lines.push('');
    lines.push('Playlist | Artist | Title | YouTube ID');
    lines.push('-'.repeat(80));
    for (const m of allMissing) {
      const artist = m.artist || '';
      const ytId = m.ytId || '(no YT ID)';
      lines.push(`${m.playlist} | ${artist} | ${m.title} | ${ytId}`);
    }
  } else {
    lines.push('All playlist videos are available in Cloudflare! 🎉');
  }

  writeFileSync(outputPath, lines.join('\n') + '\n', 'utf8');
  console.log(`\nFull report exported to: ${outputPath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
