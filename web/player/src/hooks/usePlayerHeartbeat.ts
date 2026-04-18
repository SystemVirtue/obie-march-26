/**
 * usePlayerHeartbeat — keepalive + priority auto-reclaim
 *
 * Changes:
 *   - Accepts sessionId parameter for this tab's session
 *   - After each heartbeat, checks if priority status changed in DB
 *   - Master detects if it lost priority (e.g. admin reset)
 *   - Slave auto-reclaims if priority_player_id was cleared (master died)
 *   - onPriorityReclaimed/onPriorityLost callbacks for immediate state sync
 */

import { useCallback, useEffect, useRef } from 'react';
import { supabase, callPlayerControl, type PlayerStatus } from '@shared/supabase-client';
import { HEARTBEAT_INTERVAL_MS } from '../../../shared/constants';
import type { RealtimeChannel } from '@supabase/supabase-js';

type UsePlayerHeartbeatArgs = {
  isSlavePlayer: boolean;
  isSyncing?: boolean;
  playerId: string;
  /** Stable session ID for this browser tab — must be the same UUID used in register_session */
  sessionId?: string;
  /** Called when a slave player successfully reclaims master after failover */
  onPriorityReclaimed?: () => void;
  /** Called when the master player detects it has lost priority */
  onPriorityLost?: () => void;
};

export function usePlayerHeartbeat({ isSlavePlayer, isSyncing = false, playerId, sessionId, onPriorityReclaimed, onPriorityLost }: UsePlayerHeartbeatArgs) {
  const prevStateRef = useRef<PlayerStatus['state'] | undefined>(undefined);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const isSlaveRef = useRef(isSlavePlayer);
  const reclaimInFlight = useRef(false);

  // Keep isSlaveRef in sync so the heartbeat closure always sees current value
  useEffect(() => { isSlaveRef.current = isSlavePlayer; }, [isSlavePlayer]);

  // Send a heartbeat every 30 s so players.status stays 'online'. After each
  // heartbeat, check if priority status changed in DB — both master self-demotion
  // and slave auto-reclaim are handled here.
  useEffect(() => {
    if (!playerId) return;

    const send = async () => {
      try {
        await callPlayerControl({ player_id: playerId, action: 'heartbeat' });
      } catch (e) {
        console.warn('[player] heartbeat failed', e);
        return;
      }

      // ── Priority check after every heartbeat ─────────────────────────────
      // Read the DB once per heartbeat cycle. Both the master self-demotion
      // check and the slave reclaim check need the same row.
      let priorityPlayerId: string | null = null;
      let prioritySessionId: string | null = null;
      try {
        const { data: row } = await supabase
          .from('players')
          .select('priority_player_id, priority_session_id')
          .eq('id', playerId)
          .single();
        priorityPlayerId = (row as any)?.priority_player_id ?? null;
        prioritySessionId = (row as any)?.priority_session_id ?? null;
      } catch (e) {
        console.warn('[player] heartbeat DB check failed:', e);
        return;
      }

      if (!isSlaveRef.current) {
        // ── Master self-demotion ────────────────────────────────────────────
        // Admin may have clicked "Reset Priority Player", clearing
        // priority_player_id in the DB. Detect here so this player immediately
        // stops driving the queue and shows SLAVE watermark — no reload needed.
        const stillMaster =
          priorityPlayerId === playerId &&
          (prioritySessionId === sessionId || prioritySessionId === null);

        if (!stillMaster) {
          console.log('[Player] Lost priority — demoting to slave');
          onPriorityLost?.();
        }
        return;
      }

      // ── Slave auto-reclaim ────────────────────────────────────────────────
      // Only attempt if we're currently a slave and no reclaim is in-flight.
      // When the master goes offline, the DB failover trigger clears
      // priority_player_id. We detect this and attempt to reclaim.
      if (reclaimInFlight.current) return;

      try {
        // Master pointer cleared → try to claim it
        if (priorityPlayerId !== null) return;

        reclaimInFlight.current = true;
        console.log('[Player] Priority player gone — attempting reclaim...');

        const result = await callPlayerControl({
          player_id: playerId,
          action: 'register_session',
          session_id: sessionId,
        });

        if (result.is_priority) {
          console.log('[Player] ✓ Reclaimed master after priority player died');
          onPriorityReclaimed?.();
        }
      } catch (e) {
        console.warn('[Player] Reclaim attempt failed:', e);
      } finally {
        reclaimInFlight.current = false;
      }
    };

    send(); // immediate on mount
    const id = setInterval(send, HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(id);
  }, [playerId, sessionId, onPriorityReclaimed, onPriorityLost]);

  // Establish a broadcast channel for sending live progress without DB writes.
  useEffect(() => {
    if (isSlavePlayer) return;

    const channel = supabase
      .channel(`player-broadcast:${playerId}`)
      .subscribe();
    channelRef.current = channel;

    return () => {
      supabase.removeChannel(channel);
      channelRef.current = null;
    };
  }, [isSlavePlayer, playerId]);

  const reportStatus = useCallback(async (state: PlayerStatus['state'], progress?: number) => {
    // Skip reporting if slave player
    if (isSlavePlayer) {
      console.log('[Slave Player] Skipping status report:', { state, progress });
      return;
    }

    // Skip reporting if currently syncing (preventing intermediate progress from polluting Realtime)
    if (isSyncing) {
      console.log('[Sync] Skipping status report during slave sync:', { state, progress });
      return;
    }

    const isProgressOnly = state === prevStateRef.current && progress !== undefined;

    if (isProgressOnly && channelRef.current) {
      // Pure progress heartbeat — broadcast without hitting the DB or WAL.
      channelRef.current.send({
        type: 'broadcast',
        event: 'progress',
        payload: { progress, state },
      }).catch(() => {});
      return;
    }

    // State change — write to DB so it persists and admin commands are visible.
    console.log('[Player] Reporting status:', { state, progress });
    prevStateRef.current = state;
    try {
      await callPlayerControl({
        player_id: playerId,
        state,
        progress,
        action: 'update',
      });
    } catch (error) {
      console.error('[Player] Failed to report status:', error);
    }
  }, [isSlavePlayer, isSyncing, playerId]);

  return { reportStatus };
}
