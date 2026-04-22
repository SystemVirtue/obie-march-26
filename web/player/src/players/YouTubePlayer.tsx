/**
 * YouTubePlayer — iframe mode player component
 *
 * Extracted from the monolithic App.tsx. Owns:
 *   - YouTube IFrame API lifecycle
 *   - onReady / onStateChange / onError event handling
 *   - Volume control (for fade in/out coordination)
 *   - Ref forwarding for external imperative control (load, pause, resume)
 *
 * Does NOT own:
 *   - Queue state
 *   - Supabase subscriptions
 *   - Admin command handling
 *   - State machine — it dispatches actions UP to the parent
 */

import { useEffect, useRef, forwardRef, useImperativeHandle, useCallback } from 'react';
import { extractYouTubeId } from '../utils/youtube';
import type { PlaybackAction } from '../state/playbackMachine';

// YouTube IFrame API state constants
export const YT_UNSTARTED  = -1;
export const YT_ENDED      =  0;
export const YT_PLAYING    =  1;
export const YT_PAUSED     =  2;
export const YT_BUFFERING  =  3;
export const YT_CUED       =  5;

// Error codes that mean the video can never be embedded — remove from library
const UNPLAYABLE_CODES = new Set([100, 101, 150]);

declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady: () => void;
  }
}

export type YouTubePlayerHandle = {
  /** Load a new video by URL. Pass isAfterSkip=true to start at vol=0 for fade-in. */
  loadVideo: (url: string, isAfterSkip: boolean) => void;
  pause: () => void;
  resume: () => void;
  setVolume: (vol: number) => void;
  getVolume: () => number;
  getPlayerState: () => number | null;
};

type YouTubePlayerProps = {
  /** Dispatches state machine actions */
  dispatch: React.Dispatch<PlaybackAction>;
  /** Called when PLAYING fires so parent can trigger fade-in if needed */
  onPlaying: () => void;
  /** Called when an unplayable video is detected so parent can remove it */
  onUnplayableVideo: (mediaId: string) => void;
  /** The current media ID (used for unplayable-video removal) */
  currentMediaId: string | null;
  /** Whether this player is visible */
  visible: boolean;
};

