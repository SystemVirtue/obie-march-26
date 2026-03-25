import { useCallback, useEffect } from 'react';
import { callPlayerControl, type PlayerStatus } from '@shared/supabase-client';

type UsePlayerHeartbeatArgs = {
  isSlavePlayer: boolean;
  playerId: string;
};

export function usePlayerHeartbeat({ isSlavePlayer, playerId }: UsePlayerHeartbeatArgs) {
  // Send a heartbeat every 30 s so players.status stays 'online' and the admin
  // Connected Devices panel can detect disconnects. Both priority and slave
  // players heartbeat — the server-side player_heartbeat() handles multi-device.
  useEffect(() => {
    if (!playerId) return;
    const send = () => callPlayerControl({ player_id: playerId, action: 'heartbeat' })
      .catch(e => console.warn('[player] heartbeat failed', e));
    send(); // immediate on mount
    const id = setInterval(send, 30_000);
    return () => clearInterval(id);
  }, [playerId]);

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
