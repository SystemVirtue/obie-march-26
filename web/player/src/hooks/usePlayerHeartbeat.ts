import { useCallback } from 'react';
import { callPlayerControl, type PlayerStatus } from '@shared/supabase-client';

type UsePlayerHeartbeatArgs = {
  isSlavePlayer: boolean;
  playerId: string;
};

export function usePlayerHeartbeat({ isSlavePlayer, playerId }: UsePlayerHeartbeatArgs) {
  const reportStatus = useCallback(async (state: PlayerStatus['state'], progress?: number) => {
    if (isSlavePlayer) {
      console.log('[Slave Player] Skipping status report:', { state, progress });
      return;
    }

    console.log('[Player] Reporting status:', { state, progress });
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