export const YouTubePlayer = forwardRef<YouTubePlayerHandle, YouTubePlayerProps>(
  function YouTubePlayer(
    { dispatch, onPlaying, onUnplayableVideo, currentMediaId, visible },
    ref
  ) {
    const containerRef  = useRef<HTMLDivElement>(null);
    const ytPlayerRef   = useRef<any>(null);
    const apiReadyRef   = useRef(false);
    const apiCallbacksRef = useRef({ dispatch, onPlaying, onUnplayableVideo, currentMediaId });

    // Keep callbacks stable across renders without recreating handlers
    useEffect(() => {
      apiCallbacksRef.current = { dispatch, onPlaying, onUnplayableVideo, currentMediaId };
    });

    // Track the timestamp of the last loadVideoById call so stale ENDED events
    // fired 2–3 s later by YouTube's internal buffering can be rejected.
    const lastLoadTimeRef = useRef<number>(0);
    const STALE_ENDED_GUARD_MS = 5_000;

    // ── YouTube IFrame API load ─────────────────────────────────────────────
    useEffect(() => {
      if (apiReadyRef.current) return;

      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(tag);

      window.onYouTubeIframeAPIReady = () => {
        apiReadyRef.current = true;
      };

      return () => {
        // Leave the tag — it's global and can't be safely removed
      };
    }, []);

    // ── YouTube player event handlers (stable via ref) ──────────────────────
    const onReady = useCallback(() => {
      // Player is ready — no state change needed; imperative calls can now be made
    }, []);

    const onStateChange = useCallback((event: { data: number }) => {
      const { dispatch, onPlaying } = apiCallbacksRef.current;
      const ytState = event.data;

      if (ytState === YT_PLAYING) {
        dispatch({ type: 'YOUTUBE_PLAYING' });
        onPlaying(); // Notifies parent to trigger fade-in if isAfterSkip
      } else if (ytState === YT_PAUSED) {
        // Note: YouTube fires PAUSED transitorily during load before playVideo() runs.
        // The state machine handles this — YOUTUBE_PAUSED from LOADING state is ignored,
        // so auto-play attempts (handled by the parent's loading guard) won't be blocked.
        dispatch({ type: 'YOUTUBE_PAUSED' });
      } else if (ytState === YT_BUFFERING) {
        dispatch({ type: 'YOUTUBE_BUFFERING' });
      } else if (ytState === YT_ENDED) {
        // Reject stale ENDED events from the previous video
        const msSinceLoad = Date.now() - lastLoadTimeRef.current;
        if (msSinceLoad < STALE_ENDED_GUARD_MS) {
          console.warn(`[YouTubePlayer] Ignoring stale ENDED event (${msSinceLoad}ms after load)`);
          return;
        }
        dispatch({ type: 'YOUTUBE_ENDED' });
      }
    }, []);

    const onError = useCallback(async (event: { data: number }) => {
      const { currentMediaId, onUnplayableVideo } = apiCallbacksRef.current;
      const code = event.data;

      // Remove permanently unplayable videos from queue + playlists
      if (UNPLAYABLE_CODES.has(code) && currentMediaId) {
        console.warn(`[YouTubePlayer] Unplayable video (code ${code}), removing from library`);
        onUnplayableVideo(currentMediaId);
      }

      // Always dispatch error to advance the queue
      dispatch({ type: 'YOUTUBE_ERROR', code });
    }, []);

    // ── Imperative handle ───────────────────────────────────────────────────
    useImperativeHandle(ref, () => ({
      loadVideo(url: string, isAfterSkip: boolean) {
        const videoId = extractYouTubeId(url);
        if (!videoId) {
          console.error('[YouTubePlayer] Could not extract YouTube ID from:', url);
          return;
        }

        lastLoadTimeRef.current = Date.now();

        if (ytPlayerRef.current?.loadVideoById) {
          // Existing player — load new video
          if (isAfterSkip) {
            ytPlayerRef.current.setVolume(0);
          } else {
            ytPlayerRef.current.setVolume(100);
          }
          ytPlayerRef.current.loadVideoById(videoId);

          // Immediate playVideo call to ensure auto-play
          ytPlayerRef.current?.playVideo?.();

          // Fallback: if still paused after 1s, try again
          setTimeout(() => {
            const state = ytPlayerRef.current?.getPlayerState?.();
            if (state === 2) { // YT_PAUSED
              console.warn('[YouTubePlayer] Video still paused after 1s, retrying playVideo()');
              ytPlayerRef.current?.playVideo?.();
            }
          }, 1000);

          return;
        }

        // First load — create the player
        if (!containerRef.current || !apiReadyRef.current) {
          console.error('[YouTubePlayer] Cannot create player: container or API not ready');
          return;
        }

        ytPlayerRef.current = new window.YT.Player(containerRef.current, {
          videoId,
          playerVars: {
            autoplay:        0,  // Don't autoplay on creation (browser policy)
            controls:        0,  // Hide controls
            disablekb:       1,  // No keyboard shortcuts
            modestbranding:  1,  // Minimal YouTube branding
            rel:             0,  // No related videos
            iv_load_policy:  3,  // No annotations
          },
          events: {
            onReady,
            onStateChange,
            onError,
          },
        });
      },

      pause() {
        ytPlayerRef.current?.pauseVideo?.();
      },

      resume() {
        ytPlayerRef.current?.playVideo?.();
      },

      setVolume(vol: number) {
        ytPlayerRef.current?.setVolume?.(Math.max(0, Math.min(100, vol)));
      },

      getVolume() {
        if (!ytPlayerRef.current?.getVolume) return 100;
        return ytPlayerRef.current.getVolume();
      },

      getPlayerState() {
        if (!ytPlayerRef.current?.getPlayerState) return null;
        return ytPlayerRef.current.getPlayerState();
      },
    }), [onReady, onStateChange, onError]);

    return (
      <div
        ref={containerRef}
        id="yt-player"
        className="w-full h-full"
        style={{ display: visible ? 'block' : 'none' }}
      />
    );
  }
);
