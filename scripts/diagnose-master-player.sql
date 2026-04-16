-- Quick Check: Is Master Player (OBIE) Online & Playing?
-- Run this query in Supabase SQL Editor to diagnose master player status

-- STEP 1: Check all players and their online status (within last 10 seconds)
SELECT 
  '=== PLAYER ONLINE STATUS ===' as info,
  p.id,
  p.name,
  p.status as db_status,
  CASE 
    WHEN (NOW() - p.last_heartbeat) < INTERVAL '10 seconds' THEN '🟢 ONLINE'
    ELSE '🔴 OFFLINE'
  END as current_status,
  ROUND(EXTRACT(EPOCH FROM (NOW() - p.last_heartbeat))::numeric) as seconds_since_heartbeat,
  CASE WHEN p.priority_player_id = p.id THEN '⭐ PRIORITY' ELSE '' END as role,
  p.last_heartbeat
FROM players
ORDER BY p.updated_at DESC;

-- STEP 2: Check playback state
SELECT 
  '=== PLAYBACK STATE ===' as info,
  p.name,
  ps.state,
  ps.current_media_id,
  ROUND(ps.progress * 100, 1) as progress_pct,
  ROUND(EXTRACT(EPOCH FROM (NOW() - ps.last_updated))::numeric) as seconds_since_update,
  ps.last_updated
FROM players p
LEFT JOIN player_status ps ON p.id = ps.player_id
ORDER BY p.updated_at DESC;

-- STEP 3: Check priority player situation
SELECT 
  '=== PRIORITY PLAYER STATUS ===' as info,
  p.name as player_name,
  p.priority_player_id,
  p.id as player_id,
  CASE WHEN (NOW() - p.last_heartbeat) < INTERVAL '10 seconds' THEN '🟢 ONLINE' ELSE '🔴 OFFLINE' END as is_online,
  ROUND(EXTRACT(EPOCH FROM (NOW() - p.last_heartbeat))::numeric) as seconds_since_hb
FROM players p
WHERE p.priority_player_id = p.id;

-- STEP 4: If priority player is offline, show who could take over
SELECT 
  '=== BACKUP PLAYERS (If Priority is Offline) ===' as info,
  p.name,
  CASE WHEN (NOW() - p.last_heartbeat) < INTERVAL '10 seconds' THEN '🟢 ONLINE' ELSE '🔴 OFFLINE' END as status,
  ROUND(EXTRACT(EPOCH FROM (NOW() - p.last_heartbeat))::numeric) as seconds_since_hb,
  p.id
FROM players p
WHERE p.priority_player_id != p.id  -- Not the priority player
ORDER BY p.last_heartbeat DESC;
