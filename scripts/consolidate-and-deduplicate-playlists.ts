#!/usr/bin/env node
/**
 * TASK ONE: Consolidate all RADIO playlists into single 'ALL PREVIOUS RADIOS' playlist
 * TASK TWO: De-duplicate OBIE playlists by name + video count, keep most recent
 * 
 * Usage: npx tsx scripts/consolidate-and-deduplicate-playlists.ts
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

async function consolidateAndDeduplicate() {
  console.log('\n🔧 Playlist Consolidation & De-duplication\n');

  // ============================================================
  // STEP 0: Find OBIE player
  // ============================================================
  console.log('Step 0: Finding OBIE jukebox...');
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

  // ============================================================
  // TASK ONE: Consolidate RADIO playlists
  // ============================================================
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('TASK ONE: Consolidate RADIO Playlists');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Step 1: Find all RADIO playlists
  console.log('Step 1: Finding all RADIO playlists...');
  const { data: radioPlaylists, error: radioError } = await supabase
    .from('playlists')
    .select(`
      id,
      name,
      player_id,
      created_at,
      playlist_items (
        id,
        media_item_id,
        position
      )
    `)
    .ilike('name', 'RADIO%')
    .order('created_at', { ascending: false });

  if (radioError) {
    console.error('❌ Error fetching RADIO playlists:', radioError.message);
    process.exit(1);
  }

  if (!radioPlaylists || radioPlaylists.length === 0) {
    console.log('   No RADIO playlists found.\n');
  } else {
    console.log(`   Found ${radioPlaylists.length} RADIO playlists`);

    // Count total unique media items across all RADIO playlists
    const allMediaIds = new Set<string>();
    let totalItems = 0;
    for (const playlist of radioPlaylists as any[]) {
      for (const item of playlist.playlist_items || []) {
        allMediaIds.add(item.media_item_id);
        totalItems++;
      }
    }
    console.log(`   Total items: ${totalItems}`);
    console.log(`   Unique media items: ${allMediaIds.size}\n`);

    // Step 2: Create consolidated playlist
    console.log('Step 2: Creating consolidated playlist "ALL PREVIOUS RADIOS"...');
    const { data: newPlaylist, error: createError } = await supabase
      .from('playlists')
      .insert({
        name: 'ALL PREVIOUS RADIOS',
        player_id: obiePlayerId,
        description: `Consolidated from ${radioPlaylists.length} RADIO playlists (${totalItems} items, ${allMediaIds.size} unique)`,
        is_active: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select('id')
      .single();

    if (createError || !newPlaylist) {
      console.error('❌ Error creating consolidated playlist:', createError?.message);
      process.exit(1);
    }

    const newPlaylistId = (newPlaylist as any).id;
    console.log(`   ✓ Created playlist: ${newPlaylistId}\n`);

    // Step 3: Copy all unique media items to new playlist
    console.log('Step 3: Copying unique media items to new playlist...');
    let position = 0;
    let copiedCount = 0;
    const addedMediaIds = new Set<string>();

    for (const playlist of radioPlaylists as any[]) {
      // Sort items by position to maintain order
      const sortedItems = (playlist.playlist_items || []).sort(
        (a: any, b: any) => a.position - b.position
      );

      for (const item of sortedItems) {
        // Skip if already added (deduplication within RADIO playlists)
        if (addedMediaIds.has(item.media_item_id)) {
          continue;
        }
        addedMediaIds.add(item.media_item_id);

        const { error: insertError } = await supabase
          .from('playlist_items')
          .insert({
            playlist_id: newPlaylistId,
            media_item_id: item.media_item_id,
            position: position++,
            added_at: new Date().toISOString()
          });

        if (insertError) {
          console.error(`   ⚠️ Failed to copy item ${item.media_item_id}:`, insertError.message);
        } else {
          copiedCount++;
        }
      }
    }

    console.log(`   ✓ Copied ${copiedCount} unique items\n`);

    // Step 4: Delete all original RADIO playlists
    console.log('Step 4: Deleting original RADIO playlists...');
    let deletedCount = 0;
    let deleteFailed = 0;

    for (const playlist of radioPlaylists as any[]) {
      // First delete all playlist_items
      const { error: deleteItemsError } = await supabase
        .from('playlist_items')
        .delete()
        .eq('playlist_id', playlist.id);

      if (deleteItemsError) {
        console.error(`   ⚠️ Failed to delete items for ${playlist.name}:`, deleteItemsError.message);
        deleteFailed++;
        continue;
      }

      // Then delete the playlist
      const { error: deletePlaylistError } = await supabase
        .from('playlists')
        .delete()
        .eq('id', playlist.id);

      if (deletePlaylistError) {
        console.error(`   ⚠️ Failed to delete playlist ${playlist.name}:`, deletePlaylistError.message);
        deleteFailed++;
      } else {
        deletedCount++;
      }
    }

    console.log(`   ✓ Deleted ${deletedCount} RADIO playlists`);
    if (deleteFailed > 0) {
      console.log(`   ⚠️ Failed to delete ${deleteFailed} playlists`);
    }
    console.log('');
  }

  // ============================================================
  // TASK TWO: De-duplicate OBIE playlists
  // ============================================================
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('TASK TWO: De-duplicate OBIE Playlists');
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log('Step 5: Finding all OBIE playlists...');
  const { data: obiePlaylists, error: obieListError } = await supabase
    .from('playlists')
    .select(`
      id,
      name,
      player_id,
      created_at,
      playlist_items (
        id,
        media_item_id
      )
    `)
    .eq('player_id', obiePlayerId)
    .order('name, created_at', { ascending: false });

  if (obieListError) {
    console.error('❌ Error fetching OBIE playlists:', obieListError.message);
    process.exit(1);
  }

  if (!obiePlaylists || obiePlaylists.length === 0) {
    console.log('   No playlists found for OBIE.\n');
    return;
  }

  console.log(`   Found ${obiePlaylists.length} playlists for OBIE\n`);

  // Group by name and find duplicates
  const byName = new Map<string, any[]>();
  for (const p of obiePlaylists as any[]) {
    if (!byName.has(p.name)) {
      byName.set(p.name, []);
    }
    byName.get(p.name)!.push(p);
  }

  // Find duplicates (same name AND same video count)
  const duplicatesToDelete: any[] = [];
  let uniqueCount = 0;

  for (const [name, playlists] of byName) {
    if (playlists.length === 1) {
      uniqueCount++;
      continue;
    }

    // Group by video count
    const byVideoCount = new Map<number, any[]>();
    for (const p of playlists) {
      const count = p.playlist_items?.length || 0;
      if (!byVideoCount.has(count)) {
        byVideoCount.set(count, []);
      }
      byVideoCount.get(count)!.push(p);
    }

    // For each video count group, keep most recent, delete others
    for (const [count, sameCountPlaylists] of byVideoCount) {
      if (sameCountPlaylists.length === 1) {
        uniqueCount++;
        continue;
      }

      // Sort by created_at descending (most recent first)
      sameCountPlaylists.sort(
        (a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );

      // Keep first (most recent), mark rest for deletion
      console.log(`   Duplicate group: "${name}" with ${count} videos`);
      console.log(`     Keep: ${sameCountPlaylists[0].id} (${sameCountPlaylists[0].created_at})`);
      
      for (let i = 1; i < sameCountPlaylists.length; i++) {
        console.log(`     Delete: ${sameCountPlaylists[i].id} (${sameCountPlaylists[i].created_at})`);
        duplicatesToDelete.push(sameCountPlaylists[i]);
      }
    }
  }

  console.log(`\n   ${uniqueCount} unique playlist names`);
  console.log(`   ${duplicatesToDelete.length} duplicate playlists to delete\n`);

  if (duplicatesToDelete.length === 0) {
    console.log('✅ No duplicates found. All playlists are already unique.\n');
  } else {
    // Delete duplicates
    console.log('Step 6: Deleting duplicate playlists...');
    let deletedCount = 0;
    let deleteFailed = 0;

    for (const playlist of duplicatesToDelete) {
      // First delete all playlist_items
      const { error: deleteItemsError } = await supabase
        .from('playlist_items')
        .delete()
        .eq('playlist_id', playlist.id);

      if (deleteItemsError) {
        console.error(`   ⚠️ Failed to delete items for "${playlist.name}":`, deleteItemsError.message);
        deleteFailed++;
        continue;
      }

      // Then delete the playlist
      const { error: deletePlaylistError } = await supabase
        .from('playlists')
        .delete()
        .eq('id', playlist.id);

      if (deletePlaylistError) {
        console.error(`   ⚠️ Failed to delete playlist "${playlist.name}":`, deletePlaylistError.message);
        deleteFailed++;
      } else {
        deletedCount++;
      }
    }

    console.log(`   ✓ Deleted ${deletedCount} duplicate playlists`);
    if (deleteFailed > 0) {
      console.log(`   ⚠️ Failed to delete ${deleteFailed} duplicates`);
    }
    console.log('');
  }

  // ============================================================
  // SUMMARY
  // ============================================================
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('FINAL SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Get final count
  const { data: finalPlaylists, error: finalError } = await supabase
    .from('playlists')
    .select('id, name', { count: 'exact' })
    .eq('player_id', obiePlayerId);

  if (!finalError && finalPlaylists) {
    console.log(`📊 OBIE now has ${finalPlaylists.length} playlists`);
    
    // Count unique names
    const uniqueNames = new Set(finalPlaylists.map((p: any) => p.name));
    console.log(`📊 ${uniqueNames.size} unique playlist names`);
    
    if (uniqueNames.size === finalPlaylists.length) {
      console.log('✅ No duplicates remain!');
    } else {
      console.log(`⚠️ ${finalPlaylists.length - uniqueNames.size} duplicate name(s) still exist`);
    }
  }

  console.log('\n✅ Consolidation and de-duplication complete!\n');
}

consolidateAndDeduplicate().catch(console.error);
