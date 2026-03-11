#!/usr/bin/env node

const TARGET_URL = process.env.TARGET_URL;
const TARGET_SERVICE_KEY = process.env.TARGET_SERVICE_KEY;
const TARGET_PLAYER_ID = process.env.TARGET_PLAYER_ID || '00000000-0000-0000-0000-000000000001';

if (!TARGET_URL || !TARGET_SERVICE_KEY) {
  console.error('Missing required env vars: TARGET_URL, TARGET_SERVICE_KEY');
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

async function rest(path) {
  const res = await fetch(`${TARGET_URL}/rest/v1/${path}`, {
    headers: {
      apikey: TARGET_SERVICE_KEY,
      Authorization: `Bearer ${TARGET_SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`REST ${path} failed (${res.status}): ${text}`);
  return text ? JSON.parse(text) : null;
}

async function main() {
  const playlists = await rest(`playlists?player_id=eq.${TARGET_PLAYER_ID}&select=id,name,created_at`);

  for (const name of PLAYLIST_NAMES) {
    const matches = (playlists || [])
      .filter((p) => p.name === name)
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));

    if (matches.length === 0) {
      console.log(`${name}: missing`);
      continue;
    }

    const playlistId = matches[0].id;
    const items = await rest(`playlist_items?playlist_id=eq.${playlistId}&select=id`);
    console.log(`${name}: ${Array.isArray(items) ? items.length : 0} items`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
