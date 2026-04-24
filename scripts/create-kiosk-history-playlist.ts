#!/usr/bin/env node
/**
 * Create "Previous Kiosk Requests" playlist from all kiosk request history
 * 
 * Usage: npx tsx scripts/create-kiosk-history-playlist.ts
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

async function createKioskHistoryPlaylist() {
  console.log('\n🔧 Creating "Previous Kiosk Requests" playlist...\n');

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

  // Step 2: Find all kiosk requests from queue table
  console.log('Step 2: Finding kiosk request history...');
  
  // Get all queue items with kiosk requests (requested_by is not null)
  const { data: kioskRequests, error: queueError } = await supabase
    .from('queue')
    .select(`
      id,
      media_item_id,
      requested_at,
      requested_by,
      player_id,
      media_item:media_items (
        id,
        title,
        artist,
        source_type,
        source_id,
        duration,
        thumbnail,
        url
      )
    `)
    .not('requested_by', 'is', null)
    .order('requested_at', { ascending: false });

  if (queueError) {
    console.error('❌ Error fetching queue:', queueError.message);
    process.exit(1);
  }

  if (!kioskRequests || kioskRequests.length === 0) {
    console.log('   No kiosk requests found in queue table.\n');
    return;
  }

  console.log(`   Found ${kioskRequests.length} kiosk request(s)\n`);

  // Step 3: Extract unique media items (most recent request per media)
  console.log('Step 3: Extracting unique media items...');
  
  const uniqueMedia = new Map<string, any>();
  const requestStats = {
    totalRequests: kioskRequests.length,
    uniqueSongs: 0,
    bySource: {} as Record<string, number>
  };

  for (const request of kioskRequests as any[]) {
    const mediaId = request.media_item_id;
    const media = request.media_item;
    
    if (!media) continue;
    
    // Only add if not already in map (we're iterating newest first, so first = most recent)
    if (!uniqueMedia.has(mediaId)) {
      uniqueMedia.set(mediaId, {
        ...media,
        requested_at: request.requested_at,
        requested_by: request.requested_by
      });
      
      // Track source type stats
      const sourceType = media.source_type || 'unknown';
      requestStats.bySource[sourceType] = (requestStats.bySource[sourceType] || 0) + 1;
    }
  }

  requestStats.uniqueSongs = uniqueMedia.size;
  
  console.log(`   Total requests: ${requestStats.totalRequests}`);
  console.log(`   Unique songs: ${requestStats.uniqueSongs}`);
  console.log(`   By source:`, requestStats.bySource);
  console.log('');

  if (uniqueMedia.size === 0) {
    console.log('   No valid media items found.\n');
    return;
  }

  // Step 4: Check if playlist already exists
  console.log('Step 4: Checking for existing "Previous Kiosk Requests" playlist...');
  const { data: existingPlaylist, error: checkError } = await supabase
    .from('playlists')
    .select('id')
    .eq('player_id', obiePlayerId)
    .ilike('name', 'Previous Kiosk Requests')
    .maybeSingle();

  let playlistId: string;

  if (existingPlaylist) {
    playlistId = (existingPlaylist as any).id;
    console.log(`   Playlist already exists: ${playlistId}`);
    console.log('   Will add new items to existing playlist\n');
    
    // Get existing items to avoid duplicates
    const { data: existingItems } = await supabase
      .from('playlist_items')
      .select('media_item_id')
      .eq('playlist_id', playlistId);
    
    const existingMediaIds = new Set(existingItems?.map(i => i.media_item_id) || []);
    
    // Filter out already-added media
    for (const mediaId of existingMediaIds) {
      uniqueMedia.delete(mediaId);
    }
    
    console.log(`   ${uniqueMedia.size} new items to add\n`);
  } else {
    // Step 5: Create new playlist
    console.log('Step 5: Creating new playlist...');
    
    const { data: newPlaylist, error: createError } = await supabase
      .from('playlists')
      .insert({
        name: 'Previous Kiosk Requests',
        player_id: obiePlayerId,
        description: `Auto-generated from ${requestStats.totalRequests} kiosk requests (${requestStats.uniqueSongs} unique songs)`,
        is_active: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select('id')
      .single();

    if (createError || !newPlaylist) {
      console.error('❌ Error creating playlist:', createError?.message);
      process.exit(1);
    }

    playlistId = (newPlaylist as any).id;
    console.log(`   ✓ Created playlist: ${playlistId}\n`);
  }

  if (uniqueMedia.size === 0) {
    console.log('   All kiosk songs already in playlist. No new items to add.\n');
    return;
  }

  // Step 6: Add media items to playlist
  console.log(`Step 6: Adding ${uniqueMedia.size} media items to playlist...`);
  
  let addedCount = 0;
  let failedCount = 0;
  let position = 0;

  // Convert map to array and sort by most recent request
  const mediaArray = Array.from(uniqueMedia.values()).sort(
    (a, b) => new Date(b.requested_at).getTime() - new Date(a.requested_at).getTime()
  );

  for (const media of mediaArray) {
    const { error: insertError } = await supabase
      .from('playlist_items')
      .insert({
        playlist_id: playlistId,
        media_item_id: media.id,
        position: position++,
        added_at: new Date().toISOString()
      });

    if (insertError) {
      console.error(`   ❌ Failed to add "${media.title}":`, insertError.message);
      failedCount++;
    } else {
      console.log(`   ✓ Added: ${media.title} (${media.artist || 'Unknown'}) [${media.source_type}]`);
      addedCount++;
    }
  }

  // Step 7: Summary
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('COMPLETED: Previous Kiosk Requests Playlist');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  console.log(`✅ Playlist: "Previous Kiosk Requests"`);
  console.log(`   ID: ${playlistId}`);
  console.log(`   Associated with: OBIE`);
  console.log(`   Total kiosk requests: ${requestStats.totalRequests}`);
  console.log(`   Unique songs: ${requestStats.uniqueSongs}`);
  console.log(`   Added to playlist: ${addedCount}`);
  if (failedCount > 0) {
    console.log(`   Failed: ${failedCount}`);
  }
  console.log(`\n   Source breakdown:`);
  for (const [source, count] of Object.entries(requestStats.bySource)) {
    console.log(`     - ${source}: ${count}`);
  }
  console.log('');
}

createKioskHistoryPlaylist().catch(console.error);
