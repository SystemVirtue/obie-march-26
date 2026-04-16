/**
 * usePlayerRealtime — consolidated Supabase Realtime subscription
 *
 * Previously, App.tsx had a 120-line useEffect that interleaved:
 *   - Realtime subscription setup
 *   - applyStatus() logic (state transitions + media change detection)
 *   - 10-second polling fallback with retry
 *   - fadeOut / fadeIn calls (side effects inside a subscription callback!)
 *
 * This hook separates concerns:
 *   - Subscription management stays here
 *   - State transitions go through dispatch() to the state machine
 *   - The parent component reacts to state changes via useEffect on `playback`
 *
 * Polling strategy: Realtime as fast path + 30-second polling as baseline.
 * Simpler and more predictable than the previous "10s silence → one-shot poll"
 * that could leave the player stuck if the retry also fired during a gap.
 */

import { useEffect, useRef, useCallback } from 'react';
import {
  supabase,
  subscribeToPlayerStatus,
  subscribeToPlayerSettings,
  type PlayerStatus,
  type PlayerSettings,
} from '@shared/supabase-client';
import type { PlaybackAction } from '../state/playbackMachine';

type UsePlayerRealtimeArgs = {
  playerId: string;
  identityReady: boolean;
  activePlayerId: string | null;
  /** Dispatch to the playback state machine */
  dispatch: React.Dispatch<PlaybackAction>;
  /** Called when player_status updates with the raw status */
  onStatusUpdate: (status: PlayerStatus) => void;
  /** Called when player_settings update */
  onSettingsUpdate: (settings: PlayerSettings) => void;
};

const POLL_INTERVAL_MS = 30_000;

export function usePlayerRealtime({
  playerId,
  identityReady,
  activePlayerId,
  dispatch,
  onStatusUpdate,
  onSettingsUpdate,
}: UsePlayerRealtimeArgs) {
  const lastKnownStateRef = useRef<PlayerStatus['state'] | null>(null);
  const pollTimerRef = useRef<number | null>(null);

  // ── Fetch helper used by both subscription and poll ─────────────────────
  const fetchStatus = useCallback(async (): Promise<PlayerStatus | null> => {
    const { data, error } = await supabase
      .from('player_status')
      .select('*, current_media:media_items(*)')
      .eq('player_id', playerId)
      .single();

    if (error || !data) {
      console.error('[usePlayerRealtime] Poll fetch failed:', error);
      return null;
    }
    return data as PlayerStatus;
  }, [playerId]);

  // ── Map raw DB status → state machine actions ────────────────────────────
  // This is the canonical place where DB state drives the machine.
  // It's called from both Realtime and polling paths.
  const applyStatus = useCallback(
    (status: PlayerStatus) => {
      const prevState = lastKnownStateRef.current;
      const newState = status.state;
      lastKnownStateRef.current = newState;

      // Notify parent of raw status (for UI display, media item, etc.)
      onStatusUpdate(status);

      // Map DB state transitions → machine actions
      // Only dispatch on genuine state changes to avoid re-entrancy
      if (prevState === newState) return;

      if (newState === 'playing' && prevState === 'paused') {
        dispatch({ type: 'ADMIN_RESUME' });
      } else if (newState === 'paused' && prevState === 'playing') {
        dispatch({ type: 'ADMIN_PAUSE' });
      } else if (newState === 'idle' && (prevState === 'playing' || prevState === 'paused')) {
        // Admin set to idle while playing = skip signal
        dispatch({ type: 'ADMIN_SKIP' });
      }
      // loading/playing transitions are driven by player events, not DB state
    },
    [dispatch, onStatusUpdate]
  );

  // ── Baseline polling (30 s) ──────────────────────────────────────────────
  // Runs regardless of Realtime health. If Realtime is working, the poll
  // just confirms what we already know (no harm). If Realtime has silently
  // dropped events, the poll self-heals within 30 seconds.
  useEffect(() => {
    if (!identityReady || !activePlayerId) return;

    const poll = async () => {
      const status = await fetchStatus();
      if (status) {
        console.log('[usePlayerRealtime] Poll tick — state:', status.state);
        applyStatus(status);
      }
    };

    pollTimerRef.current = window.setInterval(poll, POLL_INTERVAL_MS);

    return () => {
      if (pollTimerRef.current !== null) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [identityReady, activePlayerId, fetchStatus, applyStatus]);

  // ── Realtime subscription ────────────────────────────────────────────────
  useEffect(() => {
    if (!identityReady || !activePlayerId) return;

    const subscription = subscribeToPlayerStatus(playerId, applyStatus);

    return () => {
      subscription.unsubscribe();
    };
  }, [identityReady, activePlayerId, playerId, applyStatus]);

  // ── Settings subscription ────────────────────────────────────────────────
  useEffect(() => {
    if (!identityReady || !activePlayerId) return;

    const subscription = subscribeToPlayerSettings(playerId, onSettingsUpdate);

    return () => {
      subscription.unsubscribe();
    };
  }, [identityReady, activePlayerId, playerId, onSettingsUpdate]);
}
