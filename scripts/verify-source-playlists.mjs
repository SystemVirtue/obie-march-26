#!/usr/bin/env node

const SOURCE_URL = process.env.SOURCE_URL;
const SOURCE_SERVICE_KEY = process.env.SOURCE_SERVICE_KEY;

if (!SOURCE_URL || !SOURCE_SERVICE_KEY) {
  console.error('Missing required env vars: SOURCE_URL, SOURCE_SERVICE_KEY');
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
  const res = await fetch(`${SOURCE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SOURCE_SERVICE_KEY,
      Authorization: `Bearer ${SOURCE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`REST ${path} failed (${res.status}): ${text}`);
  return text ? JSON.parse(text) : null;
}

async function main() {
  const playlists = await rest('playlists?select=id,name,created_at');
  for (const name of PLAYLIST_NAMES) {
    const matches = (playlists || []).filter((p) => p.name === name);
    if (matches.length === 0) {
      console.log(`${name}: missing in source`);
      continue;
    }

    const latest = matches.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0];
    const items = await rest(`playlist_items?playlist_id=eq.${latest.id}&select=id`);
    console.log(`${name}: ${Array.isArray(items) ? items.length : 0} items in source`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
