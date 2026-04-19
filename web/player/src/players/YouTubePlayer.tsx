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

    // When loadVideoById replaces the current video, YouTube fires a transient
    // PAUSED event (the old video being stopped). If we let this reach the state
    // machine it transitions to 'paused', triggering Effect 4's
    // fadeOut().then(() => pause()) — which fires pauseVideo() on the NEW video
    // 2 s later and stalls it mid-playback.
    //
    // Fix: set this flag true before loadVideoById; clear it on BUFFERING or
    // PLAYING (the first real event from the new video). While true, suppress
    // PAUSED so the machine stays in 'loading' through the transition.
    const isLoadingNewVideoRef = useRef<boolean>(false);

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
        isLoadingNewVideoRef.current = false; // New video confirmed playing
        dispatch({ type: 'YOUTUBE_PLAYING' });
        onPlaying(); // Notifies parent to trigger fade-in if isAfterSkip
      } else if (ytState === YT_PAUSED) {
        // While isLoadingNewVideoRef is true we are mid-swap: the PAUSED event
        // is the old video being replaced, not a genuine pause. Dispatching it
        // would move the machine to 'paused', starting a 2 s fadeOut that calls
        // pauseVideo() on the new video once it starts playing. Suppress it.
        if (isLoadingNewVideoRef.current) return;
        dispatch({ type: 'YOUTUBE_PAUSED' });
      } else if (ytState === YT_BUFFERING) {
        isLoadingNewVideoRef.current = false; // New video started buffering — PAUSED now genuine
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
          // Existing player — load new video.
          // Set flag BEFORE loadVideoById so the transient PAUSED event fired
          // by YouTube when it stops the old video is suppressed (see onStateChange).
          isLoadingNewVideoRef.current = true;
          if (isAfterSkip) {
            ytPlayerRef.current.setVolume(0);
          } else {
            ytPlayerRef.current.setVolume(100);
          }
          ytPlayerRef.current.loadVideoById(videoId);

          // Belt-and-suspenders playVideo call after short delay
          // (YouTube sometimes fires PAUSED before autoplay kicks in)
          setTimeout(() => {
            ytPlayerRef.current?.playVideo?.();
          }, 500);
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
