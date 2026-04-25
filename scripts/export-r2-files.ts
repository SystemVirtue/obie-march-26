#!/usr/bin/env node
/**
 * Export complete list of all R2 bucket files with full metadata
 * 
 * Usage: npx tsx scripts/export-r2-files.ts
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

async function exportR2Files() {
  console.log('\n📦 Exporting R2 bucket file listing...\n');

  // Step 1: Get total count
  console.log('Step 1: Counting R2 files...');
  const { count, error: countError } = await supabase
    .from('r2_files')
    .select('*', { count: 'exact', head: true });

  if (countError) {
    console.error('❌ Error counting R2 files:', countError.message);
    process.exit(1);
  }

  console.log(`   Total R2 files: ${count}\n`);

  if (!count || count === 0) {
    console.log('   No R2 files found in database.\n');
    return;
  }

  // Step 2: Fetch all R2 files in batches
  console.log('Step 2: Fetching all R2 file metadata...');
  
  const allFiles: any[] = [];
  const batchSize = 1000;
  let fetched = 0;

  while (fetched < count) {
    const { data: files, error: fetchError } = await supabase
      .from('r2_files')
      .select('*')
      .order('object_key')
      .range(fetched, fetched + batchSize - 1);

    if (fetchError) {
      console.error(`❌ Error fetching batch at offset ${fetched}:`, fetchError.message);
      process.exit(1);
    }

    if (!files || files.length === 0) break;

    allFiles.push(...files);
    fetched += files.length;
    
    process.stdout.write(`   Fetched ${fetched}/${count} files...\r`);
  }

  console.log(`\n   ✓ Fetched ${allFiles.length} files\n`);

  // Step 3: Analyze directory structure
  console.log('Step 3: Analyzing directory structure...');
  
  const directories = new Map<string, number>();
  const contentTypes = new Map<string, number>();
  const buckets = new Map<string, number>();
  let totalSize = 0;

  for (const file of allFiles) {
    // Extract directory from object_key
    const dir = file.object_key?.split('/').slice(0, -1).join('/') || 'root';
    directories.set(dir, (directories.get(dir) || 0) + 1);

    // Content types
    const ct = file.content_type || 'unknown';
    contentTypes.set(ct, (contentTypes.get(ct) || 0) + 1);

    // Buckets
    const bucket = file.bucket_name || 'unknown';
    buckets.set(bucket, (buckets.get(bucket) || 0) + 1);

    // Total size
    totalSize += file.size_bytes || 0;
  }

  // Step 4: Build export data
  console.log('Step 4: Building export data...');
  
  const exportData = {
    export_metadata: {
      exported_at: new Date().toISOString(),
      total_files: allFiles.length,
      total_size_bytes: totalSize,
      total_size_mb: Math.round(totalSize / 1024 / 1024 * 100) / 100,
      total_size_gb: Math.round(totalSize / 1024 / 1024 / 1024 * 100) / 100,
      buckets: Object.fromEntries(buckets),
      directories: Object.fromEntries(directories),
      content_types: Object.fromEntries(contentTypes)
    },
    files: allFiles.map(file => ({
      id: file.id,
      bucket_name: file.bucket_name,
      object_key: file.object_key,
      file_name: file.file_name,
      directory: file.object_key?.split('/').slice(0, -1).join('/') || 'root',
      public_url: file.public_url,
      content_type: file.content_type,
      size_bytes: file.size_bytes,
      size_kb: file.size_bytes ? Math.round(file.size_bytes / 1024 * 100) / 100 : null,
      size_mb: file.size_bytes ? Math.round(file.size_bytes / 1024 / 1024 * 100) / 100 : null,
      etag: file.etag,
      last_modified: file.last_modified,
      created_at: file.created_at,
      synced_at: file.synced_at,
      // Media metadata
      title: file.title,
      artist: file.artist,
      duration: file.duration,
      duration_formatted: file.duration ? 
        `${Math.floor(file.duration / 60)}:${String(Math.floor(file.duration % 60)).padStart(2, '0')}` : 
        null,
      thumbnail: file.thumbnail,
      tags: file.tags
    }))
  };

  // Step 5: Write to file
  console.log('Step 5: Writing export file...');
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `r2-files-export-${timestamp}.json`;
  const filepath = path.join(process.cwd(), 'exports', filename);
  
  // Ensure exports directory exists
  const exportsDir = path.join(process.cwd(), 'exports');
  if (!fs.existsSync(exportsDir)) {
    fs.mkdirSync(exportsDir, { recursive: true });
  }
  
  fs.writeFileSync(filepath, JSON.stringify(exportData, null, 2));
  
  const stats = fs.statSync(filepath);
  console.log(`   ✓ Export saved to: exports/${filename}`);
  console.log(`   File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB\n`);

  // Step 6: Summary
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('R2 BUCKET EXPORT COMPLETE');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  console.log('📊 Summary:');
  console.log(`   Total files: ${allFiles.length.toLocaleString()}`);
  console.log(`   Total size: ${exportData.export_metadata.total_size_gb} GB (${exportData.export_metadata.total_size_mb} MB)`);
  console.log(`   Buckets: ${buckets.size}`);
  console.log(`   Directories: ${directories.size}`);
  console.log(`   Content types: ${contentTypes.size}\n`);

  console.log('📁 Directory breakdown:');
  const sortedDirs = [...directories.entries()].sort((a, b) => b[1] - a[1]);
  for (const [dir, count] of sortedDirs.slice(0, 20)) {
    console.log(`   ${dir.padEnd(50)} ${String(count).padStart(6)} files`);
  }
  if (sortedDirs.length > 20) {
    console.log(`   ... and ${sortedDirs.length - 20} more directories\n`);
  }

  console.log('📋 Content types:');
  const sortedCT = [...contentTypes.entries()].sort((a, b) => b[1] - a[1]);
  for (const [ct, count] of sortedCT) {
    console.log(`   ${ct.padEnd(30)} ${String(count).padStart(6)} files`);
  }
  console.log('');

  console.log('🎵 Media metadata stats:');
  const withTitle = allFiles.filter(f => f.title).length;
  const withArtist = allFiles.filter(f => f.artist).length;
  const withDuration = allFiles.filter(f => f.duration).length;
  const withThumbnail = allFiles.filter(f => f.thumbnail).length;
  
  console.log(`   Files with title: ${withTitle}/${allFiles.length} (${Math.round(withTitle/allFiles.length*100)}%)`);
  console.log(`   Files with artist: ${withArtist}/${allFiles.length} (${Math.round(withArtist/allFiles.length*100)}%)`);
  console.log(`   Files with duration: ${withDuration}/${allFiles.length} (${Math.round(withDuration/allFiles.length*100)}%)`);
  console.log(`   Files with thumbnail: ${withThumbnail}/${allFiles.length} (${Math.round(withThumbnail/allFiles.length*100)}%)`);
  console.log('');
}

exportR2Files().catch(console.error);
