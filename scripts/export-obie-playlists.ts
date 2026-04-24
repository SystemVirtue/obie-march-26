#!/usr/bin/env node
/**
 * Create an archive export of all current playlist data for OBIE player
 * Exports to JSON file with full playlist and media metadata
 * 
 * Usage: npx tsx scripts/export-obie-playlists.ts
 */

import { createClient } from '@supabase/supabase-js';
import { Database } from '../web/shared/database.types';
import * as fs from 'fs';
import * as path from 'path';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://fcabzrkcsfjimpxxnvco.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.VITE_SUPABASE_SERVICE_KEY;

if (!SUPABASE_SERVICE_KEY) {
  console.error('Error: VITE_SUPABASE_SERVICE_KEY environment variable required');
  process.exit(1);
}

const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function exportObiePlaylists() {
  console.log('\n📦 Creating archive export of OBIE playlists...\n');

  // Step 1: Find OBIE player
  console.log('Step 1: Finding OBIE jukebox...');
  const { data: obiePlayer, error: obieError } = await supabase
    .from('players')
    .select('id, name, jukebox_slug, owner_id, created_at, updated_at')
    .or('name.ilike.%OBIE%,jukebox_slug.ilike.%OBIE%')
    .maybeSingle();

  if (obieError || !obiePlayer) {
    console.error('❌ OBIE jukebox not found');
    process.exit(1);
  }

  const obiePlayerId = (obiePlayer as any).id;
  console.log(`   ✓ Found OBIE: ${obiePlayerId}\n`);

  // Step 2: Fetch all playlists for OBIE
  console.log('Step 2: Fetching all OBIE playlists...');
  const { data: playlists, error: playlistError } = await supabase
    .from('playlists')
    .select('id, name, description, is_active, created_at, updated_at')
    .eq('player_id', obiePlayerId)
    .order('name');

  if (playlistError) {
    console.error('❌ Error fetching playlists:', playlistError.message);
    process.exit(1);
  }

  if (!playlists || playlists.length === 0) {
    console.log('   No playlists found for OBIE.\n');
    return;
  }

  console.log(`   Found ${playlists.length} playlist(s)`);
  
  // Step 2b: Fetch all playlist items and media items separately
  console.log('Step 2b: Fetching playlist items and media data...');
  
  const playlistIds = playlists.map((p: any) => p.id);
  
  // Get all playlist items for these playlists
  const { data: allPlaylistItems, error: itemsError } = await supabase
    .from('playlist_items')
    .select('id, playlist_id, media_item_id, position, added_at')
    .in('playlist_id', playlistIds);
  
  if (itemsError) {
    console.error('❌ Error fetching playlist items:', itemsError.message);
    process.exit(1);
  }
  
  // Get all media items referenced (in batches to avoid query limits)
  const mediaItemIds = [...new Set((allPlaylistItems || []).map((item: any) => item.media_item_id))];
  console.log(`   Unique media items to fetch: ${mediaItemIds.length}`);
  
  const allMediaItems: any[] = [];
  const batchSize = 100;
  
  for (let i = 0; i < mediaItemIds.length; i += batchSize) {
    const batch = mediaItemIds.slice(i, i + batchSize);
    const { data: batchMedia, error: mediaError } = await supabase
      .from('media_items')
      .select('id, title, artist, source_type, source_id, duration, thumbnail, url, metadata')
      .in('id', batch);
    
    if (mediaError) {
      console.error(`❌ Error fetching media items batch ${i / batchSize + 1}:`, mediaError.message);
      process.exit(1);
    }
    
    allMediaItems.push(...(batchMedia || []));
  }
  
  // Create lookup maps
  const mediaItemMap = new Map(allMediaItems.map((m: any) => [m.id, m]));
  const playlistItemsMap = new Map();
  
  for (const item of allPlaylistItems || []) {
    if (!playlistItemsMap.has(item.playlist_id)) {
      playlistItemsMap.set(item.playlist_id, []);
    }
    playlistItemsMap.get(item.playlist_id).push({
      ...item,
      media_item: mediaItemMap.get(item.media_item_id) || null
    });
  }
  
  // Attach items to playlists
  for (const playlist of playlists as any[]) {
    playlist.playlist_items = playlistItemsMap.get(playlist.id) || [];
  }
  
  console.log(`   Fetched ${allPlaylistItems?.length || 0} playlist items`);
  console.log(`   Fetched ${allMediaItems?.length || 0} unique media items\n`);

  // Step 3: Build export object
  console.log('Step 3: Building export data...');
  
  const exportData: any = {
    export_metadata: {
      exported_at: new Date().toISOString(),
      player_id: obiePlayerId,
      player_name: (obiePlayer as any).name,
      player_slug: (obiePlayer as any).jukebox_slug,
      total_playlists: playlists.length,
      export_version: '1.0',
      total_items: 0,
      unique_media_items: 0,
      total_duration_seconds: 0
    },
    player: {
      id: obiePlayerId,
      name: (obiePlayer as any).name,
      jukebox_slug: (obiePlayer as any).jukebox_slug,
      owner_id: (obiePlayer as any).owner_id,
      created_at: (obiePlayer as any).created_at,
      updated_at: (obiePlayer as any).updated_at
    },
    playlists: playlists.map((playlist: any) => ({
      id: playlist.id,
      name: playlist.name,
      description: playlist.description,
      is_active: playlist.is_active,
      created_at: playlist.created_at,
      updated_at: playlist.updated_at,
      total_items: playlist.playlist_items?.length || 0,
      items: (playlist.playlist_items || []).map((item: any) => ({
        playlist_item_id: item.id,
        position: item.position,
        added_at: item.added_at,
        media: item.media_item ? {
          id: item.media_item.id,
          title: item.media_item.title,
          artist: item.media_item.artist,
          source_type: item.media_item.source_type,
          source_id: item.media_item.source_id,
          duration: item.media_item.duration,
          thumbnail: item.media_item.thumbnail,
          url: item.media_item.url,
          metadata: item.media_item.metadata
        } : null
      }))
    }))
  };

  // Calculate totals
  let totalItems = 0;
  let totalDuration = 0;
  const uniqueMediaIds = new Set<string>();
  
  for (const playlist of exportData.playlists) {
    totalItems += playlist.items.length;
    for (const item of playlist.items) {
      if (item.media) {
        uniqueMediaIds.add(item.media.id);
        totalDuration += item.media.duration || 0;
      }
    }
  }

  // Update metadata with calculated values
  exportData.export_metadata.total_items = totalItems;
  exportData.export_metadata.unique_media_items = uniqueMediaIds.size;
  exportData.export_metadata.total_duration_seconds = totalDuration;

  console.log(`   Total playlists: ${playlists.length}`);
  console.log(`   Total items: ${totalItems}`);
  console.log(`   Unique media: ${uniqueMediaIds.size}`);
  console.log(`   Total duration: ${Math.round(totalDuration / 60)} minutes\n`);

  // Step 4: Write to file
  console.log('Step 4: Writing export file...');
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `obie-playlists-export-${timestamp}.json`;
  const filepath = path.join(process.cwd(), 'exports', filename);
  
  // Ensure exports directory exists
  const exportsDir = path.join(process.cwd(), 'exports');
  if (!fs.existsSync(exportsDir)) {
    fs.mkdirSync(exportsDir, { recursive: true });
  }
  
  fs.writeFileSync(filepath, JSON.stringify(exportData, null, 2));
  
  console.log(`   ✓ Export saved to: ${filepath}`);
  console.log(`   File size: ${(fs.statSync(filepath).size / 1024 / 1024).toFixed(2)} MB\n`);

  // Step 5: Summary
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('EXPORT COMPLETE');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  console.log('📦 Archive Details:');
  console.log(`   File: exports/${filename}`);
  console.log(`   Player: OBIE (${obiePlayerId})`);
  console.log(`   Playlists: ${playlists.length}`);
  console.log(`   Total items: ${totalItems}`);
  console.log(`   Unique songs: ${uniqueMediaIds.size}`);
  console.log(`   Total duration: ${Math.round(totalDuration / 60)} minutes (${Math.round(totalDuration / 3600 * 10) / 10} hours)`);
  console.log('');

  // Display playlist summary
  console.log('📋 Playlists in export:');
  console.log('   ' + '-'.repeat(70));
  console.log(
    '   ' + 'Playlist Name'.padEnd(30) + 
    ' | ' + 'Items'.padEnd(6) + 
    ' | ' + 'Active'.padEnd(7) +
    ' | ' + 'Created'.padEnd(20)
  );
  console.log('   ' + '-'.repeat(70));
  
  for (const playlist of exportData.playlists) {
    const name = playlist.name.substring(0, 29).padEnd(30);
    const items = String(playlist.total_items).padEnd(6);
    const active = (playlist.is_active ? 'Yes' : 'No').padEnd(7);
    const created = (playlist.created_at || 'N/A').substring(0, 19).padEnd(20);
    console.log(`   ${name} | ${items} | ${active} | ${created}`);
  }
  console.log('   ' + '-'.repeat(70));
  console.log('');
}

exportObiePlaylists().catch(console.error);
