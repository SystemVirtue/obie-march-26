#!/usr/bin/env node
/**
 * Convert R2 JSON export to CSV with unique separator for OpenOffice
 * Uses pipe (|) as separator instead of comma
 * 
 * Usage: npx tsx scripts/convert-r2-to-csv.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const R2_EXPORT_PATH = path.join(process.cwd(), 'exports', 'r2-files-export-2026-04-25T04-04-39-184Z.json');
const SEPARATOR = '|';  // Pipe character - unique and unlikely to appear in data

function escapeField(value: any): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  // If field contains separator, quote it
  if (str.includes(SEPARATOR) || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

async function convertR2ToCSV() {
  console.log('\n📄 Converting R2 JSON to CSV...\n');

  // Read R2 export
  if (!fs.existsSync(R2_EXPORT_PATH)) {
    console.error(`❌ R2 export not found: ${R2_EXPORT_PATH}`);
    process.exit(1);
  }

  console.log('Step 1: Reading R2 JSON export...');
  const r2Data = JSON.parse(fs.readFileSync(R2_EXPORT_PATH, 'utf-8'));
  const files = r2Data.files || [];
  console.log(`   ✓ Loaded ${files.length} files\n`);

  // Define CSV columns
  const columns = [
    'id',
    'bucket_name',
    'object_key',
    'directory',
    'file_name',
    'public_url',
    'content_type',
    'size_bytes',
    'size_kb',
    'size_mb',
    'etag',
    'last_modified',
    'created_at',
    'synced_at',
    'title',
    'artist',
    'duration',
    'duration_formatted',
    'thumbnail',
    'tags'
  ];

  console.log('Step 2: Building CSV content...');
  
  // Build header
  const header = columns.join(SEPARATOR);
  
  // Build rows
  const rows: string[] = [];
  
  for (const file of files) {
    const row = columns.map(col => {
      let value = file[col];
      
      // Special handling for tags array
      if (col === 'tags' && Array.isArray(value)) {
        value = value.join(';');
      }
      
      return escapeField(value);
    });
    
    rows.push(row.join(SEPARATOR));
    
    // Progress indicator
    if (rows.length % 1000 === 0) {
      process.stdout.write(`   Processed ${rows.length}/${files.length} rows...\r`);
    }
  }

  console.log(`\n   ✓ Processed ${rows.length} rows\n`);

  // Write CSV file
  console.log('Step 3: Writing CSV file...');
  
  const csvContent = [header, ...rows].join('\n');
  const outputFilename = 'r2-files-export-2026-04-25T04-04-39-184Z.csv';
  const outputPath = path.join(process.cwd(), 'exports', outputFilename);
  
  fs.writeFileSync(outputPath, csvContent, 'utf-8');
  
  const stats = fs.statSync(outputPath);
  console.log(`   ✓ CSV saved to: exports/${outputFilename}`);
  console.log(`   File size: ${(stats.size / 1024).toFixed(2)} KB\n`);

  // Summary
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('CSV CONVERSION COMPLETE');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  console.log('📊 Summary:');
  console.log(`   Total rows: ${files.length}`);
  console.log(`   Columns: ${columns.length}`);
  console.log(`   Separator: "${SEPARATOR}" (pipe character)`);
  console.log(`   Output: exports/${outputFilename}\n`);

  console.log('📋 Columns included:');
  columns.forEach((col, i) => {
    console.log(`   ${String(i + 1).padStart(2)}. ${col}`);
  });
  console.log('');

  console.log('📝 OpenOffice Import Instructions:');
  console.log('   1. Open OpenOffice Calc');
  console.log('   2. File → Open');
  console.log(`   3. Select: exports/${outputFilename}`);
  console.log('   4. In Text Import dialog:');
  console.log(`      - Select "Separated by" and check "Other"`);
  console.log(`      - Enter separator: ${SEPARATOR}`);
  console.log('      - Click OK');
  console.log('');
}

convertR2ToCSV().catch(console.error);
