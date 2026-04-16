#!/usr/bin/env node

/**
 * Check Master Player (OBIE) Online Status & Playback State
 * 
 * This script queries Supabase to determine:
 * 1. Is the master player online (heartbeat within 10 seconds)?
 * 2. What is its current playback state?
 * 3. How long has it been since last update?
 * 4. Is another player holding priority?
 */

import { createClient } from '@supabase/supabase-js';

const projectUrl = process.env.VITE_SUPABASE_URL;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY;

if (!projectUrl || !anonKey) {
  console.error('❌ Error: VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY env vars required');
  process.exit(1);
}

const supabase = createClient(projectUrl, anonKey);

async function checkMasterPlayerStatus() {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  MASTER PLAYER (OBIE) DIAGNOSTIC CHECK');
  console.log('═══════════════════════════════════════════════════════════\n');

  try {
    // Get all players with their status
    console.log('📋 Fetching player status...\n');
    const { data: players, error: playersError } = await supabase
      .from('players')
      .select('id, name, status, last_heartbeat, priority_player_id, created_at')
      .order('updated_at', { ascending: false });

    if (playersError) throw playersError;
    if (!players || players.length === 0) {
      console.log('⚠️  No players found in database');
      return;
    }

    // Display all players overview
    console.log('📊 ALL PLAYERS:\n');
    players.forEach((player, idx) => {
      const lastHb = new Date(player.last_heartbeat);
      const secondsAgo = Math.round((Date.now() - lastHb.getTime()) / 1000);
      const isOnline = secondsAgo < 10;
      const status = isOnline ? '🟢 ONLINE' : '🔴 OFFLINE';
      const isPriority = player.priority_player_id === player.id ? ' [PRIORITY]' : '';

      console.log(`  ${idx + 1}. ${player.name}`);
      console.log(`     ├─ ID: ${player.id}`);
      console.log(`     ├─ Status: ${status} (${secondsAgo}s since heartbeat)`);
      console.log(`     ├─ DB Status: ${player.status}${isPriority}`);
      console.log(`     └─ Last HB: ${lastHb.toISOString()}`);
    });

    // Get playback state for each player
    console.log('\n\n🎵 PLAYBACK STATE:\n');
    const { data: statuses, error: statusError } = await supabase
      .from('player_status')
      .select('player_id, state, current_media_id, progress, last_updated')
      .in('player_id', players.map(p => p.id));

    if (statusError) throw statusError;

    for (const player of players) {
      const ps = statuses?.find(s => s.player_id === player.id);
      const lastHb = new Date(player.last_heartbeat);
      const secondsAgo = Math.round((Date.now() - lastHb.getTime()) / 1000);
      const isOnline = secondsAgo < 10;

      console.log(`${player.name}${player.priority_player_id === player.id ? ' [PRIORITY]' : ''}`);
      console.log(`  ├─ Online: ${isOnline ? '✓ YES' : '✗ NO'} (${secondsAgo}s since heartbeat)`);
      console.log(`  ├─ Playback State: ${ps?.state || 'unknown'}`);
      console.log(`  ├─ Progress: ${ps?.progress ? (ps.progress * 100).toFixed(1) + '%' : 'N/A'}`);
      console.log(`  └─ Last Updated: ${ps?.last_updated ? new Date(ps.last_updated).toISOString() : 'never'}`);
      console.log();
    }

    // Summary diagnosis
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  DIAGNOSIS SUMMARY');
    console.log('═══════════════════════════════════════════════════════════\n');

    const masterPlayer = players[0]; // First player (most recently active)
    const lastHb = new Date(masterPlayer.last_heartbeat);
    const secondsAgo = Math.round((Date.now() - lastHb.getTime()) / 1000);
    const isOnline = secondsAgo < 10;

    console.log(`Master Player: ${masterPlayer.name} (ID: ${masterPlayer.id})`);
    console.log();

    if (isOnline) {
      console.log('✅ MASTER PLAYER IS ONLINE');
      console.log(`   Heartbeat: ${secondsAgo} seconds ago`);
      console.log(`   Status: ${masterPlayer.status}`);
      
      const ps = statuses?.find(s => s.player_id === masterPlayer.id);
      console.log(`   Playback: ${ps?.state || 'unknown'}`);
      
      if (ps?.state === 'playing') {
        console.log(`   ✓ Currently PLAYING`);
      } else if (ps?.state === 'paused') {
        console.log(`   ⚠️  Currently PAUSED`);
      } else if (ps?.state === 'idle') {
        console.log(`   ⚠️  Currently IDLE (no song)`);
      } else {
        console.log(`   ? State unknown`);
      }
    } else {
      console.log('❌ MASTER PLAYER IS OFFLINE');
      console.log(`   Last heartbeat: ${secondsAgo} seconds ago`);
      console.log(`   Status: ${masterPlayer.status}`);
      console.log();
      console.log('   POSSIBLE CAUSES:');
      console.log('   • Network disconnect');
      console.log('   • Browser/app closed');
      console.log('   • Device powered off');
      console.log('   • Device in standby');
      console.log();
      console.log('   ACTION REQUIRED:');
      console.log('   • Check if OBIE device is powered on');
      console.log('   • Verify network connectivity');
      console.log('   • Restart the Player app if needed');
    }

    // Check priority situation
    console.log('\n');
    const priorityPlayer = players.find(p => p.priority_player_id === p.id);
    const priorityHb = new Date(priorityPlayer?.last_heartbeat);
    const prioritySecondsAgo = Math.round((Date.now() - priorityHb.getTime()) / 1000);
    const priorityOnline = prioritySecondsAgo < 10;

    console.log(`Priority Player: ${priorityPlayer?.name || 'none'}`);
    if (priorityPlayer) {
      console.log(`  Status: ${priorityOnline ? '🟢 ONLINE' : '🔴 OFFLINE'} (${prioritySecondsAgo}s)`);
      console.log();
      if (!priorityOnline && players.length > 1) {
        console.log('  ⚠️  WARNING: Priority player is OFFLINE but holding priority status!');
        console.log('     Slave players cannot advance the queue.');
        console.log('     Solution: Wait for reconnection or manually reset priority via admin panel.');
      }
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

checkMasterPlayerStatus();
