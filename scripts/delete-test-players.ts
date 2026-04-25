#!/usr/bin/env node
/**
 * Delete any JUKEBOX with "PLAYER" or "TEST" in the name
 * 
 * Usage: npx tsx scripts/delete-test-players.ts [--execute]
 * 
 * Without --execute: Preview only (dry run)
 * With --execute: Actually delete the players
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

const EXECUTE = process.argv.includes('--execute');

async function deleteTestPlayers() {
  console.log('\n🔧 Finding JUKEBOXES with "PLAYER" or "TEST" in name...\n');

  if (!EXECUTE) {
    console.log('⚠️  DRY RUN MODE - No deletions will occur');
    console.log('   Add --execute flag to actually delete\n');
  }

  // Step 1: Find players with PLAYER or TEST in name
  console.log('Step 1: Searching for matching jukeboxes...');
  
  const { data: players, error: playersError } = await supabase
    .from('players')
    .select('id, name, jukebox_slug, owner_id, created_at, status')
    .or('name.ilike.%PLAYER%,name.ilike.%TEST%,jukebox_slug.ilike.%PLAYER%,jukebox_slug.ilike.%TEST%')
    .order('name');

  if (playersError) {
    console.error('❌ Error fetching players:', playersError.message);
    process.exit(1);
  }

  if (!players || players.length === 0) {
    console.log('   No jukeboxes found with "PLAYER" or "TEST" in name.\n');
    return;
  }

  console.log(`   Found ${players.length} jukebox(es)`);
  
  // Step 1b: Fetch related counts for each player
  console.log('Step 1b: Fetching related data counts...');
  
  const playerIds = players.map((p: any) => p.id);
  
  // Get playlist counts
  const { data: playlists } = await supabase
    .from('playlists')
    .select('id, player_id')
    .in('player_id', playerIds);
  
  const playlistMap = new Map();
  for (const p of playlists || []) {
    playlistMap.set(p.id, p.player_id);
  }
  
  // Get playlist items for these playlists
  const playlistIds = playlists?.map((p: any) => p.id) || [];
  const { data: playlistItems } = await supabase
    .from('playlist_items')
    .select('id, playlist_id')
    .in('playlist_id', playlistIds);
  
  // Get queue counts
  const { data: queueItems } = await supabase
    .from('queue')
    .select('id, player_id')
    .in('player_id', playerIds);
  
  // Get membership counts
  const { data: memberships } = await supabase
    .from('player_memberships')
    .select('id, player_id')
    .in('player_id', playerIds);
  
  console.log('');

  // Calculate totals per player
  const playerData = (players as any[]).map(p => {
    const playerPlaylists = playlists?.filter((pl: any) => pl.player_id === p.id) || [];
    const playerPlaylistIds = playerPlaylists.map((pl: any) => pl.id);
    const playerPlaylistItems = playlistItems?.filter((pi: any) => playerPlaylistIds.includes(pi.playlist_id)) || [];
    const playerQueue = queueItems?.filter((q: any) => q.player_id === p.id) || [];
    const playerMembers = memberships?.filter((m: any) => m.player_id === p.id) || [];
    
    return {
      ...p,
      playlistCount: playerPlaylists.length,
      playlistItemCount: playerPlaylistItems.length,
      queueCount: playerQueue.length,
      membershipCount: playerMembers.length
    };
  });

  // Display table
  console.log('='.repeat(120));
  console.log(
    '| ' +
    'Name'.padEnd(25) +
    ' | ' +
    'Slug'.padEnd(20) +
    ' | ' +
    'Status'.padEnd(10) +
    ' | ' +
    'Playlists'.padEnd(10) +
    ' | ' +
    'Queue'.padEnd(8) +
    ' | ' +
    'Members'.padEnd(8) +
    ' |'
  );
  console.log('-'.repeat(120));

  for (const p of playerData) {
    const name = (p.name || 'Unnamed').substring(0, 24).padEnd(25);
    const slug = (p.jukebox_slug || 'N/A').substring(0, 19).padEnd(20);
    const status = (p.status || 'N/A').padEnd(10);
    const playlists = String(p.playlistCount).padEnd(10);
    const queue = String(p.queueCount).padEnd(8);
    const members = String(p.membershipCount).padEnd(8);
    
    console.log(`| ${name} | ${slug} | ${status} | ${playlists} | ${queue} | ${members} |`);
  }

  console.log('='.repeat(120));
  console.log('');

  // Calculate totals
  let totalPlaylists = 0;
  let totalPlaylistItems = 0;
  let totalQueueItems = 0;
  let totalMemberships = 0;

  for (const p of playerData) {
    totalPlaylists += p.playlistCount;
    totalPlaylistItems += p.playlistItemCount;
    totalQueueItems += p.queueCount;
    totalMemberships += p.membershipCount;
  }

  console.log('Impact Summary:');
  console.log(`   Jukeboxes to delete: ${players.length}`);
  console.log(`   Playlists to cascade: ${totalPlaylists}`);
  console.log(`   Playlist items to cascade: ${totalPlaylistItems}`);
  console.log(`   Queue items to cascade: ${totalQueueItems}`);
  console.log(`   Memberships to cascade: ${totalMemberships}`);
  console.log('');

  if (!EXECUTE) {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('DRY RUN COMPLETE - No changes made');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('');
    console.log('To actually delete these jukeboxes, run:');
    console.log(`   npx tsx scripts/delete-test-players.ts --execute`);
    console.log('');
    return;
  }

  // EXECUTE DELETION
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('EXECUTING DELETIONS');
  console.log('═══════════════════════════════════════════════════════════════\n');

  let deletedPlayers = 0;
  let failedDeletions = 0;

  for (const player of playerData) {
    const playerName = player.name || player.jukebox_slug || 'Unnamed';
    console.log(`Deleting: ${playerName} (${player.id})`);

    // The player record deletion should cascade to:
    // - player_memberships (foreign key)
    // - player_status (foreign key)
    // - queue (foreign key)
    // - kiosk_sessions (foreign key)
    // - playlists (foreign key, which cascades to playlist_items)

    const { error: deleteError } = await supabase
      .from('players')
      .delete()
      .eq('id', player.id);

    if (deleteError) {
      console.error(`   ❌ Failed to delete:`, deleteError.message);
      failedDeletions++;
    } else {
      console.log(`   ✓ Deleted successfully`);
      deletedPlayers++;
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('DELETION COMPLETE');
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log(`✅ Deleted: ${deletedPlayers} jukebox(es)`);
  if (failedDeletions > 0) {
    console.log(`❌ Failed: ${failedDeletions} jukebox(es)`);
  }

  // Verify deletion
  const { data: remaining, count } = await supabase
    .from('players')
    .select('*', { count: 'exact' })
    .or('name.ilike.%PLAYER%,name.ilike.%TEST%,jukebox_slug.ilike.%PLAYER%,jukebox_slug.ilike.%TEST%');

  console.log(`\nVerification: ${count || 0} matching jukeboxes remaining\n`);
}

deleteTestPlayers().catch(console.error);
