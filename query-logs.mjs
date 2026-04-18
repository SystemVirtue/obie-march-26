#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error('Error: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');
  process.exit(1);
}

const sb = createClient(url, key);

async function queryLogs() {
  try {
    // Get event distribution from last 24 hours
    const { data: logs, error } = await sb
      .from('system_logs')
      .select('event, severity, timestamp, player_id, payload')
      .gte('timestamp', new Date(Date.now() - 24 * 3600 * 1000).toISOString())
      .order('timestamp', { ascending: false });

    if (error) {
      console.error('Query error:', error);
      process.exit(1);
    }

    if (!logs || logs.length === 0) {
      console.log('No logs found in the last 24 hours.');
      process.exit(0);
    }

    // Aggregate by event and severity
    const eventCounts = {};
    const severityCounts = { info: 0, warn: 0, error: 0, debug: 0 };
    const playerIds = new Set();

    logs.forEach((log) => {
      const key = `${log.event}|${log.severity}`;
      eventCounts[key] = (eventCounts[key] || 0) + 1;
      severityCounts[log.severity]++;
      if (log.player_id) playerIds.add(log.player_id);
    });

    console.log('\n=== System Logs Analysis (Last 24 Hours) ===\n');
    console.log(`Total log entries: ${logs.length}`);
    console.log(`Unique players: ${playerIds.size}`);
    console.log(`Date range: ${new Date(logs[logs.length - 1].timestamp).toISOString()} to ${new Date(logs[0].timestamp).toISOString()}`);

    console.log('\n--- Severity Distribution ---');
    console.log(severityCounts);

    console.log('\n--- Event Distribution (Top 30) ---');
    const sorted = Object.entries(eventCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30);

    sorted.forEach(([key, count]) => {
      const [event, severity] = key.split('|');
      console.log(`  ${event.padEnd(30)} [${severity.toUpperCase()}]: ${count}`);
    });

    console.log('\n--- Sample Logs (Last 10) ---');
    logs.slice(0, 10).forEach((log) => {
      console.log(`[${new Date(log.timestamp).toISOString()}] ${log.event} (${log.severity})`);
      if (log.payload && Object.keys(log.payload).length > 0) {
        console.log(`  Payload: ${JSON.stringify(log.payload)}`);
      }
    });

  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

queryLogs();
