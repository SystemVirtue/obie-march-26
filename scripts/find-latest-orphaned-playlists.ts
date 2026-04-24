#!/usr/bin/env node
/**
 * Find most recently created version of each orphaned playlist (unique names)
 * Usage: npx tsx scripts/find-latest-orphaned-playlists.ts
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

async function findLatestOrphanedPlaylists() {
  console.log('\n🔍 Finding most recent version of each orphaned playlist (by unique name)...\n');

  // Get all orphaned playlists
  const { data: playlists, error } = await supabase
    .from('playlists')
    .select(`
      id,
      name,
      player_id,
      created_at,
      updated_at
    `)
    .order('name, created_at', { ascending: false });

  if (error) {
    console.error('Error fetching playlists:', error.message);
    process.exit(1);
  }

  if (!playlists || playlists.length === 0) {
    console.log('No playlists found.');
    return;
  }

  // Filter to orphaned (player doesn't exist) and get most recent of each name
  const orphaned = (playlists as any[]).filter(async (p: any) => {
    const { data: player } = await supabase
      .from('players')
      .select('id')
      .eq('id', p.player_id)
      .maybeSingle();
    return !player;
  });

  // Group by name and get most recent
  const byName = new Map<string, any[]>();
  for (const p of playlists as any[]) {
    if (!byName.has(p.name)) {
      byName.set(p.name, []);
    }
    byName.get(p.name)!.push(p);
  }

  // Get most recent of each name
  const latestByName: any[] = [];
  for (const [name, items] of byName) {
    // Sort by created_at descending and take first
    const sorted = items.sort((a: any, b: any) => 
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
    const mostRecent = sorted[0];
    
    // Check if orphaned (player doesn't exist)
    const { data: player } = await supabase
      .from('players')
      .select('id')
      .eq('id', mostRecent.player_id)
      .maybeSingle();
    
    if (!player) {
      // Get song count
      const { count } = await supabase
        .from('playlist_items')
        .select('*', { count: 'exact', head: true })
        .eq('playlist_id', mostRecent.id);
      
      latestByName.push({
        ...mostRecent,
        song_count: count || 0
      });
    }
  }

  if (latestByName.length === 0) {
    console.log('✅ No orphaned playlists found with unique names.');
    return;
  }

  // Sort by name
  latestByName.sort((a, b) => a.name.localeCompare(b.name));

  // Display table
  console.log('='.repeat(130));
  console.log(
    '| ' +
    'Playlist Name'.padEnd(28) +
    ' | ' +
    'Playlist_ID'.padEnd(38) +
    ' | ' +
    'Player_ID'.padEnd(38) +
    ' | ' +
    'Songs'.padEnd(6) +
    ' | ' +
    'Created_At'.padEnd(20) +
    ' |'
  );
  console.log('-'.repeat(130));

  for (const p of latestByName) {
    const name = (p.name || 'Unnamed').substring(0, 27).padEnd(28);
    const id = p.id.substring(0, 37).padEnd(38);
    const playerId = p.player_id.substring(0, 37).padEnd(38);
    const songs = String(p.song_count || 0).padStart(5).padEnd(6);
    const createdAt = (p.created_at || 'unknown').substring(0, 19).padEnd(20);

    console.log(`| ${name} | ${id} | ${playerId} | ${songs} | ${createdAt} |`);
  }

  console.log('='.repeat(130));
  console.log(`\n📊 Found ${latestByName.length} unique orphaned playlist names\n`);

  // Also show summary of duplicates
  let totalDuplicates = 0;
  for (const [name, items] of byName) {
    const orphanedItems = [];
    for (const item of items) {
      const { data: player } = await supabase
        .from('players')
        .select('id')
        .eq('id', item.player_id)
        .maybeSingle();
      if (!player) orphanedItems.push(item);
    }
    if (orphanedItems.length > 1) {
      totalDuplicates += orphanedItems.length - 1;
    }
  }
  
  if (totalDuplicates > 0) {
    console.log(`Note: ${totalDuplicates} older duplicate orphaned playlists exist (same name, older dates)`);
  }
}

findLatestOrphanedPlaylists().catch(console.error);
