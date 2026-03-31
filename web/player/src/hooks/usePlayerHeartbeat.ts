import { useCallback, useEffect, useRef } from 'react';
import { supabase, callPlayerControl, type PlayerStatus } from '@shared/supabase-client';
import type { RealtimeChannel } from '@supabase/supabase-js';

type UsePlayerHeartbeatArgs = {
  isSlavePlayer: boolean;
  playerId: string;
};

export function usePlayerHeartbeat({ isSlavePlayer, playerId }: UsePlayerHeartbeatArgs) {
  const prevStateRef = useRef<PlayerStatus['state'] | undefined>(undefined);
  const channelRef = useRef<RealtimeChannel | null>(null);

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
    if (isSlavePlayer) {
      console.log('[Slave Player] Skipping status report:', { state, progress });
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
  }, [isSlavePlayer, playerId]);

  return { reportStatus };
}
