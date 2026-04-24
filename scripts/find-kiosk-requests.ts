#!/usr/bin/env node
/**
 * Find previous Kiosk requests logged in the database
 * Checks: kiosk_sessions, queue (requested_by), system_logs, event_log
 * 
 * Usage: npx tsx scripts/find-kiosk-requests.ts
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

async function findKioskRequests() {
  console.log('\n🔍 Searching for previous Kiosk requests...\n');

  // ============================================================
  // 1. Check kiosk_sessions table
  // ============================================================
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('1. KIOSK SESSIONS TABLE');
  console.log('═══════════════════════════════════════════════════════════════');
  
  const { data: sessions, count: sessionCount, error: sessionError } = await supabase
    .from('kiosk_sessions')
    .select('*', { count: 'exact' })
    .order('last_active', { ascending: false })
    .limit(20);

  if (sessionError) {
    console.log('   ❌ Error:', sessionError.message);
  } else {
    console.log(`   Found ${sessionCount || 0} kiosk session(s)`);
    
    if (sessions && sessions.length > 0) {
      console.log('\n   Recent sessions:');
      console.log('   ' + '-'.repeat(70));
      console.log(
        '   ' + 'Session ID'.padEnd(38) + 
        ' | ' + 'Credits'.padEnd(8) + 
        ' | ' + 'Last Active'.padEnd(20)
      );
      console.log('   ' + '-'.repeat(70));
      
      for (const session of sessions) {
        const id = session.session_id.substring(0, 37).padEnd(38);
        const credits = String(session.credits || 0).padEnd(8);
        const lastActive = (session.last_active || 'N/A').substring(0, 19).padEnd(20);
        console.log(`   ${id} | ${credits} | ${lastActive}`);
      }
      console.log('   ' + '-'.repeat(70));
    }
  }

  // ============================================================
  // 2. Check queue table for kiosk requests
  // ============================================================
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('2. QUEUE TABLE (Kiosk Requests)');
  console.log('═══════════════════════════════════════════════════════════════');
  
  // Get queue items with requested_by info
  const { data: queueItems, count: queueCount, error: queueError } = await supabase
    .from('queue')
    .select(`
      id,
      requested_at,
      requested_by,
      type,
      position,
      player_id,
      media_item:media_items (
        title,
        artist
      )
    `)
    .order('requested_at', { ascending: false })
    .limit(30);

  if (queueError) {
    console.log('   ❌ Error:', queueError.message);
  } else {
    console.log(`   Found ${queueCount || 0} total queue item(s)`);
    
    // Filter to kiosk requests (those with requested_by that looks like a session ID or has kiosk pattern)
    const kioskRequests = (queueItems || []).filter((item: any) => {
      const requestedBy = item.requested_by || '';
      // Kiosk requests typically have session IDs or specific patterns
      return requestedBy && (
        requestedBy.includes('session') || 
        requestedBy.match(/^[0-9a-f-]{36}$/) || // UUID pattern
        requestedBy.toLowerCase().includes('kiosk')
      );
    });

    console.log(`   ${kioskRequests.length} appear to be from kiosk requests\n`);
    
    if (kioskRequests.length > 0) {
      console.log('   Recent kiosk requests:');
      console.log('   ' + '-'.repeat(90));
      console.log(
        '   ' + 'Media Title'.padEnd(30) + 
        ' | ' + 'Artist'.padEnd(20) + 
        ' | ' + 'Requested By'.padEnd(20) +
        ' | ' + 'Date'.padEnd(10)
      );
      console.log('   ' + '-'.repeat(90));
      
      for (const item of kioskRequests.slice(0, 10)) {
        const title = (item.media_item?.title || 'Unknown').substring(0, 29).padEnd(30);
        const artist = (item.media_item?.artist || 'Unknown').substring(0, 19).padEnd(20);
        const requestedBy = (item.requested_by || 'N/A').substring(0, 19).padEnd(20);
        const date = (item.requested_at || '').substring(0, 10).padEnd(10);
        console.log(`   ${title} | ${artist} | ${requestedBy} | ${date}`);
      }
      console.log('   ' + '-'.repeat(90));
    }
  }

  // ============================================================
  // 3. Check system_logs for kiosk activity
  // ============================================================
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('3. SYSTEM_LOGS (Kiosk Events)');
  console.log('═══════════════════════════════════════════════════════════════');
  
  const { data: logs, error: logsError } = await supabase
    .from('system_logs')
    .select('*')
    .or('event.ilike.%kiosk%,event.ilike.%credit%,event.ilike.%request%')
    .order('id', { ascending: false })
    .limit(20);

  if (logsError) {
    console.log('   ❌ Error:', logsError.message);
  } else if (logs && logs.length > 0) {
    console.log(`   Found ${logs.length} kiosk-related log entries\n`);
    console.log('   ' + '-'.repeat(90));
    console.log(
      '   ' + 'Event'.padEnd(25) + 
      ' | ' + 'Player ID'.padEnd(38) + 
      ' | ' + 'Payload'
    );
    console.log('   ' + '-'.repeat(90));
    
    for (const log of logs) {
      const event = (log.event || 'N/A').substring(0, 24).padEnd(25);
      const playerId = (log.player_id || 'N/A').substring(0, 37).padEnd(38);
      const payload = JSON.stringify(log.payload || {}).substring(0, 30);
      console.log(`   ${event} | ${playerId} | ${payload}`);
    }
    console.log('   ' + '-'.repeat(90));
  } else {
    console.log('   No kiosk-related entries in system_logs');
  }

  // ============================================================
  // 4. Check event_log for kiosk_enqueue events
  // ============================================================
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('4. EVENT_LOG (Kiosk Enqueue Events)');
  console.log('═══════════════════════════════════════════════════════════════');
  
  const { data: events, error: eventsError } = await (supabase as any)
    .from('event_log')
    .select('*')
    .or('event_type.ilike.%kiosk%,event_type.ilike.%enqueue%,event_type.ilike.%request%')
    .order('created_at', { ascending: false })
    .limit(20);

  if (eventsError) {
    console.log('   ℹ️ event_log table not accessible or no kiosk events');
  } else if (events && events.length > 0) {
    console.log(`   Found ${events.length} kiosk-related events\n`);
    console.log('   ' + '-'.repeat(90));
    console.log(
      '   ' + 'Event Type'.padEnd(20) + 
      ' | ' + 'Queue ID'.padEnd(38) + 
      ' | ' + 'Payload'
    );
    console.log('   ' + '-'.repeat(90));
    
    for (const event of events) {
      const type = (event.event_type || 'N/A').substring(0, 19).padEnd(20);
      const queueId = (event.queue_id || 'N/A').substring(0, 37).padEnd(38);
      const payload = JSON.stringify(event.payload || {}).substring(0, 30);
      console.log(`   ${type} | ${queueId} | ${payload}`);
    }
    console.log('   ' + '-'.repeat(90));
  } else {
    console.log('   No kiosk events in event_log');
  }

  // ============================================================
  // SUMMARY
  // ============================================================
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('SUMMARY: Where Kiosk Requests Are Logged');
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log('✅ KIOSK SESSIONS TABLE');
  console.log('   - Tracks active kiosk sessions');
  console.log('   - Records credits per session');
  console.log('   - Links session_id to player_id\n');

  console.log('✅ QUEUE TABLE');
  console.log('   - Stores requested_by (session ID or user)');
  console.log('   - Tracks requested_at timestamp');
  console.log('   - Main record of what was requested\n');

  console.log('⚠️  SYSTEM_LOGS / EVENT_LOG');
  console.log('   - May contain kiosk event history');
  console.log('   - Depends on logging implementation\n');

  console.log('📌 KEY FINDING:');
  console.log('   The QUEUE table is the PRIMARY record of kiosk requests.');
  console.log('   Each queue item with a requested_by field = one kiosk request.\n');
}

findKioskRequests().catch(console.error);
