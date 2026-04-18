/**
 * usePlayerHeartbeat — keepalive + priority auto-reclaim
 *
 * Changes from original:
 *   - After each heartbeat, slave players check whether priority_player_id
 *     was just cleared by the DB failover trigger (dead master). If so,
 *     they immediately attempt register_session to reclaim master.
 *   - onPriorityReclaimed callback lets App.tsx flip isSlavePlayer→false
 *     and re-enable queue progression without a page reload.
 *   - Session ID is stable across heartbeat cycles (stored in a ref) so
 *     register_session re-attempts are idempotent.
 */

import { useCallback, useEffect, useRef } from 'react';
import { supabase, callPlayerControl, type PlayerStatus } from '@shared/supabase-client';
import { HEARTBEAT_INTERVAL_MS } from '../../../shared/constants';
import type { RealtimeChannel } from '@supabase/supabase-js';

type UsePlayerHeartbeatArgs = {
  isSlavePlayer: boolean;
  playerId: string;
  /** Stable session ID for this browser tab — must be the same UUID used in register_session */
  sessionId: string;
  /** Called when a slave player successfully reclaims master after failover */
  onPriorityReclaimed?: () => void;
  /** Called when the master player detects it has lost priority (e.g. after Reset Priority Player) */
  onPriorityLost?: () => void;
};

export function usePlayerHeartbeat({ isSlavePlayer, playerId, sessionId, onPriorityReclaimed, onPriorityLost }: UsePlayerHeartbeatArgs) {
  const prevStateRef    = useRef<PlayerStatus['state'] | undefined>(undefined);
  const channelRef      = useRef<RealtimeChannel | null>(null);
  const isSlaveRef      = useRef(isSlavePlayer);
  const reclaimInFlight = useRef(false);

  // Keep isSlaveRef in sync so the heartbeat closure always sees current value
  useEffect(() => { isSlaveRef.current = isSlavePlayer; }, [isSlavePlayer]);

  useEffect(() => {
    if (!playerId) return;

    const send = async () => {
      try {
        await callPlayerControl({ player_id: playerId, action: 'heartbeat' });
      } catch (e) {
        console.warn('[Player] Heartbeat failed:', e);
        return;
      }

      // ── Priority check after every heartbeat ─────────────────────────────
      // Read the DB once per heartbeat cycle.  Both the master self-demotion
      // check and the slave reclaim check need the same row, so we fetch it
      // once and branch on isSlaveRef.current below.
      let priorityPlayerId: string | null = null;
      let prioritySessionId: string | null = null;
      try {
        const { data: row } = await supabase
          .from('players')
          .select('priority_player_id, priority_session_id')
          .eq('id', playerId)
          .single();
        priorityPlayerId  = (row as any)?.priority_player_id  ?? null;
        prioritySessionId = (row as any)?.priority_session_id ?? null;
      } catch (e) {
        console.warn('[Player] Heartbeat DB check failed:', e);
        return;
      }

      if (!isSlaveRef.current) {
        // ── Master self-demotion ────────────────────────────────────────────
        // The admin may have clicked "Reset Priority Player", which clears
        // priority_player_id in the DB.  A new player will then claim master.
        // We detect this here so the OLD master immediately stops driving the
        // queue and shows the SLAVE watermark — no page reload needed.
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
      // Migration 000003/000004 clears priority_player_id when the master goes
      // offline; migration 000005 also clears it on an explicit reset.
      if (reclaimInFlight.current) return;

      try {
        // Master pointer cleared → try to claim it
        if (priorityPlayerId !== null) return;

        reclaimInFlight.current = true;
        console.log('[Player] Priority player gone — attempting reclaim...');

        const result = await callPlayerControl({
          player_id:  playerId,
          action:     'register_session',
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
  }, [playerId, onPriorityReclaimed]);

  // Broadcast channel for live progress reports (priority players only)
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
    if (isSlavePlayer) {
      console.log('[Slave Player] Skipping status report:', { state, progress });
      return;
    }

    const isProgressOnly = state === prevStateRef.current && progress !== undefined;

    if (isProgressOnly && channelRef.current) {
      // Pure progress update — broadcast without a DB write
      channelRef.current.send({
        type: 'broadcast',
        event: 'progress',
        payload: { progress, state },
      }).catch(() => {});
      return;
    }

    // State change — write to DB
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
  }, [isSlavePlayer, playerId]);

  return { reportStatus };
}
