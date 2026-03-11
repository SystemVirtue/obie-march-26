#!/usr/bin/env node

const SOURCE_URL = process.env.SOURCE_URL;
const SOURCE_SERVICE_KEY = process.env.SOURCE_SERVICE_KEY;
const TARGET_URL = process.env.TARGET_URL;
const TARGET_SERVICE_KEY = process.env.TARGET_SERVICE_KEY;
const TARGET_PLAYER_ID = process.env.TARGET_PLAYER_ID || '00000000-0000-0000-0000-000000000001';

if (!SOURCE_URL || !SOURCE_SERVICE_KEY || !TARGET_URL || !TARGET_SERVICE_KEY) {
  console.error('Missing required env vars: SOURCE_URL, SOURCE_SERVICE_KEY, TARGET_URL, TARGET_SERVICE_KEY');
  process.exit(1);
}

const PLAYLIST_NAMES = [
  'DJAMMMS Default Playlist',
  'Obie Nights',
  'Obie Playlist',
  'Obie Jo',
  'Karaoke',
  'Poly',
  'Obie Johno',
];

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

async function rest(url, key, path, opts = {}) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method: opts.method || 'GET',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`REST ${opts.method || 'GET'} ${path} failed (${res.status}): ${text}`);
  }

  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function restAll(url, key, path, pageSize = 1000) {
  const rows = [];
  let offset = 0;

  while (true) {
    const sep = path.includes('?') ? '&' : '?';
    const page = await rest(url, key, `${path}${sep}limit=${pageSize}&offset=${offset}`);
    if (!Array.isArray(page) || page.length === 0) break;

    rows.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }

  return rows;
}

async function ensureTargetPlaylists(sourcePlaylists) {
  const targetPlaylists = await rest(
    TARGET_URL,
    TARGET_SERVICE_KEY,
    `playlists?player_id=eq.${TARGET_PLAYER_ID}&select=id,name,created_at`
  );

  const byName = new Map();
  for (const p of targetPlaylists || []) {
    const existing = byName.get(p.name);
    if (!existing || String(p.created_at || '') > String(existing.created_at || '')) {
      byName.set(p.name, p);
    }
  }

  const map = new Map();
  for (const src of sourcePlaylists) {
    let tgt = byName.get(src.name);
    if (!tgt) {
      const created = await rest(TARGET_URL, TARGET_SERVICE_KEY, 'playlists?select=id,name,created_at', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: [{
          player_id: TARGET_PLAYER_ID,
          name: src.name,
          description: src.description || null,
          is_active: false,
        }],
      });
      tgt = created[0];
      byName.set(src.name, tgt);
    }
    map.set(src.id, tgt.id);
  }

  return map;
}

async function main() {
  console.log('Fetching source playlists...');
  const sourcePlaylistsAll = await restAll(SOURCE_URL, SOURCE_SERVICE_KEY, 'playlists?select=id,name,description');
  const sourcePlaylists = (sourcePlaylistsAll || []).filter((p) => PLAYLIST_NAMES.includes(p.name));

  if (sourcePlaylists.length === 0) {
    console.error('No matching playlists found in source project.');
    process.exit(1);
  }

  console.log(`Found ${sourcePlaylists.length} source playlists.`);

  const sourcePlaylistIds = sourcePlaylists.map((p) => p.id);
  const idsList = sourcePlaylistIds.map((x) => `"${x}"`).join(',');

  console.log('Fetching source playlist_items...');
  const sourceItems = await restAll(
    SOURCE_URL,
    SOURCE_SERVICE_KEY,
    `playlist_items?playlist_id=in.(${idsList})&select=playlist_id,position,media_item_id`
  );

  const neededMediaIds = [...new Set((sourceItems || []).map((i) => i.media_item_id))];
  console.log(`Need ${neededMediaIds.length} media items.`);

  const sourceMediaById = new Map();
  for (const group of chunk(neededMediaIds, 100)) {
    const mediaIds = group.map((x) => `"${x}"`).join(',');
    const mediaRows = await rest(
      SOURCE_URL,
      SOURCE_SERVICE_KEY,
      `media_items?id=in.(${mediaIds})&select=id,source_id,source_type,title,artist,url,duration,thumbnail,metadata`
    );
    for (const m of mediaRows || []) sourceMediaById.set(m.id, m);
  }

  console.log('Ensuring target playlists exist...');
  const playlistMap = await ensureTargetPlaylists(sourcePlaylists);

  console.log('Upserting media_items into target...');
  const mediaRows = neededMediaIds
    .map((id) => sourceMediaById.get(id))
    .filter(Boolean)
    .map((m) => ({
      source_id: m.source_id,
      source_type: m.source_type,
      title: m.title,
      artist: m.artist,
      url: m.url,
      duration: m.duration,
      thumbnail: m.thumbnail,
      metadata: m.metadata || {},
    }));

  for (const group of chunk(mediaRows, 200)) {
    await rest(
      TARGET_URL,
      TARGET_SERVICE_KEY,
      'media_items?on_conflict=source_id&select=id',
      {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: group,
      }
    );
  }

  const sourceIds = [...new Set(mediaRows.map((m) => m.source_id))];
  const targetMediaBySourceId = new Map();
  for (const group of chunk(sourceIds, 100)) {
    const inList = group.map((x) => `"${String(x).replaceAll('"', '\\"')}"`).join(',');
    const rows = await rest(
      TARGET_URL,
      TARGET_SERVICE_KEY,
      `media_items?source_id=in.(${inList})&select=id,source_id`
    );
    for (const r of rows || []) targetMediaBySourceId.set(r.source_id, r.id);
  }

  console.log('Rebuilding target playlist_items...');
  const itemsByTargetPlaylist = new Map();
  for (const item of sourceItems || []) {
    const srcMedia = sourceMediaById.get(item.media_item_id);
    if (!srcMedia) continue;
    const targetMediaId = targetMediaBySourceId.get(srcMedia.source_id);
    const targetPlaylistId = playlistMap.get(item.playlist_id);
    if (!targetMediaId || !targetPlaylistId) continue;

    const arr = itemsByTargetPlaylist.get(targetPlaylistId) || [];
    arr.push({
      playlist_id: targetPlaylistId,
      position: item.position,
      media_item_id: targetMediaId,
    });
    itemsByTargetPlaylist.set(targetPlaylistId, arr);
  }

  let insertedItems = 0;
  for (const [playlistId, rows] of itemsByTargetPlaylist.entries()) {
    await rest(TARGET_URL, TARGET_SERVICE_KEY, `playlist_items?playlist_id=eq.${playlistId}`, {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' },
    });

    const sorted = rows.sort((a, b) => a.position - b.position);
    const normalized = sorted.map((row, idx) => ({
      playlist_id: row.playlist_id,
      media_item_id: row.media_item_id,
      position: idx,
    }));

    for (const group of chunk(normalized, 500)) {
      await rest(TARGET_URL, TARGET_SERVICE_KEY, 'playlist_items?select=id', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: group,
      });
      insertedItems += group.length;
    }
  }

  console.log('Import complete.');
  console.log(`Playlists mapped: ${playlistMap.size}`);
  console.log(`Playlist items inserted: ${insertedItems}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
