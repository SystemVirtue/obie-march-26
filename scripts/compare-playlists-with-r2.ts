#!/usr/bin/env node
/**
 * Compare OBIE playlists export with R2 files export
 * Identify which playlist videos exist in R2 and which don't
 * 
 * Usage: npx tsx scripts/compare-playlists-with-r2.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const PLAYLISTS_EXPORT_PATH = path.join(process.cwd(), 'exports', 'obie-playlists-export-2026-04-24T23-59-02-341Z.json');
const R2_EXPORT_PATH = path.join(process.cwd(), 'exports', 'r2-files-export-2026-04-25T04-04-39-184Z.json');

async function comparePlaylistsWithR2() {
  console.log('\n🔍 Comparing OBIE playlists with R2 bucket files...\n');

  // Step 1: Read playlists export
  console.log('Step 1: Reading playlists export...');
  if (!fs.existsSync(PLAYLISTS_EXPORT_PATH)) {
    console.error(`❌ Playlists export not found: ${PLAYLISTS_EXPORT_PATH}`);
    process.exit(1);
  }

  const playlistsData = JSON.parse(fs.readFileSync(PLAYLISTS_EXPORT_PATH, 'utf-8'));
  console.log(`   ✓ Loaded ${playlistsData.playlists?.length || 0} playlists`);

  // Extract all media items from playlists
  const playlistMediaItems = new Map<string, any>();
  const mediaByPlaylist = new Map<string, any[]>();

  for (const playlist of playlistsData.playlists || []) {
    const playlistMedia: any[] = [];
    
    for (const item of playlist.items || []) {
      if (item.media) {
        const media = item.media;
        playlistMedia.push(media);
        
        // Store unique media by ID
        if (!playlistMediaItems.has(media.id)) {
          playlistMediaItems.set(media.id, {
            ...media,
            playlists: []
          });
        }
        
        // Track which playlists contain this media
        const entry = playlistMediaItems.get(media.id);
        if (!entry.playlists.includes(playlist.name)) {
          entry.playlists.push(playlist.name);
        }
      }
    }
    
    mediaByPlaylist.set(playlist.name, playlistMedia);
  }

  console.log(`   ✓ Extracted ${playlistMediaItems.size} unique media items\n`);

  // Step 2: Read R2 export
  console.log('Step 2: Reading R2 files export...');
  if (!fs.existsSync(R2_EXPORT_PATH)) {
    console.error(`❌ R2 export not found: ${R2_EXPORT_PATH}`);
    process.exit(1);
  }

  const r2Data = JSON.parse(fs.readFileSync(R2_EXPORT_PATH, 'utf-8'));
  console.log(`   ✓ Loaded ${r2Data.files?.length || 0} R2 files\n`);

  // Build lookup sets for R2 files
  const r2PublicUrls = new Set<string>();
  const r2ObjectKeys = new Set<string>();
  const r2FileNames = new Set<string>();

  for (const file of r2Data.files || []) {
    if (file.public_url) r2PublicUrls.add(file.public_url);
    if (file.object_key) r2ObjectKeys.add(file.object_key);
    if (file.file_name) r2FileNames.add(file.file_name);
  }

  // Step 3: Compare
  console.log('Step 3: Comparing playlist media with R2 files...');
  
  let foundInR2 = 0;
  let notInR2 = 0;
  const matchDetails: any[] = [];
  const missingDetails: any[] = [];

  for (const [mediaId, media] of playlistMediaItems) {
    const url = media.url || '';
    const sourceId = media.source_id || '';
    const title = media.title || '';
    
    // Check if this media exists in R2
    // Match by: public URL, source_id in object_key, or filename
    let found = false;
    let matchType = '';
    let matchedFile: any = null;

    // Check 1: Direct URL match
    if (r2PublicUrls.has(url)) {
      found = true;
      matchType = 'URL match';
      matchedFile = r2Data.files.find((f: any) => f.public_url === url);
    }
    
    // Check 2: Source ID in object_key (for R2 sources)
    if (!found && sourceId) {
      for (const file of r2Data.files || []) {
        if (file.object_key?.includes(sourceId)) {
          found = true;
          matchType = 'Source ID in object_key';
          matchedFile = file;
          break;
        }
      }
    }
    
    // Check 3: Source ID in filename
    if (!found && sourceId) {
      for (const file of r2Data.files || []) {
        if (file.file_name?.includes(sourceId)) {
          found = true;
          matchType = 'Source ID in filename';
          matchedFile = file;
          break;
        }
      }
    }

    if (found) {
      foundInR2++;
      matchDetails.push({
        media_id: mediaId,
        title: title,
        artist: media.artist,
        source_type: media.source_type,
        match_type: matchType,
        r2_directory: matchedFile?.directory,
        r2_object_key: matchedFile?.object_key
      });
    } else {
      notInR2++;
      missingDetails.push({
        media_id: mediaId,
        title: title,
        artist: media.artist,
        source_type: media.source_type,
        source_id: sourceId,
        url: url,
        playlists: media.playlists
      });
    }
  }

  console.log(`   ✓ Found in R2: ${foundInR2}`);
  console.log(`   ❌ Not in R2: ${notInR2}`);
  console.log(`   Match rate: ${((foundInR2 / playlistMediaItems.size) * 100).toFixed(1)}%\n`);

  // Step 4: Detailed analysis by source type
  console.log('Step 4: Analyzing by source type...\n');
  
  const bySourceType = new Map<string, { total: number, inR2: number, notInR2: number }>();
  
  for (const [mediaId, media] of playlistMediaItems) {
    const sourceType = media.source_type || 'unknown';
    const isInR2 = !missingDetails.find(m => m.media_id === mediaId);
    
    if (!bySourceType.has(sourceType)) {
      bySourceType.set(sourceType, { total: 0, inR2: 0, notInR2: 0 });
    }
    
    const stats = bySourceType.get(sourceType)!;
    stats.total++;
    if (isInR2) {
      stats.inR2++;
    } else {
      stats.notInR2++;
    }
  }

  console.log('Source Type Breakdown:');
  console.log('   ' + '-'.repeat(80));
  console.log(
    '   ' + 'Source Type'.padEnd(15) + 
    ' | ' + 'Total'.padEnd(8) + 
    ' | ' + 'In R2'.padEnd(8) + 
    ' | ' + 'Not in R2'.padEnd(10) + 
    ' | ' + 'R2 %'
  );
  console.log('   ' + '-'.repeat(80));
  
  for (const [sourceType, stats] of bySourceType) {
    const pct = ((stats.inR2 / stats.total) * 100).toFixed(1);
    console.log(
      '   ' + sourceType.padEnd(15) + 
      ' | ' + String(stats.total).padEnd(8) + 
      ' | ' + String(stats.inR2).padEnd(8) + 
      ' | ' + String(stats.notInR2).padEnd(10) + 
      ' | ' + pct + '%'
    );
  }
  console.log('   ' + '-'.repeat(80));
  console.log('');

  // Step 5: Summary by playlist
  console.log('Step 5: Summary by playlist...\n');
  
  console.log('Playlist Coverage:');
  console.log('   ' + '-'.repeat(90));
  console.log(
    '   ' + 'Playlist Name'.padEnd(30) + 
    ' | ' + 'Total'.padEnd(8) + 
    ' | ' + 'In R2'.padEnd(8) + 
    ' | ' + 'Not in R2'.padEnd(10) + 
    ' | ' + 'R2 %'
  );
  console.log('   ' + '-'.repeat(90));
  
  for (const [playlistName, mediaList] of mediaByPlaylist) {
    let inR2Count = 0;
    for (const media of mediaList) {
      const isMissing = missingDetails.find(m => m.media_id === media.id);
      if (!isMissing) inR2Count++;
    }
    
    const notInR2Count = mediaList.length - inR2Count;
    const pct = mediaList.length > 0 ? ((inR2Count / mediaList.length) * 100).toFixed(1) : '0.0';
    
    console.log(
      '   ' + playlistName.substring(0, 29).padEnd(30) + 
      ' | ' + String(mediaList.length).padEnd(8) + 
      ' | ' + String(inR2Count).padEnd(8) + 
      ' | ' + String(notInR2Count).padEnd(10) + 
      ' | ' + pct + '%'
    );
  }
  console.log('   ' + '-'.repeat(90));
  console.log('');

  // Step 6: Write missing items report
  if (missingDetails.length > 0) {
    const missingReportPath = path.join(process.cwd(), 'exports', 'playlist-items-not-in-r2.json');
    fs.writeFileSync(missingReportPath, JSON.stringify({
      summary: {
        total_playlist_items: playlistMediaItems.size,
        items_not_in_r2: missingDetails.length,
        r2_coverage_percent: ((foundInR2 / playlistMediaItems.size) * 100).toFixed(2)
      },
      missing_items: missingDetails
    }, null, 2));
    console.log(`   📄 Missing items report saved to: exports/playlist-items-not-in-r2.json\n`);
  }

  // Final summary
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('COMPARISON COMPLETE');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  console.log('📊 Final Statistics:');
  console.log(`   Total unique media in playlists: ${playlistMediaItems.size}`);
  console.log(`   Found in R2 bucket: ${foundInR2} (${((foundInR2 / playlistMediaItems.size) * 100).toFixed(1)}%)`);
  console.log(`   NOT in R2 bucket: ${notInR2} (${((notInR2 / playlistMediaItems.size) * 100).toFixed(1)}%)`);
  console.log('');
  
  if (notInR2 > 0) {
    console.log('⚠️  Missing items are likely YouTube videos not stored in R2');
    console.log('   See exports/playlist-items-not-in-r2.json for full list\n');
  }
}

comparePlaylistsWithR2().catch(console.error);
