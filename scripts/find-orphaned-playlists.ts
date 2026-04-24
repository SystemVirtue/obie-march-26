#!/usr/bin/env node
/**
 * Find orphaned playlists (no valid owner/admin)
 * Usage: npx tsx scripts/find-orphaned-playlists.ts
 */

import { createClient } from '@supabase/supabase-js';
import { Database } from '../web/shared/database.types';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://fcabzrkcsfjimpxxnvco.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.VITE_SUPABASE_SERVICE_KEY;

if (!SUPABASE_SERVICE_KEY) {
  console.error('Error: VITE_SUPABASE_SERVICE_KEY environment variable required');
  console.error('Run with: VITE_SUPABASE_SERVICE_KEY=your_key npx tsx scripts/find-orphaned-playlists.ts');
  process.exit(1);
}

const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function findOrphanedPlaylists() {
  console.log('\n🔍 Checking for orphaned playlists...\n');

  // Get all playlists with their player info and memberships
  const { data: playlists, error } = await supabase
    .from('playlists')
    .select(`
      id,
      name,
      player_id,
      created_at,
      players!inner (
        id,
        name,
        owner_id,
        jukebox_slug,
        created_at,
        player_memberships (
          user_id,
          role
        )
      ),
      playlist_items (
        id
      )
    `)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching playlists:', error.message);
    process.exit(1);
  }

  if (!playlists || playlists.length === 0) {
    console.log('No playlists found.');
    return;
  }

  // Filter for orphaned playlists
  const orphaned = (playlists as any[]).filter((p: any) => {
    const player = p.players?.[0];
    const memberships = player?.player_memberships || [];
    const hasAdminOrOwner = memberships.some((m: any) => 
      m.role === 'admin' || m.role === 'owner'
    );
    
    // Orphaned if: no player, or no owner_id AND no admin/owner memberships
    return !player || (!player.owner_id && !hasAdminOrOwner);
  });

  if (orphaned.length === 0) {
    console.log('✅ No orphaned playlists found. All playlists have valid owners.');
    console.log(`\n📊 Total playlists checked: ${playlists.length}\n`);
    return;
  }

  // Display orphaned playlists
  console.log('='.repeat(130));
  console.log(
    '| ' +
    'Playlist'.padEnd(28) +
    ' | ' +
    'Playlist_ID'.padEnd(38) +
    ' | ' +
    'Jukebox'.padEnd(20) +
    ' | ' +
    'Owner_ID'.padEnd(38) +
    ' |'
  );
  console.log('-'.repeat(130));

  for (const p of orphaned) {
    const player = p.players?.[0];
    const playlistName = (p.name || 'Unnamed').substring(0, 27).padEnd(28);
    const playlistId = p.id.substring(0, 37).padEnd(38);
    const jukeboxName = (player?.jukebox_slug || 'NO PLAYER').substring(0, 19).padEnd(20);
    const ownerId = (player?.owner_id || 'NO OWNER').substring(0, 37).padEnd(38);

    console.log(`| ${playlistName} | ${playlistId} | ${jukeboxName} | ${ownerId} |`);
  }

  console.log('='.repeat(130));
  console.log(`\n⚠️  Found ${orphaned.length} orphaned playlist(s) out of ${playlists.length} total\n`);

  // Summary by orphan type
  const noPlayer = orphaned.filter((p: any) => !p.players?.[0]).length;
  const noOwnerNoAdmin = orphaned.filter((p: any) => {
    const player = p.players?.[0];
    const memberships = player?.player_memberships || [];
    return player && !player.owner_id && !memberships.some((m: any) => m.role === 'admin' || m.role === 'owner');
  }).length;

  console.log('Breakdown:');
  console.log(`  - Missing player reference: ${noPlayer}`);
  console.log(`  - Player exists but no owner/admin: ${noOwnerNoAdmin}`);
  console.log('');
}

findOrphanedPlaylists().catch(console.error);
