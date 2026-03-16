#!/usr/bin/env node

const SOURCE_URL = process.env.SOURCE_URL || 'https://syccqoextpxifmumvxqw.supabase.co';
const TARGET_URL = process.env.TARGET_URL || 'https://fcabzrkcsfjimpxxnvco.supabase.co';
const SOURCE_SERVICE_KEY = process.env.SOURCE_SERVICE_KEY;
const TARGET_SERVICE_KEY = process.env.TARGET_SERVICE_KEY;
const CANONICAL_PLAYER_ID = process.env.CANONICAL_PLAYER_ID || '00000000-0000-0000-0000-000000000001';

if (!SOURCE_SERVICE_KEY || !TARGET_SERVICE_KEY) {
  console.error('Missing SOURCE_SERVICE_KEY or TARGET_SERVICE_KEY');
  process.exit(1);
}

function q(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

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
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`REST ${opts.method || 'GET'} ${path} failed (${res.status}): ${text.slice(0, 500)}`);
  }

  if (!text) return null;
  return JSON.parse(text);
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

async function ensurePlayerPlaylists(playerId, sourcePlaylists) {
  const existing = await rest(
    TARGET_URL,
    TARGET_SERVICE_KEY,
    `playlists?player_id=eq.${playerId}&select=id,name,created_at`
  );

  const byName = new Map();
  for (const p of existing || []) {
    const prev = byName.get(p.name);
    if (!prev || String(p.created_at || '') > String(prev.created_at || '')) {
      byName.set(p.name, p);
    }
  }

  const map = new Map();
  for (const src of sourcePlaylists) {
    let target = byName.get(src.name);
    if (!target) {
      const created = await rest(TARGET_URL, TARGET_SERVICE_KEY, 'playlists?select=id,name,created_at', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: [{
          player_id: playerId,
          name: src.name,
          description: src.description || null,
          is_active: false,
        }],
      });
      target = created[0];
      byName.set(src.name, target);
    }
    map.set(src.id, target.id);
  }

  return map;
}

async function rebuildItemsForPlayer(playerId, sourcePlaylists, sourceItems, sourceMediaById, targetMediaBySourceId, sourceToTargetPlaylistMap) {
  const sourcePlaylistIds = new Set(sourcePlaylists.map((p) => p.id));

  const itemsByTargetPlaylist = new Map();
  for (const item of sourceItems) {
    if (!sourcePlaylistIds.has(item.playlist_id)) continue;

    const srcMedia = sourceMediaById.get(item.media_item_id);
    if (!srcMedia) continue;

    const targetMediaId = targetMediaBySourceId.get(srcMedia.source_id);
    const targetPlaylistId = sourceToTargetPlaylistMap.get(item.playlist_id);
    if (!targetMediaId || !targetPlaylistId) continue;

    const arr = itemsByTargetPlaylist.get(targetPlaylistId) || [];
    arr.push({
      playlist_id: targetPlaylistId,
      position: item.position,
      media_item_id: targetMediaId,
    });
    itemsByTargetPlaylist.set(targetPlaylistId, arr);
  }

  let inserted = 0;
  for (const [playlistId, rows] of itemsByTargetPlaylist.entries()) {
    await rest(TARGET_URL, TARGET_SERVICE_KEY, `playlist_items?playlist_id=eq.${playlistId}`, {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' },
    });

    const normalized = rows
      .sort((a, b) => a.position - b.position)
      .map((row, idx) => ({
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
      inserted += group.length;
    }
  }

  console.log(`  ${playerId}: rebuilt ${inserted} playlist_items`);
}

async function main() {
  console.log('1) Loading source playlists...');
  const sourcePlaylists = await restAll(
    SOURCE_URL,
    SOURCE_SERVICE_KEY,
    'playlists?select=id,name,description,created_at&order=created_at.asc'
  );

  if (sourcePlaylists.length === 0) {
    throw new Error('No playlists found in source project.');
  }

  console.log(`   Source playlists: ${sourcePlaylists.length}`);

  const sourcePlaylistIds = sourcePlaylists.map((p) => p.id);
  const idsList = sourcePlaylistIds.map(q).join(',');

  console.log('2) Loading source playlist_items...');
  const sourceItems = await restAll(
    SOURCE_URL,
    SOURCE_SERVICE_KEY,
    `playlist_items?playlist_id=in.(${idsList})&select=playlist_id,position,media_item_id`
  );
  console.log(`   Source playlist_items: ${sourceItems.length}`);

  const neededMediaIds = [...new Set(sourceItems.map((i) => i.media_item_id))];
  console.log(`3) Loading source media_items: ${neededMediaIds.length}`);

  const sourceMediaById = new Map();
  for (const group of chunk(neededMediaIds, 100)) {
    const mediaIds = group.map(q).join(',');
    const mediaRows = await rest(
      SOURCE_URL,
      SOURCE_SERVICE_KEY,
      `media_items?id=in.(${mediaIds})&select=id,source_id,source_type,title,artist,url,duration,thumbnail,metadata`
    );
    for (const m of mediaRows || []) sourceMediaById.set(m.id, m);
  }

  console.log('4) Upserting media_items into target...');
  const upsertRows = neededMediaIds
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

  for (const group of chunk(upsertRows, 200)) {
    await rest(TARGET_URL, TARGET_SERVICE_KEY, 'media_items?on_conflict=source_id&select=id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: group,
    });
  }

  const sourceIds = [...new Set(upsertRows.map((m) => m.source_id))];
  const targetMediaBySourceId = new Map();
  for (const group of chunk(sourceIds, 100)) {
    const inList = group.map(q).join(',');
    const rows = await rest(
      TARGET_URL,
      TARGET_SERVICE_KEY,
      `media_items?source_id=in.(${inList})&select=id,source_id`
    );
    for (const r of rows || []) targetMediaBySourceId.set(r.source_id, r.id);
  }

  console.log('5) Ensuring canonical player playlists and rebuilding items...');
  const canonicalMap = await ensurePlayerPlaylists(CANONICAL_PLAYER_ID, sourcePlaylists);
  await rebuildItemsForPlayer(
    CANONICAL_PLAYER_ID,
    sourcePlaylists,
    sourceItems,
    sourceMediaById,
    targetMediaBySourceId,
    canonicalMap
  );

  console.log('6) Syncing playlists to all target players...');
  const targetPlayers = await restAll(
    TARGET_URL,
    TARGET_SERVICE_KEY,
    'players?select=id,name,jukebox_slug'
  );

  for (const player of targetPlayers) {
    const map = await ensurePlayerPlaylists(player.id, sourcePlaylists);
    await rebuildItemsForPlayer(
      player.id,
      sourcePlaylists,
      sourceItems,
      sourceMediaById,
      targetMediaBySourceId,
      map
    );
  }

  console.log('Done.');
  console.log(`Source playlists synced: ${sourcePlaylists.length}`);
  console.log(`Target players synced: ${targetPlayers.length}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
