#!/usr/bin/env node
/**
 * List all Jukeboxes with statistics
 * Usage: npx tsx scripts/list-jukeboxes.ts
 */

import { createClient } from '@supabase/supabase-js';
import { Database } from '../web/shared/database.types';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://fcabzrkcsfjimpxxnvco.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.VITE_SUPABASE_SERVICE_KEY;

if (!SUPABASE_SERVICE_KEY) {
  console.error('Error: VITE_SUPABASE_SERVICE_KEY environment variable required');
  console.error('Run with: VITE_SUPABASE_SERVICE_KEY=your_key npx tsx scripts/list-jukeboxes.ts');
  process.exit(1);
}

const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function listJukeboxes() {
  console.log('\n🔍 Fetching jukebox data...\n');

  // Fetch all players (jukeboxes) with related data
  const { data: players, error } = await supabase
    .from('players')
    .select(`
      id,
      name,
      display_name,
      jukebox_slug,
      owner_id,
      active_playlist_id,
      created_at,
      player_status!inner (
        current_media_id,
        current_media:media_items!player_status_current_media_id_fkey (
          title
        )
      ),
      playlists (
        id,
        name,
        is_active,
        playlist_items (
          id
        )
      )
    `)
    .order('name');

  if (error) {
    console.error('Error fetching jukeboxes:', error.message);
    process.exit(1);
  }

  if (!players || players.length === 0) {
    console.log('No jukeboxes found.');
    return;
  }

  // Format as table
  console.log('='.repeat(145));
  console.log(
    '| ' +
    'Jukebox'.padEnd(25) +
    ' | ' +
    'Created_By'.padEnd(38) +
    ' | ' +
    '# Playlists'.padEnd(11) +
    ' | ' +
    '# Songs'.padEnd(9) +
    ' | ' +
    'Active_Playlist'.padEnd(25) +
    ' | ' +
    'Now_Playing_Video'.padEnd(30) +
    ' |'
  );
  console.log('-'.repeat(145));

  for (const player of players as any[]) {
    const name = (player.display_name || player.name || 'Unnamed').substring(0, 24).padEnd(25);
    const createdBy = (player.owner_id || 'system').substring(0, 37).padEnd(38);
    
    const playlists = player.playlists || [];
    const playlistCount = String(playlists.length).padStart(10).padEnd(11);
    
    // Count total songs across all playlists
    const totalSongs = playlists.reduce((sum: number, p: any) => 
      sum + (p.playlist_items?.length || 0), 0
    );
    const songCount = String(totalSongs).padStart(8).padEnd(9);

    // Find active playlist name
    const activePlaylist = playlists.find((p: any) => p.is_active);
    const activePlaylistName = (activePlaylist?.name || 'None').substring(0, 24).padEnd(25);

    // Get now playing video title
    const nowPlaying = player.player_status?.[0]?.current_media?.title || null;
    const nowPlayingName = (nowPlaying ? nowPlaying.substring(0, 30) : '-').padEnd(30);

    console.log(
      `| ${name} | ${createdBy} | ${playlistCount} | ${songCount} | ${activePlaylistName} | ${nowPlayingName} |`
    );
  }

  console.log('='.repeat(145));
  console.log(`\n📊 Total: ${players.length} jukebox(es)\n`);
}

listJukeboxes().catch(console.error);
