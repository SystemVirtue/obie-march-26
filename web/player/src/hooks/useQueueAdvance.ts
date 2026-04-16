/**
 * useQueueAdvance — single consolidated queue advancement path
 *
 * Previously, App.tsx had THREE separate call sites for callPlayerControl({ action: 'ended' }):
 *   1. reportEndedAndNext()       — natural end / admin skip
 *   2. advanceToNext() in effect  — loading timeout / unexpected pause
 *   3. Idle recovery effect       — stuck idle detection
 *
 * All three are replaced by this single hook. The state machine guarantees
 * it only runs when phase === 'ending' && !inFlight, so double-advances are
 * structurally impossible.
 */

import { useCallback, useRef } from 'react';
import { callPlayerControl, type MediaItem } from '@shared/supabase-client';
import type { PlaybackAction, PlaybackPhase } from '../state/playbackMachine';
import { canAdvance, needsFadeOnAdvance, isErrorAdvance } from '../state/playbackMachine';

type UseQueueAdvanceArgs = {
  playerId: string;
  isSlavePlayer: boolean;
  dispatch: React.Dispatch<PlaybackAction>;
  /** Fade function — resolves when done */
  fadeOut: () => Promise<void>;
  /** Called with the new MediaItem when queue_next returns one */
  onNextMedia: (media: MediaItem) => void;
  /** Called when the queue is empty */
  onQueueEmpty: () => void;
};

export function useQueueAdvance({
  playerId,
  isSlavePlayer,
  dispatch,
  fadeOut,
  onNextMedia,
  onQueueEmpty,
}: UseQueueAdvanceArgs) {
  // Tracks the mediaId that triggered the last in-flight advance so we can
  // pass it as the idempotency key to queue_next.
  const advancingForMediaIdRef = useRef<string | null>(null);

  const advance = useCallback(
    async (state: PlaybackPhase) => {
      // Guard: slave players never drive queue progression
      if (isSlavePlayer) return;

      // Guard: state machine enforces this, but belt-and-suspenders
      if (!canAdvance(state)) return;

      // Mark in-flight immediately to block concurrent calls
      dispatch({ type: 'ADVANCE_IN_FLIGHT' });

      const mediaId = state.phase === 'ending' ? state.mediaId : null;
      advancingForMediaIdRef.current = mediaId;

      // Fade out for skips (not for natural ends or errors)
      if (needsFadeOnAdvance(state) && !isErrorAdvance(state)) {
        try {
          await fadeOut();
        } catch {
          // Non-fatal — continue with queue advance even if fade fails
        }
      }

      try {
        const result = await callPlayerControl({
          player_id: playerId,
          state: 'idle',
          progress: 1,
          action: 'ended',
          current_media_id: mediaId ?? undefined,
        });

        dispatch({ type: 'ADVANCE_COMPLETE' });

        if (result?.next_item) {
          const next = result.next_item;
          const nextMedia: MediaItem = {
            id: next.media_item_id,
            title: next.title ?? 'Unknown',
            artist: next.artist ?? 'Unknown',
            url: next.url,
            duration: next.duration ?? 0,
            source_id: '',
            source_type: 'youtube',
            thumbnail: null,
            fetched_at: new Date().toISOString(),
            metadata: {},
          };

          // Transition to loading with the new media ID.
          // isAfterSkip drives the fade-in behaviour in the player component.
          dispatch({
            type: 'QUEUE_NEXT_STARTED',
            mediaId: nextMedia.id,
            isAfterSkip: state.phase === 'ending' && state.reason === 'skip',
          });

          onNextMedia(nextMedia);
        } else {
          // Queue exhausted
          dispatch({ type: 'QUEUE_EXHAUSTED' });
          onQueueEmpty();
        }
      } catch (err) {
        console.error('[useQueueAdvance] queue_next failed:', err);
        // On error, reset to idle so the player doesn't get permanently stuck.
        // The auto-radio generator will refill the queue asynchronously.
        dispatch({ type: 'QUEUE_EXHAUSTED' });
        onQueueEmpty();
      } finally {
        advancingForMediaIdRef.current = null;
      }
    },
    [playerId, isSlavePlayer, dispatch, fadeOut, onNextMedia, onQueueEmpty]
  );

  return { advance };
}
