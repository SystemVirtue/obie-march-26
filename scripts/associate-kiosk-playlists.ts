#!/usr/bin/env node
/**
 * Find all playlists with "Kiosk" in name (orphaned or not) with >0 songs
 * and associate them with OBIE player
 * 
 * Usage: npx tsx scripts/associate-kiosk-playlists.ts
 */

import { createClient } from '@supabase/supabase-js';
import { Database } from '../web/shared/database.types';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://fcabzrkcsfjimpxxnvco.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.VITE_SUPABASE_SERVICE_KEY;

if (!SUPABASE_SERVICE_KEY) {
  console.error('Error: VITE_SUPABASE_SERVICE_KEY environment variable required');
  process.exit(1);
}

const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function associateKioskPlaylists() {
  console.log('\n🔧 Associating Kiosk playlists with OBIE...\n');

  // Step 1: Find OBIE player
  console.log('Step 1: Finding OBIE jukebox...');
  const { data: obiePlayer, error: obieError } = await supabase
    .from('players')
    .select('id, name, jukebox_slug')
    .or('name.ilike.%OBIE%,jukebox_slug.ilike.%OBIE%')
    .maybeSingle();

  if (obieError || !obiePlayer) {
    console.error('❌ OBIE jukebox not found');
    process.exit(1);
  }

  const obiePlayerId = (obiePlayer as any).id;
  console.log(`   ✓ Found OBIE: ${obiePlayerId}\n`);

  // Step 2: Find all playlists with "Kiosk" in name that have >0 songs
  console.log('Step 2: Finding Kiosk playlists with songs...');
  
  // Get all playlists with Kiosk in name
  const { data: kioskPlaylists, error: kioskError } = await supabase
    .from('playlists')
    .select(`
      id,
      name,
      player_id,
      player:players!inner (
        id,
        name,
        jukebox_slug
      ),
      playlist_items (
        id
      )
    `)
    .ilike('name', '%Kiosk%')
    .order('name');

  if (kioskError) {
    console.error('❌ Error fetching Kiosk playlists:', kioskError.message);
    process.exit(1);
  }

  // Show all Kiosk playlists first
  const allKioskPlaylists = kioskPlaylists || [];
  
  if (allKioskPlaylists.length === 0) {
    console.log('   No playlists with "Kiosk" in name found.\n');
    return;
  }
  
  console.log(`   Found ${allKioskPlaylists.length} playlists with "Kiosk" in name`);
  
  // Filter to those with >0 songs
  const playlistsWithSongs = allKioskPlaylists.filter((p: any) => 
    (p.playlist_items?.length || 0) > 0
  );
  
  const playlistsWithoutSongs = allKioskPlaylists.filter((p: any) => 
    (p.playlist_items?.length || 0) === 0
  );
  
  if (playlistsWithoutSongs.length > 0) {
    console.log(`   - ${playlistsWithSongs.length} with >0 songs`);
    console.log(`   - ${playlistsWithoutSongs.length} with 0 songs\n`);
  } else {
    console.log(`   All ${playlistsWithSongs.length} have >0 songs\n`);
  }
  
  if (playlistsWithSongs.length === 0) {
    console.log('   No Kiosk playlists with >0 songs to associate.\n');
    return;
  }

  // Display table
  console.log('='.repeat(110));
  console.log(
    '| ' +
    'Playlist Name'.padEnd(28) +
    ' | ' +
    'Playlist_ID'.padEnd(38) +
    ' | ' +
    'Current Player'.padEnd(20) +
    ' | ' +
    'Songs'.padEnd(6) +
    ' |'
  );
  console.log('-'.repeat(110));

  for (const p of playlistsWithSongs as any[]) {
    const name = (p.name || 'Unnamed').substring(0, 27).padEnd(28);
    const id = p.id.substring(0, 37).padEnd(38);
    const currentPlayer = (p.player?.name || p.player?.jukebox_slug || 'Unknown').substring(0, 19).padEnd(20);
    const songs = String(p.playlist_items?.length || 0).padStart(5).padEnd(6);
    
    console.log(`| ${name} | ${id} | ${currentPlayer} | ${songs} |`);
  }

  console.log('='.repeat(110));
  console.log('');

  // Step 3: Filter out those already associated with OBIE
  const toUpdate = playlistsWithSongs.filter((p: any) => p.player_id !== obiePlayerId);
  const alreadyObie = playlistsWithSongs.filter((p: any) => p.player_id === obiePlayerId);

  if (alreadyObie.length > 0) {
    console.log(`   ${alreadyObie.length} playlist(s) already associated with OBIE\n`);
  }

  if (toUpdate.length === 0) {
    console.log('✅ All Kiosk playlists are already associated with OBIE.\n');
    return;
  }

  console.log(`   ${toUpdate.length} playlist(s) need to be associated with OBIE\n`);

  // Step 4: Update playlists to OBIE
  console.log('Step 3: Associating playlists with OBIE...');
  
  let updated = 0;
  let failed = 0;

  for (const playlist of toUpdate) {
    const { error: updateError } = await supabase
      .from('playlists')
      .update({ 
        player_id: obiePlayerId,
        updated_at: new Date().toISOString()
      })
      .eq('id', playlist.id);

    if (updateError) {
      console.error(`   ❌ Failed to update "${playlist.name}":`, updateError.message);
      failed++;
    } else {
      console.log(`   ✓ Associated "${playlist.name}" with OBIE`);
      updated++;
    }
  }

  console.log(`\n✅ Complete!`);
  console.log(`   Updated: ${updated} playlists`);
  console.log(`   Failed: ${failed} playlists`);
  console.log(`   Associated with: OBIE (${obiePlayerId})`);
  console.log('');
}

associateKioskPlaylists().catch(console.error);
