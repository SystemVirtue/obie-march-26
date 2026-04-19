/**
 * usePlayerHeartbeat — keepalive, priority self-demotion, and offline detection.
 *
 * Priority assignment is now STICKY — auto-reclaim has been removed.
 * A slave player will NEVER silently steal master. The only way to
 * change master is:
 *   1. Admin clicks "Reset Priority Player" (sets priority_selection_pending).
 *   2. A player's user clicks "Yes" in the claim modal (calls claim_priority).
 *
 * This hook handles:
 *   - 30s keepalive heartbeats.
 *   - Master self-demotion: detects when the DB no longer lists this player
 *     as master (e.g. another player just claimed it) and calls onPriorityLost.
 *   - Pending detection: when the admin triggers a reset, slaves see
 *     priority_selection_pending=true and get onPrioritySelectionPending called
 *     so the UI can show the claim modal. A per-master-id decline guard prevents
 *     the modal from re-appearing after the user clicks "No".
 *   - Master-offline detection: reports isMasterOffline so slave UI can display
 *     "SLAVE — MASTER OFFLINE" when the designated master has gone stale.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase, callPlayerControl, type PlayerStatus } from '@shared/supabase-client';
import { HEARTBEAT_INTERVAL_MS } from '../../../shared/constants';
import type { RealtimeChannel } from '@supabase/supabase-js';

type UsePlayerHeartbeatArgs = {
  isSlavePlayer: boolean;
  playerId: string;
  /** Called when this player has lost priority (another player claimed master) */
  onPriorityLost?: () => void;
  /**
   * Called when priority_selection_pending becomes true (admin triggered reset).
   * Receives the current master player ID so the caller can record which master
   * the user declines, preventing re-triggers on subsequent heartbeats.
   * Fires at most once per master-id so repeated heartbeats don't re-show the
   * modal after the user has declined for the current master.
   */
  onPrioritySelectionPending?: (masterId: string) => void;
  /**
   * Ref set by the caller to the master player ID that the user most recently
   * declined to claim. The hook reads this ref to suppress duplicate modal triggers.
   */
  declinedClaimForRef: React.RefObject<string | null>;
};

export function usePlayerHeartbeat({
  isSlavePlayer,
  playerId,
  onPriorityLost,
  onPrioritySelectionPending,
  declinedClaimForRef,
}: UsePlayerHeartbeatArgs) {
  const prevStateRef = useRef<PlayerStatus['state'] | undefined>(undefined);
  const channelRef   = useRef<RealtimeChannel | null>(null);
  const isSlaveRef   = useRef(isSlavePlayer);
  const [isMasterOffline, setIsMasterOffline] = useState(false);

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

      // ── Read priority state after every heartbeat ─────────────────────────
      let priorityPlayerId: string | null = null;
      let selectionPending = false;
      let masterStatus: string | null = null;

      try {
        const { data: row } = await supabase
          .from('players')
          .select('priority_player_id, priority_selection_pending')
          .eq('id', playerId)
          .single();
        priorityPlayerId = (row as any)?.priority_player_id  ?? null;
        selectionPending = (row as any)?.priority_selection_pending ?? false;
      } catch (e) {
        console.warn('[Player] Heartbeat DB check failed:', e);
        return;
      }

      // ── Master-offline detection (slave only) ─────────────────────────────
      // Fetch the master player's online status so the UI can show
      // "SLAVE — MASTER OFFLINE" when the designated master has gone stale.
      if (isSlaveRef.current && priorityPlayerId && priorityPlayerId !== playerId) {
        try {
          const { data: masterRow } = await supabase
            .from('players')
            .select('status')
            .eq('id', priorityPlayerId)
            .single();
          masterStatus = (masterRow as any)?.status ?? null;
        } catch {
          // Non-fatal — leave masterStatus null
        }
        setIsMasterOffline(masterStatus === 'offline');
      } else {
        setIsMasterOffline(false);
      }

      if (!isSlaveRef.current) {
        // ── Master self-demotion ──────────────────────────────────────────────
        // Another player has claimed master (or admin force-assigned it).
        // Detect this so the old master immediately stops driving the queue.
        const stillMaster = priorityPlayerId === playerId;
        if (!stillMaster) {
          console.log('[Player] Lost priority — demoting to slave');
          onPriorityLost?.();
        }
        return;
      }

      // ── Pending-claim notification (slave only) ───────────────────────────
      // When the admin resets priority, priority_selection_pending becomes true.
      // We show the claim modal ONCE per master-id — if the user already
      // declined for the current master, we stay silent until a new master is
      // designated (i.e. someone claims it and a fresh reset happens).
      if (selectionPending && priorityPlayerId !== null) {
        const alreadyDeclinedForThisMaster =
          declinedClaimForRef.current === priorityPlayerId;

        if (!alreadyDeclinedForThisMaster) {
          onPrioritySelectionPending?.(priorityPlayerId);
        }
      }
    };

    send(); // immediate on mount
    const id = setInterval(send, HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(id);
  }, [playerId, onPriorityLost, onPrioritySelectionPending, declinedClaimForRef]);

  // ── Realtime subscription for instant priority change detection ────────────
  // The players table is in the Realtime publication (re-added in migration
  // 20260419000003). This fires immediately when the admin triggers a reset or
  // when another player claims master — no need to wait for the next heartbeat.
  useEffect(() => {
    if (!playerId) return;

    const channel = supabase
      .channel(`priority-watch:${playerId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'players', filter: `id=eq.${playerId}` },
        (payload) => {
          const row = payload.new as any;
          const newPriorityId: string | null = row.priority_player_id ?? null;
          const nowPending: boolean = row.priority_selection_pending ?? false;

          if (!isSlaveRef.current) {
            // Master: check if we've been demoted
            if (newPriorityId !== playerId) {
              console.log('[Player] Realtime: lost priority — demoting to slave');
              onPriorityLost?.();
            }
            return;
          }

          // Slave: show claim modal if pending is now true
          if (nowPending && newPriorityId !== null) {
            const alreadyDeclined = declinedClaimForRef.current === newPriorityId;
            if (!alreadyDeclined) {
              console.log('[Player] Realtime: priority selection pending — showing claim modal');
              onPrioritySelectionPending?.(newPriorityId);
            }
          }

          // Slave: pending cleared (someone else claimed) — hide modal if open
          if (!nowPending && newPriorityId !== playerId) {
            // The claim has been made by another player; no action needed here.
            // The next heartbeat will confirm slave status.
          }
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [playerId, onPriorityLost, onPrioritySelectionPending, declinedClaimForRef]);

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

  return { reportStatus, isMasterOffline };
}
