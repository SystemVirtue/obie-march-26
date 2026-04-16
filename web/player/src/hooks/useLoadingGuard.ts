/**
 * useLoadingGuard — auto-skip for videos that fail to start
 *
 * Replaces two tangled mechanisms in App.tsx:
 *   1. loadingTimeoutRef + 6-second setTimeout that checked YouTube player state
 *   2. unexpectedPauseTimeoutRef + 3-second setTimeout for pre-play pauses
 *
 * Both checked isEndingRef to avoid double-advances, which was fragile.
 * This hook uses the state machine phase instead — if phase !== 'loading' or
 * 'buffering' when the timer fires, the dispatch is simply a no-op because
 * YOUTUBE_ERROR from idle/ending/playing isn't a valid transition.
 */

import { useEffect, useRef } from 'react';
import type { PlaybackPhase, PlaybackAction } from '../state/playbackMachine';

type UseLoadingGuardArgs = {
  playback: PlaybackPhase;
  dispatch: React.Dispatch<PlaybackAction>;
  /** Check live YouTube player state — returns YT state int or null */
  getYTPlayerState: () => number | null;
  /** Report correct state to DB when Realtime dropped the 'playing' event */
  reportPlaying: () => void;
};

/** YouTube player state constants */
const YT_PLAYING   = 1;
const YT_BUFFERING = 3;

const LOADING_TIMEOUT_MS        = 8_000;  // 8s before we check YouTube and potentially skip
const BUFFERING_EXTENSION_MS    = 4_000;  // +4s if still buffering (12s total)

export function useLoadingGuard({
  playback,
  dispatch,
  getYTPlayerState,
  reportPlaying,
}: UseLoadingGuardArgs) {
  const loadingTimerRef   = useRef<number | null>(null);
  const extensionTimerRef = useRef<number | null>(null);

  const clearAll = () => {
    if (loadingTimerRef.current !== null) {
      clearTimeout(loadingTimerRef.current);
      loadingTimerRef.current = null;
    }
    if (extensionTimerRef.current !== null) {
      clearTimeout(extensionTimerRef.current);
      extensionTimerRef.current = null;
    }
  };

  useEffect(() => {
    clearAll();

    if (playback.phase !== 'loading' && playback.phase !== 'buffering') return;

    loadingTimerRef.current = window.setTimeout(() => {
      loadingTimerRef.current = null;

      const ytState = getYTPlayerState();

      if (ytState === YT_PLAYING) {
        // YouTube is playing but Realtime dropped the 'playing' event.
        // Correct the DB and let the machine stay in its current state —
        // YOUTUBE_PLAYING dispatch will come from the onPlayerStateChange handler
        // once YouTube fires it, which already happened. Just fix the DB.
        console.warn('[useLoadingGuard] Loading timeout fired but YouTube IS PLAYING — Realtime dropped event, correcting DB');
        reportPlaying();
        return;
      }

      if (ytState === YT_BUFFERING) {
        // Still buffering — extend by 4 seconds before giving up
        console.warn('[useLoadingGuard] Loading timeout: still buffering, extending by 4s');
        extensionTimerRef.current = window.setTimeout(() => {
          extensionTimerRef.current = null;
          const stillBuffering = getYTPlayerState() === YT_BUFFERING;
          const reason = stillBuffering
            ? 'Buffering for 12 seconds total'
            : 'Failed to load after 12 seconds';
          console.error(`[useLoadingGuard] Auto-skip: ${reason}`);
          dispatch({ type: 'YOUTUBE_ERROR', code: -1 });
        }, BUFFERING_EXTENSION_MS);
        return;
      }

      // Not playing, not buffering — the video failed to load
      console.error('[useLoadingGuard] Auto-skip: video stuck in loading state after 8s');
      dispatch({ type: 'YOUTUBE_ERROR', code: -1 });
    }, LOADING_TIMEOUT_MS);

    return clearAll;
  }, [playback.phase, dispatch, getYTPlayerState, reportPlaying]);
}
