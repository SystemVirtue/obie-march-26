/**
 * Shared DB Actions for XState Machines
 *
 * Concise wrapper functions for database operations used by
 * playerCoordinatorMachine and playerMachine. Uses simple DB hydration
 * approach rather than full snapshot persistence.
 */

import { createServiceClient } from '../supabase-client.ts';

const supabase = createServiceClient();

// ---------------------------------------------------------------------------
// Snapshot / Hydration
// ---------------------------------------------------------------------------

/**
 * Hydrate coordinator state from DB (simple approach - no snapshot persistence)
 * Returns current priority player and active player heartbeats
 */
export async function hydrateCoordinatorState() {
  const { data: players, error: playerError } = await supabase
    .from('players')
    .select('id, priority_player_id, last_heartbeat');
  
  if (playerError) throw playerError;

  const priorityPlayerId = players?.[0]?.priority_player_id ?? null;
  
  // Build active players map from recent heartbeats (within 2 minutes)
  const activePlayers = new Map<string, { lastHeartbeat: number }>();
  const twoMinutesAgo = Date.now() - 120000;
  
  for (const player of players || []) {
    if (player.last_heartbeat) {
      const heartbeatTime = new Date(player.last_heartbeat).getTime();
      if (heartbeatTime > twoMinutesAgo) {
        activePlayers.set(player.id, { lastHeartbeat: heartbeatTime });
      }
    }
  }

  return {
    priorityPlayerId,
    activePlayers,
    electionCandidate: null,
    resetRequestedAt: null,
    resetRequestedBy: null,
  };
}

/**
 * Hydrate player state from DB
 * Returns current player status and media info
 */
export async function hydratePlayerState(playerId: string) {
  const { data: status, error: statusError } = await supabase
    .from('player_status')
    .select('*')
    .eq('player_id', playerId)
    .single();
  
  if (statusError) throw statusError;

  const { data: player, error: playerError } = await supabase
    .from('players')
    .select('priority_player_id')
    .eq('id', playerId)
    .single();
  
  if (playerError) throw playerError;

  // Map DB state to playback phase
  let playbackPhase;
  const mediaId = status?.current_media_id || null;
  const state = status?.state || 'idle';
  
  switch (state) {
    case 'playing':
      playbackPhase = { phase: 'playing' as const, mediaId: mediaId || '' };
      break;
    case 'paused':
      playbackPhase = { phase: 'paused' as const, mediaId: mediaId || '', pausedBy: 'admin' as const };
      break;
    case 'loading':
      playbackPhase = { phase: 'loading' as const, mediaId: mediaId || '', isAfterSkip: false };
      break;
    default:
      playbackPhase = { phase: 'idle' as const };
  }

  return {
    playerId,
    playback: playbackPhase,
    isPriority: player?.priority_player_id === playerId,
    lastHeartbeat: status?.last_updated ? new Date(status.last_updated).getTime() : 0,
    currentMediaId: mediaId,
    expectedMediaId: mediaId,
  };
}

// ---------------------------------------------------------------------------
// Priority Operations
// ---------------------------------------------------------------------------

/**
 * Claim priority player (atomic with advisory lock)
 */
export async function claimPriorityPlayer(playerId: string) {
  const { error } = await supabase.rpc('claim_priority_player', {
    p_player_id: playerId,
  });
  if (error) throw error;
  return { success: true, isPriority: true };
}

/**
 * Reset priority player globally (admin action)
 */
export async function resetPriorityPlayerGlobal() {
  const { error } = await supabase.rpc('reset_priority_player_global');
  if (error) throw error;
  return { success: true };
}

/**
 * Log priority player event to events table
 */
export async function logPriorityEvent(
  eventType: string,
  playerId: string,
  previousPriorityId?: string | null,
  notes?: string
) {
  const { error } = await supabase.from('priority_player_events').insert({
    event_type: eventType,
    player_id: playerId,
    previous_priority_id: previousPriorityId,
    notes,
  });
  if (error) throw error;
  return { success: true };
}

// ---------------------------------------------------------------------------
// Queue Operations
// ---------------------------------------------------------------------------

/**
 * Advance queue with idempotency protection
 * Uses p_expected_media_id to prevent double-advances
 */
export async function advanceQueue(playerId: string, expectedMediaId: string | null) {
  const { data, error } = await supabase.rpc('queue_next', {
    p_player_id: playerId,
    p_expected_media_id: expectedMediaId,
  });
  if (error) throw error;
  
  return {
    nextItem: data?.[0] || null,
    hasNext: data !== null && data.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Player Status Operations
// ---------------------------------------------------------------------------

/**
 * Update player status in DB
 */
export async function updatePlayerStatus(
  playerId: string,
  state?: string,
  progress?: number
) {
  const updateData: Record<string, unknown> = {
    last_updated: new Date().toISOString(),
  };
  
  if (state !== undefined) {
    updateData.state = state;
  }
  
  if (progress !== undefined) {
    updateData.progress = Math.min(1, Math.max(0, progress));
  }
  
  const { error } = await supabase
    .from('player_status')
    .update(updateData)
    .eq('player_id', playerId);
  
  if (error) throw error;
  return { success: true };
}

/**
 * Record player heartbeat
 */
export async function recordHeartbeat(playerId: string) {
  const { error } = await supabase.rpc('player_heartbeat', {
    p_player_id: playerId,
  });
  if (error) throw error;
  return { success: true };
}

// ---------------------------------------------------------------------------
// Event Logging
// ---------------------------------------------------------------------------

/**
 * Insert event into events table for Realtime broadcast
 */
export async function insertPlayerEvent(
  playerId: string,
  eventType: string,
  data?: Record<string, unknown>
) {
  const { error } = await supabase.from('events').insert({
    player_id: playerId,
    event_type: eventType,
    event_data: data || {},
  });
  if (error) throw error;
  return { success: true };
}
