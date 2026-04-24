#!/usr/bin/env node
/**
 * Check for deleted playlist recovery options
 * Usage: npx tsx scripts/check-deleted-playlists.ts
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

async function checkDeletedPlaylists() {
  console.log('\n🔍 Checking for deleted playlist recovery options...\n');

  // 1. Check playlists table structure
  console.log('1. Checking playlists table structure...');
  const { data: samplePlaylist } = await supabase.from('playlists').select('*').limit(1).single();
  const columns = Object.keys(samplePlaylist || {});
  console.log('   Columns:', columns.join(', '));
  
  // Check for soft delete columns
  const hasSoftDelete = columns.some(c => 
    c.toLowerCase().includes('deleted') || 
    c.toLowerCase().includes('archived') ||
    c.toLowerCase() === 'is_active'
  );
  
  if (hasSoftDelete) {
    console.log('   ⚠️ Soft delete column detected - checking for deleted records...');
    
    // Check is_active=false (might indicate soft delete)
    const { data: inactive, count } = await supabase
      .from('playlists')
      .select('*', { count: 'exact' })
      .eq('is_active', false);
    
    if (count && count > 0) {
      console.log(`   Found ${count} inactive playlists (is_active=false)`);
    }
  } else {
    console.log('   ❌ No soft delete columns (deleted_at, is_deleted, archived)');
    console.log('      Playlists are HARD DELETED when removed');
  }

  // 2. Check for orphaned playlist_items
  console.log('\n2. Checking for orphaned playlist_items...');
  
  const { data: allPlaylists } = await supabase.from('playlists').select('id');
  const playlistIds = new Set(allPlaylists?.map(p => p.id) || []);
  
  const { data: allItems } = await supabase.from('playlist_items').select('id, playlist_id');
  const orphanedItems = (allItems || []).filter(item => !playlistIds.has(item.playlist_id));
  
  if (orphanedItems.length > 0) {
    console.log(`   ⚠️ Found ${orphanedItems.length} orphaned playlist_items!`);
    console.log('      These belong to deleted playlists but were not cleaned up.');
    console.log('      Media IDs in orphaned items could help identify what was deleted.');
    
    // Get unique orphaned playlist IDs
    const orphanedPlaylistIds = [...new Set(orphanedItems.map(i => i.playlist_id))];
    console.log(`      Unique deleted playlist IDs: ${orphanedPlaylistIds.length}`);
    console.log('      Sample orphaned playlist IDs:', orphanedPlaylistIds.slice(0, 5));
  } else {
    console.log('   ✅ No orphaned playlist_items found');
    console.log('      All playlist_items are properly linked to existing playlists');
  }

  // 3. Check Supabase system logs (if available)
  console.log('\n3. Checking system_logs table...');
  const { data: logs, error: logsError } = await supabase
    .from('system_logs')
    .select('*')
    .ilike('event', '%playlist%')
    .order('id', { ascending: false })
    .limit(20);

  if (logsError) {
    console.log('   ℹ️ system_logs table not accessible:', logsError.message);
  } else if (logs && logs.length > 0) {
    console.log(`   Found ${logs.length} playlist-related log entries`);
    logs.forEach((log: any) => {
      console.log(`      - ${log.event}: ${JSON.stringify(log.payload).substring(0, 100)}`);
    });
  } else {
    console.log('   ℹ️ No playlist-related entries in system_logs');
  }

  // 4. Check for event_log table (from production migration)
  console.log('\n4. Checking for event_log table...');
  const { error: eventLogError } = await (supabase as any)
    .from('event_log')
    .select('*', { count: 'exact', head: true });

  if (eventLogError) {
    console.log('   ℹ️ event_log table does not exist or is not accessible');
  } else {
    console.log('   ✅ event_log table exists - checking for deletion events...');
    
    const { data: events } = await (supabase as any)
      .from('event_log')
      .select('*')
      .ilike('event_type', '%delete%')
      .order('created_at', { ascending: false })
      .limit(20);
    
    if (events && events.length > 0) {
      console.log(`   Found ${events.length} deletion events`);
    }
  }

  // 5. Summary and recommendations
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('RECOVERY ASSESSMENT');
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log('❌ SOFT DELETE: Not enabled');
  console.log('   - The playlists table has no deleted_at or is_deleted column');
  console.log('   - When playlists are deleted, they are permanently removed\n');

  if (orphanedItems.length > 0) {
    console.log('⚠️  ORPHANED ITEMS: Some data remains');
    console.log(`   - ${orphanedItems.length} playlist_items exist without parent playlists`);
    console.log('   - These could potentially be used to partially reconstruct deleted playlists');
    console.log('   - However, playlist metadata (name, description) is lost\n');
  }

  console.log('📋 RECOVERY OPTIONS:\n');
  
  console.log('1. SUPABASE BACKUPS (Recommended)');
  console.log('   - Supabase provides Point-in-Time Recovery (PITR) for Pro/Team plans');
  console.log('   - Check: https://app.supabase.com/project/_/database/backups');
  console.log('   - Can restore to a specific time before deletion\n');
  
  console.log('2. LOCAL BACKUPS');
  console.log('   - Check if you have any local database dumps');
  console.log('   - Run: ls -la *.sql or find . -name "*.dump"\n');
  
  console.log('3. NO DIRECT RECOVERY');
  console.log('   - Without backups or soft delete, deleted data cannot be recovered');
  console.log('   - Consider enabling soft delete for future protection\n');

  console.log('═══════════════════════════════════════════════════════════════\n');
}

checkDeletedPlaylists().catch(console.error);
