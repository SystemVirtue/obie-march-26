#!/usr/bin/env node
/**
 * Associate ALL orphaned playlists with admin@djamms.app and OBIE jukebox
 * Usage: npx tsx scripts/associate-orphaned-playlists.ts
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

async function associateOrphanedPlaylists() {
  console.log('\n🔧 Associating orphaned playlists with admin@djamms.app and OBIE jukebox...\n');

  // 1. Find OBIE jukebox (player) and its owner first
  console.log('Step 1: Finding OBIE jukebox...');
  const { data: obiePlayer, error: playerError } = await supabase
    .from('players')
    .select('id, name, jukebox_slug, owner_id')
    .or('name.ilike.%OBIE%,jukebox_slug.ilike.%OBIE%')
    .maybeSingle();

  if (playerError) {
    console.error('Error finding OBIE player:', playerError.message);
    process.exit(1);
  }

  let obiePlayerId: string;
  let adminUserId: string;
  
  if (obiePlayer) {
    obiePlayerId = (obiePlayer as any).id;
    console.log(`   ✓ Found OBIE jukebox: ${obiePlayerId}`);
    console.log(`     Name: ${(obiePlayer as any).name}`);
    console.log(`     Slug: ${(obiePlayer as any).jukebox_slug}`);
    
    // Get existing owner from memberships
    const { data: obieMembership } = await supabase
      .from('player_memberships')
      .select('user_id, role')
      .eq('player_id', obiePlayerId)
      .eq('role', 'owner')
      .maybeSingle();
    
    if (obieMembership) {
      adminUserId = (obieMembership as any).user_id;
      console.log(`   ✓ Found OBIE owner: ${adminUserId}`);
    } else {
      console.error('❌ OBIE has no owner membership');
      process.exit(1);
    }
  } else {
    console.error('❌ OBIE jukebox not found');
    process.exit(1);
  }

  // Update OBIE player owner_id if not set
  if (!(obiePlayer as any).owner_id) {
    console.log('\nStep 2: Updating OBIE player owner_id...');
    const { error: updateOwnerError } = await supabase
      .from('players')
      .update({ owner_id: adminUserId, updated_at: new Date().toISOString() })
      .eq('id', obiePlayerId);

    if (updateOwnerError) {
      console.error('Error updating owner:', updateOwnerError.message);
    } else {
      console.log('   ✓ Updated OBIE player owner_id');
    }
  } else {
    console.log('\nStep 2: OBIE already has owner_id set');
  }

  // 3. Find all orphaned playlists
  console.log('\nStep 3: Finding orphaned playlists...');
  
  // Get all playlists
  const { data: playlists, error: playlistsError } = await supabase
    .from('playlists')
    .select('id, name, player_id');

  if (playlistsError) {
    console.error('Error fetching playlists:', playlistsError.message);
    process.exit(1);
  }

  // Get all players with memberships for orphan check
  const { data: players, error: playersError } = await supabase
    .from('players')
    .select(`
      id,
      owner_id,
      player_memberships (role)
    `);

  if (playersError) {
    console.error('Error fetching players:', playersError.message);
    process.exit(1);
  }

  // Create player lookup
  const playerMap = new Map();
  for (const p of players || []) {
    const memberships = (p as any).player_memberships || [];
    const hasAdminOrOwner = memberships.some((m: any) => 
      m.role === 'admin' || m.role === 'owner'
    );
    playerMap.set(p.id, {
      owner_id: p.owner_id,
      hasAdminOrOwner
    });
  }

  // Filter orphaned
  const orphaned: any[] = [];
  for (const p of playlists || []) {
    const player = playerMap.get(p.player_id);
    const isOrphaned = !player || (!player.owner_id && !player.hasAdminOrOwner);
    if (isOrphaned) {
      orphaned.push(p);
    }
  }

  console.log(`   Found ${orphaned.length} orphaned playlists`);

  if (orphaned.length === 0) {
    console.log('   No orphaned playlists to update.');
    return;
  }

  // 4. Update all orphaned playlists to OBIE player
  console.log(`\nStep 4: Updating ${orphaned.length} orphaned playlists to OBIE...`);
  
  let updated = 0;
  let failed = 0;

  for (const playlist of orphaned) {
    const { error: updateError } = await supabase
      .from('playlists')
      .update({ 
        player_id: obiePlayerId,
        updated_at: new Date().toISOString()
      })
      .eq('id', playlist.id);

    if (updateError) {
      console.error(`   ❌ Failed to update ${playlist.name}:`, updateError.message);
      failed++;
    } else {
      updated++;
    }
  }

  console.log(`\n✅ Complete!`);
  console.log(`   Updated: ${updated} playlists`);
  console.log(`   Failed: ${failed} playlists`);
  console.log(`   Associated with: OBIE (${obiePlayerId})`);
  console.log(`   Owner set to: admin@djamms.app (${adminUserId})`);
  console.log('');
}

associateOrphanedPlaylists().catch(console.error);
