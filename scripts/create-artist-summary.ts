#!/usr/bin/env node
/**
 * Create deduplicated artist summary from R2 CSV export
 * Outputs: Artist Name | Number of Videos
 * 
 * Usage: npx tsx scripts/create-artist-summary.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const R2_CSV_PATH = path.join(process.cwd(), 'exports', 'r2-files-export-2026-04-25T04-04-39-184Z.csv');
const SEPARATOR = '|';

async function createArtistSummary() {
  console.log('\n🎵 Creating artist summary from R2 CSV...\n');

  // Read CSV file
  if (!fs.existsSync(R2_CSV_PATH)) {
    console.error(`❌ CSV file not found: ${R2_CSV_PATH}`);
    process.exit(1);
  }

  console.log('Step 1: Reading CSV file...');
  const csvContent = fs.readFileSync(R2_CSV_PATH, 'utf-8');
  const lines = csvContent.split('\n').filter(line => line.trim());
  console.log(`   ✓ Loaded ${lines.length} lines\n`);

  // Parse header to find artist column index
  const header = lines[0].split(SEPARATOR);
  const artistIndex = header.indexOf('artist');
  const titleIndex = header.indexOf('title');
  const objectKeyIndex = header.indexOf('object_key');

  if (artistIndex === -1) {
    console.error('❌ Artist column not found in CSV');
    process.exit(1);
  }

  console.log('Step 2: Parsing data and counting videos per artist...');

  // Count videos per artist (using object_key as unique identifier)
  const artistVideos = new Map<string, Set<string>>();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const fields = line.split(SEPARATOR);
    
    if (fields.length <= artistIndex) continue;

    const artist = fields[artistIndex]?.trim() || 'Unknown Artist';
    const objectKey = fields[objectKeyIndex]?.trim() || '';

    if (!artistVideos.has(artist)) {
      artistVideos.set(artist, new Set());
    }
    
    // Add object_key to deduplicate (same video might appear multiple times)
    if (objectKey) {
      artistVideos.get(artist)!.add(objectKey);
    }

    // Progress indicator
    if (i % 1000 === 0) {
      process.stdout.write(`   Processed ${i}/${lines.length - 1} rows...\r`);
    }
  }

  console.log(`\n   ✓ Processed ${lines.length - 1} data rows`);
  console.log(`   ✓ Found ${artistVideos.size} unique artists\n`);

  // Create sorted summary
  const sortedArtists = [...artistVideos.entries()]
    .map(([artist, videos]) => ({
      artist,
      count: videos.size
    }))
    .sort((a, b) => b.count - a.count); // Sort by video count descending

  // Output summary table
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('ARTIST SUMMARY - Deduplicated Video Counts');
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log('Rank | Artist Name'.padEnd(55) + '| Number of Videos');
  console.log('-'.repeat(75));

  sortedArtists.forEach((item, index) => {
    const rank = String(index + 1).padStart(4);
    const artistName = item.artist.substring(0, 48).padEnd(48);
    const count = String(item.count).padStart(5);
    console.log(`${rank} | ${artistName} | ${count}`);
  });

  console.log('-'.repeat(75));
  const totalArtists = sortedArtists.length;
  const totalVideos = sortedArtists.reduce((sum, a) => sum + a.count, 0);
  console.log(`Total Artists: ${totalArtists}`);
  console.log(`Total Unique Videos: ${totalVideos}\n`);

  // Write CSV output
  console.log('Step 3: Writing summary CSV...');
  
  const summaryCsv = [
    'Artist Name|Number of Videos',
    ...sortedArtists.map(a => `${a.artist}|${a.count}`)
  ].join('\n');

  const outputPath = path.join(process.cwd(), 'exports', 'artist-video-summary.csv');
  fs.writeFileSync(outputPath, summaryCsv, 'utf-8');

  console.log(`   ✓ Summary saved to: exports/artist-video-summary.csv\n`);

  // Top 20 preview
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('TOP 20 ARTISTS BY VIDEO COUNT');
  console.log('═══════════════════════════════════════════════════════════════\n');

  sortedArtists.slice(0, 20).forEach((item, index) => {
    console.log(`${String(index + 1).padStart(2)}. ${item.artist.padEnd(40)} ${String(item.count).padStart(5)} videos`);
  });
  console.log('');
}

createArtistSummary().catch(console.error);
