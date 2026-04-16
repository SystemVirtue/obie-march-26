# Obie Player — Refactoring Brief for Claude Code

## Context

This is the `revision` branch of Obie Jukebox (obie-march-26). A senior review 
identified that `web/player/src/App.tsx` (1,637 lines) is a God Component with:

- 17 `useRef` race-condition guards instead of a proper state machine
- 3 parallel queue advance code paths that can double-fire
- Stale YouTube ENDED events causing double queue_next calls
- Queue position corruption after 1-2 days of operation
- YTM Desktop (~300 lines), local video, and iframe logic all interleaved

## Your Task

Implement the refactored architecture described below. All new file content is 
provided verbatim — write it exactly as specified. Do not invent, do not improvise 
on the architecture. The logic has been carefully designed to eliminate the race 
conditions.

## Files to CREATE (new)

### 1. `web/player/src/state/playbackMachine.ts`

```typescript
/**
 * Obie Player — Playback State Machine
 *
 * Replaces the 17 scattered useRef guards in App.tsx with a single, explicit
 * state machine. Impossible transitions are structurally unreachable — no more
 * isEndingRef, recentlyLoadedRef, videoHasPlayedRef, adminPausedRef, etc.
 *
 * State diagram:
 *
 *   IDLE ──────────────────────────────────────────────────────► LOADING
 *                                                                    │
 *   (queue_next returns empty)                           (new media assigned)
 *        ▲                                                           │
 *        │                                              ┌────────────▼──────────────┐
 *        └──── ENDING ◄──────────────────────────── PLAYING ◄──── BUFFERING        │
 *                 ▲           (ended/skip/error)      │   ▲                         │
 *                 │                                   │   └──────── PAUSED ─────────┘
 *                 └───────────────────────────────────┘
 *
 * Key rules:
 *  - YOUTUBE_ENDED is ONLY valid from PLAYING. Dropped if in LOADING/ENDING/IDLE.
 *  - ADMIN_SKIP transitions to ENDING(reason:'skip') from PLAYING or PAUSED only.
 *  - YOUTUBE_PLAYING clears the in-flight guard (replaces isEndingRef reset).
 *  - LOADING has a `mediaId` field — stale events from previous media are rejected
 *    by comparing mediaId at the call site.
 */

export type PlaybackPhase =
  | { phase: 'idle' }
  | { phase: 'loading';   mediaId: string; isAfterSkip: boolean }
  | { phase: 'buffering'; mediaId: string }
  | { phase: 'playing';   mediaId: string }
  | { phase: 'paused';    mediaId: string; pausedBy: 'admin' | 'user' }
  | { phase: 'ending';    mediaId: string; reason: 'natural' | 'skip' | 'error'; inFlight: boolean }

export type PlaybackAction =
  | { type: 'QUEUE_NEXT_STARTED';  mediaId: string; isAfterSkip?: boolean }
  | { type: 'QUEUE_EXHAUSTED' }
  | { type: 'YOUTUBE_PLAYING' }
  | { type: 'YOUTUBE_BUFFERING' }
  | { type: 'YOUTUBE_PAUSED' }
  | { type: 'YOUTUBE_ENDED' }
  | { type: 'YOUTUBE_ERROR';       code: number }
  | { type: 'ADMIN_PAUSE' }
  | { type: 'ADMIN_RESUME' }
  | { type: 'ADMIN_SKIP' }
  | { type: 'ADVANCE_IN_FLIGHT' }
  | { type: 'ADVANCE_COMPLETE' }
  | { type: 'RESET' }

export function playbackReducer(
  state: PlaybackPhase,
  action: PlaybackAction
): PlaybackPhase {
  switch (action.type) {
    case 'QUEUE_NEXT_STARTED':
      return { phase: 'loading', mediaId: action.mediaId, isAfterSkip: action.isAfterSkip ?? false };

    case 'QUEUE_EXHAUSTED':
      return { phase: 'idle' };

    case 'YOUTUBE_PLAYING':
      if (state.phase === 'idle' || state.phase === 'ending') return state;
      return { phase: 'playing', mediaId: state.mediaId };

    case 'YOUTUBE_BUFFERING':
      if (state.phase === 'loading' || state.phase === 'playing' || state.phase === 'paused') {
        return { phase: 'buffering', mediaId: state.mediaId };
      }
      return state;

    case 'YOUTUBE_PAUSED':
      if (state.phase === 'playing' || state.phase === 'buffering') {
        return { phase: 'paused', mediaId: state.mediaId, pausedBy: 'user' };
      }
      return state;

    case 'YOUTUBE_ENDED':
      // CRITICAL: only valid from PLAYING — drops stale ENDED events from previous video
      if (state.phase !== 'playing') return state;
      return { phase: 'ending', mediaId: state.mediaId, reason: 'natural', inFlight: false };

    case 'YOUTUBE_ERROR':
      if (state.phase === 'loading' || state.phase === 'buffering' || state.phase === 'playing') {
        return { phase: 'ending', mediaId: state.mediaId, reason: 'error', inFlight: false };
      }
      return state;

    case 'ADMIN_PAUSE':
      if (state.phase === 'playing' || state.phase === 'buffering') {
        return { phase: 'paused', mediaId: state.mediaId, pausedBy: 'admin' };
      }
      return state;

    case 'ADMIN_RESUME':
      if (state.phase === 'paused') {
        return { phase: 'playing', mediaId: state.mediaId };
      }
      return state;

    case 'ADMIN_SKIP':
      if (state.phase === 'playing' || state.phase === 'paused' || state.phase === 'buffering') {
        return { phase: 'ending', mediaId: state.mediaId, reason: 'skip', inFlight: false };
      }
      return state;

    case 'ADVANCE_IN_FLIGHT':
      if (state.phase === 'ending') return { ...state, inFlight: true };
      return state;

    case 'ADVANCE_COMPLETE':
      return state;

    case 'RESET':
      return { phase: 'idle' };

    default:
      return state;
  }
}

export function canAdvance(state: PlaybackPhase): boolean {
  return state.phase === 'ending' && !state.inFlight;
}

export function needsFadeOnAdvance(state: PlaybackPhase): boolean {
  return state.phase === 'ending' && state.reason === 'skip';
}

export function isAfterSkip(state: PlaybackPhase): boolean {
  return state.phase === 'loading' && state.isAfterSkip;
}

export function isErrorAdvance(state: PlaybackPhase): boolean {
  return state.phase === 'ending' && state.reason === 'error';
}
```

---

### 2. `web/player/src/hooks/useQueueAdvance.ts`

```typescript
/**
 * useQueueAdvance — single consolidated queue advancement path
 *
 * Previously App.tsx had THREE separate callPlayerControl({ action: 'ended' }) 
 * call sites. This replaces all three.
 */

import { useCallback, useRef } from 'react';
import { callPlayerControl, type MediaItem } from '@shared/supabase-client';
import type { PlaybackAction, PlaybackPhase } from '../state/playbackMachine';
import { canAdvance, needsFadeOnAdvance, isErrorAdvance } from '../state/playbackMachine';

type UseQueueAdvanceArgs = {
  playerId: string;
  isSlavePlayer: boolean;
  dispatch: React.Dispatch<PlaybackAction>;
  fadeOut: () => Promise<void>;
  onNextMedia: (media: MediaItem) => void;
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
  const advancingForMediaIdRef = useRef<string | null>(null);

  const advance = useCallback(
    async (state: PlaybackPhase) => {
      if (isSlavePlayer) return;
      if (!canAdvance(state)) return;

      dispatch({ type: 'ADVANCE_IN_FLIGHT' });

      const mediaId = state.phase === 'ending' ? state.mediaId : null;
      advancingForMediaIdRef.current = mediaId;

      if (needsFadeOnAdvance(state) && !isErrorAdvance(state)) {
        try { await fadeOut(); } catch { /* non-fatal */ }
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

          dispatch({
            type: 'QUEUE_NEXT_STARTED',
            mediaId: nextMedia.id,
            isAfterSkip: state.phase === 'ending' && state.reason === 'skip',
          });
          onNextMedia(nextMedia);
        } else {
          dispatch({ type: 'QUEUE_EXHAUSTED' });
          onQueueEmpty();
        }
      } catch (err) {
        console.error('[useQueueAdvance] queue_next failed:', err);
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
```

---

### 3. `web/player/src/hooks/useFade.ts`

```typescript
/**
 * useFade — audio/opacity fade in and out
 * Extracted from App.tsx where fadeOut/fadeIn were inline useCallback hooks.
 */

import { useCallback, useRef } from 'react';
import { FADE_DURATION_MS } from '../../../../shared/constants';

type FadeTarget = {
  ytPlayerRef?: React.MutableRefObject<any>;
  videoRef?: React.MutableRefObject<HTMLVideoElement | null>;
  containerRef?: React.MutableRefObject<HTMLDivElement | null>;
};

export function useFade(target: FadeTarget) {
  const fadeIntervalRef = useRef<number | null>(null);

  const clearFade = useCallback(() => {
    if (fadeIntervalRef.current !== null) {
      clearInterval(fadeIntervalRef.current);
      fadeIntervalRef.current = null;
    }
  }, []);

  const getVolume = useCallback((): number => {
    const yt = target.ytPlayerRef?.current;
    if (yt && typeof yt.getVolume === 'function') return yt.getVolume();
    const vid = target.videoRef?.current;
    if (vid) return vid.volume * 100;
    return 100;
  }, [target]);

  const setVolume = useCallback((vol: number) => {
    const yt = target.ytPlayerRef?.current;
    if (yt && typeof yt.setVolume === 'function') yt.setVolume(Math.max(0, Math.min(100, vol)));
    const vid = target.videoRef?.current;
    if (vid) vid.volume = Math.max(0, Math.min(1, vol / 100));
  }, [target]);

  const setOpacity = useCallback((opacity: number) => {
    const el = target.containerRef?.current;
    if (el) el.style.opacity = String(Math.max(0, Math.min(1, opacity)));
  }, [target]);

  const fadeOut = useCallback((): Promise<void> => {
    return new Promise((resolve) => {
      clearFade();
      const startVolume = getVolume();
      const steps = 60;
      const stepDuration = FADE_DURATION_MS / steps;
      let step = 0;
      fadeIntervalRef.current = window.setInterval(() => {
        step++;
        const progress = step / steps;
        setVolume(startVolume * (1 - progress));
        setOpacity(1 - progress);
        if (step >= steps) { clearFade(); resolve(); }
      }, stepDuration);
    });
  }, [clearFade, getVolume, setVolume, setOpacity]);

  const fadeIn = useCallback((): Promise<void> => {
    return new Promise((resolve) => {
      clearFade();
      const steps = 60;
      const stepDuration = FADE_DURATION_MS / steps;
      let step = 0;
      fadeIntervalRef.current = window.setInterval(() => {
        step++;
        const progress = step / steps;
        setVolume(100 * progress);
        setOpacity(progress);
        if (step >= steps) { clearFade(); resolve(); }
      }, stepDuration);
    });
  }, [clearFade, setVolume, setOpacity]);

  const snapSilent = useCallback(() => { clearFade(); setVolume(0); setOpacity(0); }, [clearFade, setVolume, setOpacity]);
  const snapFull   = useCallback(() => { clearFade(); setVolume(100); setOpacity(1); }, [clearFade, setVolume, setOpacity]);

  return { fadeOut, fadeIn, snapSilent, snapFull, clearFade };
}
```

---

### 4. `web/player/src/hooks/useLoadingGuard.ts`

```typescript
/**
 * useLoadingGuard — auto-skip for videos that fail to start
 *
 * Replaces the loadingTimeoutRef (6s) and unexpectedPauseTimeoutRef (3s) 
 * mechanisms in App.tsx.
 */

import { useEffect, useRef } from 'react';
import type { PlaybackPhase, PlaybackAction } from '../state/playbackMachine';

type UseLoadingGuardArgs = {
  playback: PlaybackPhase;
  dispatch: React.Dispatch<PlaybackAction>;
  getYTPlayerState: () => number | null;
  reportPlaying: () => void;
};

const YT_PLAYING   = 1;
const YT_BUFFERING = 3;
const LOADING_TIMEOUT_MS     = 8_000;
const BUFFERING_EXTENSION_MS = 4_000;

export function useLoadingGuard({ playback, dispatch, getYTPlayerState, reportPlaying }: UseLoadingGuardArgs) {
  const loadingTimerRef   = useRef<number | null>(null);
  const extensionTimerRef = useRef<number | null>(null);

  const clearAll = () => {
    if (loadingTimerRef.current !== null)   { clearTimeout(loadingTimerRef.current);   loadingTimerRef.current = null; }
    if (extensionTimerRef.current !== null) { clearTimeout(extensionTimerRef.current); extensionTimerRef.current = null; }
  };

  useEffect(() => {
    clearAll();
    if (playback.phase !== 'loading' && playback.phase !== 'buffering') return;

    loadingTimerRef.current = window.setTimeout(() => {
      loadingTimerRef.current = null;
      const ytState = getYTPlayerState();

      if (ytState === YT_PLAYING) {
        console.warn('[useLoadingGuard] Loading timeout: YouTube IS PLAYING — Realtime dropped event, correcting DB');
        reportPlaying();
        return;
      }

      if (ytState === YT_BUFFERING) {
        console.warn('[useLoadingGuard] Loading timeout: still buffering, extending 4s');
        extensionTimerRef.current = window.setTimeout(() => {
          extensionTimerRef.current = null;
          console.error('[useLoadingGuard] Auto-skip: buffering for 12s total');
          dispatch({ type: 'YOUTUBE_ERROR', code: -1 });
        }, BUFFERING_EXTENSION_MS);
        return;
      }

      console.error('[useLoadingGuard] Auto-skip: stuck in loading after 8s');
      dispatch({ type: 'YOUTUBE_ERROR', code: -1 });
    }, LOADING_TIMEOUT_MS);

    return clearAll;
  }, [playback.phase, dispatch, getYTPlayerState, reportPlaying]);
}
```

---

### 5. `web/player/src/hooks/usePlayerRealtime.ts`

```typescript
/**
 * usePlayerRealtime — consolidated Supabase subscriptions + 30s polling baseline
 *
 * Replaces the 120-line useEffect in App.tsx that mixed subscription setup,
 * state transition logic, and polling fallback.
 *
 * Polling strategy: 30-second baseline always runs. Realtime delivers events
 * faster when healthy. Simpler than the old "10s silence → one-shot retry".
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
  dispatch: React.Dispatch<PlaybackAction>;
  onStatusUpdate: (status: PlayerStatus) => void;
  onSettingsUpdate: (settings: PlayerSettings) => void;
};

const POLL_INTERVAL_MS = 30_000;

export function usePlayerRealtime({
  playerId, identityReady, activePlayerId,
  dispatch, onStatusUpdate, onSettingsUpdate,
}: UsePlayerRealtimeArgs) {
  const lastKnownStateRef = useRef<PlayerStatus['state'] | null>(null);
  const pollTimerRef = useRef<number | null>(null);

  const fetchStatus = useCallback(async (): Promise<PlayerStatus | null> => {
    const { data, error } = await supabase
      .from('player_status')
      .select('*, current_media:media_items(*)')
      .eq('player_id', playerId)
      .single();
    if (error || !data) { console.error('[usePlayerRealtime] Poll fetch failed:', error); return null; }
    return data as PlayerStatus;
  }, [playerId]);

  const applyStatus = useCallback((status: PlayerStatus) => {
    const prevState = lastKnownStateRef.current;
    const newState  = status.state;
    lastKnownStateRef.current = newState;
    onStatusUpdate(status);

    if (prevState === newState) return;

    if      (newState === 'playing' && prevState === 'paused')                             dispatch({ type: 'ADMIN_RESUME' });
    else if (newState === 'paused'  && prevState === 'playing')                            dispatch({ type: 'ADMIN_PAUSE' });
    else if (newState === 'idle'    && (prevState === 'playing' || prevState === 'paused')) dispatch({ type: 'ADMIN_SKIP' });
  }, [dispatch, onStatusUpdate]);

  // 30-second baseline polling
  useEffect(() => {
    if (!identityReady || !activePlayerId) return;
    const poll = async () => {
      const status = await fetchStatus();
      if (status) applyStatus(status);
    };
    pollTimerRef.current = window.setInterval(poll, POLL_INTERVAL_MS);
    return () => { if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; } };
  }, [identityReady, activePlayerId, fetchStatus, applyStatus]);

  // Realtime subscription (fast path)
  useEffect(() => {
    if (!identityReady || !activePlayerId) return;
    const sub = subscribeToPlayerStatus(playerId, applyStatus);
    return () => sub.unsubscribe();
  }, [identityReady, activePlayerId, playerId, applyStatus]);

  // Settings subscription
  useEffect(() => {
    if (!identityReady || !activePlayerId) return;
    const sub = subscribeToPlayerSettings(playerId, onSettingsUpdate);
    return () => sub.unsubscribe();
  }, [identityReady, activePlayerId, playerId, onSettingsUpdate]);
}
```

---

### 6. `web/player/src/players/YouTubePlayer.tsx`

```typescript
/**
 * YouTubePlayer — iframe mode, forwardRef with imperative handle
 * Extracted from App.tsx. Owns the YT IFrame API lifecycle.
 */

import { useEffect, useRef, forwardRef, useImperativeHandle, useCallback } from 'react';
import { extractYouTubeId } from '../utils/youtube';
import type { PlaybackAction } from '../state/playbackMachine';

export const YT_UNSTARTED  = -1;
export const YT_ENDED      =  0;
export const YT_PLAYING    =  1;
export const YT_PAUSED     =  2;
export const YT_BUFFERING  =  3;

const UNPLAYABLE_CODES     = new Set([100, 101, 150]);
const STALE_ENDED_GUARD_MS = 5_000;

declare global {
  interface Window { YT: any; onYouTubeIframeAPIReady: () => void; }
}

export type YouTubePlayerHandle = {
  loadVideo: (url: string, isAfterSkip: boolean) => void;
  pause: () => void;
  resume: () => void;
  setVolume: (vol: number) => void;
  getVolume: () => number;
  getPlayerState: () => number | null;
};

type YouTubePlayerProps = {
  dispatch: React.Dispatch<PlaybackAction>;
  onPlaying: () => void;
  onUnplayableVideo: (mediaId: string) => void;
  currentMediaId: string | null;
  visible: boolean;
};

export const YouTubePlayer = forwardRef<YouTubePlayerHandle, YouTubePlayerProps>(
  function YouTubePlayer({ dispatch, onPlaying, onUnplayableVideo, currentMediaId, visible }, ref) {
    const containerRef    = useRef<HTMLDivElement>(null);
    const ytPlayerRef     = useRef<any>(null);
    const apiReadyRef     = useRef(false);
    const lastLoadTimeRef = useRef<number>(0);
    const callbacksRef    = useRef({ dispatch, onPlaying, onUnplayableVideo, currentMediaId });

    useEffect(() => { callbacksRef.current = { dispatch, onPlaying, onUnplayableVideo, currentMediaId }; });

    useEffect(() => {
      if (apiReadyRef.current) return;
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(tag);
      window.onYouTubeIframeAPIReady = () => { apiReadyRef.current = true; };
    }, []);

    const onReady        = useCallback(() => {}, []);
    const onStateChange  = useCallback((event: { data: number }) => {
      const { dispatch, onPlaying } = callbacksRef.current;
      if      (event.data === YT_PLAYING)   { dispatch({ type: 'YOUTUBE_PLAYING' });   onPlaying(); }
      else if (event.data === YT_PAUSED)    { dispatch({ type: 'YOUTUBE_PAUSED' }); }
      else if (event.data === YT_BUFFERING) { dispatch({ type: 'YOUTUBE_BUFFERING' }); }
      else if (event.data === YT_ENDED) {
        if (Date.now() - lastLoadTimeRef.current < STALE_ENDED_GUARD_MS) {
          console.warn('[YouTubePlayer] Ignoring stale ENDED event');
          return;
        }
        dispatch({ type: 'YOUTUBE_ENDED' });
      }
    }, []);

    const onError = useCallback((event: { data: number }) => {
      const { currentMediaId, onUnplayableVideo, dispatch } = callbacksRef.current;
      if (UNPLAYABLE_CODES.has(event.data) && currentMediaId) onUnplayableVideo(currentMediaId);
      dispatch({ type: 'YOUTUBE_ERROR', code: event.data });
    }, []);

    useImperativeHandle(ref, () => ({
      loadVideo(url: string, isAfterSkip: boolean) {
        const videoId = extractYouTubeId(url);
        if (!videoId) { console.error('[YouTubePlayer] Bad URL:', url); return; }
        lastLoadTimeRef.current = Date.now();

        if (ytPlayerRef.current?.loadVideoById) {
          ytPlayerRef.current.setVolume(isAfterSkip ? 0 : 100);
          ytPlayerRef.current.loadVideoById(videoId);
          setTimeout(() => ytPlayerRef.current?.playVideo?.(), 500);
          return;
        }

        if (!containerRef.current || !apiReadyRef.current) {
          console.error('[YouTubePlayer] Container or API not ready');
          return;
        }

        ytPlayerRef.current = new window.YT.Player(containerRef.current, {
          videoId,
          playerVars: { autoplay: 0, controls: 0, disablekb: 1, modestbranding: 1, rel: 0, iv_load_policy: 3 },
          events: { onReady, onStateChange, onError },
        });
      },
      pause()               { ytPlayerRef.current?.pauseVideo?.(); },
      resume()              { ytPlayerRef.current?.playVideo?.(); },
      setVolume(vol)        { ytPlayerRef.current?.setVolume?.(Math.max(0, Math.min(100, vol))); },
      getVolume()           { return ytPlayerRef.current?.getVolume?.() ?? 100; },
      getPlayerState()      { return ytPlayerRef.current?.getPlayerState?.() ?? null; },
    }), [onReady, onStateChange, onError]);

    return <div ref={containerRef} id="yt-player" className="w-full h-full" style={{ display: visible ? 'block' : 'none' }} />;
  }
);
```

---

### 7. `web/player/src/players/LocalVideoPlayer.tsx`

```typescript
/**
 * LocalVideoPlayer — native <video> for Cloudflare R2 / yt-dlp files
 */

import { useRef, forwardRef, useImperativeHandle } from 'react';
import type { PlaybackAction } from '../state/playbackMachine';

const PROGRESS_THROTTLE_MS = 5_000;

type LocalVideoPlayerProps = {
  src: string;
  dispatch: React.Dispatch<PlaybackAction>;
  onProgress: (progress: number) => void;
};

export type LocalVideoPlayerHandle = {
  pause: () => void;
  resume: () => Promise<void>;
  getElement: () => HTMLVideoElement | null;
};

export const LocalVideoPlayer = forwardRef<LocalVideoPlayerHandle, LocalVideoPlayerProps>(
  function LocalVideoPlayer({ src, dispatch, onProgress }, ref) {
    const videoRef      = useRef<HTMLVideoElement | null>(null);
    const lastReportRef = useRef<number>(0);
    const hasPlayedRef  = useRef(false);

    useImperativeHandle(ref, () => ({
      pause()         { videoRef.current?.pause(); },
      async resume()  { try { await videoRef.current?.play(); } catch(e) { console.warn('[LocalVideoPlayer] Resume failed:', e); } },
      getElement()    { return videoRef.current; },
    }));

    return (
      <video
        ref={videoRef}
        key={src}
        src={src}
        autoPlay
        className="absolute inset-0 w-full h-full"
        style={{ objectFit: 'contain', background: 'black' }}
        onPlay={() => { hasPlayedRef.current = true; dispatch({ type: 'YOUTUBE_PLAYING' }); }}
        onPause={() => { if (!hasPlayedRef.current) return; dispatch({ type: 'YOUTUBE_PAUSED' }); }}
        onEnded={() => dispatch({ type: 'YOUTUBE_ENDED' })}
        onError={() => dispatch({ type: 'YOUTUBE_ERROR', code: -1 })}
        onTimeUpdate={() => {
          const now = Date.now();
          if (now - lastReportRef.current < PROGRESS_THROTTLE_MS) return;
          lastReportRef.current = now;
          const el = videoRef.current;
          if (el && el.duration && isFinite(el.duration) && el.duration > 0) {
            onProgress(el.currentTime / el.duration);
          }
        }}
      />
    );
  }
);
```

---

### 8. `web/player/src/players/YTMDesktopPlayer.tsx`

Copy this file verbatim from `/home/claude/obie-refactor/web/player/src/players/YTMDesktopPlayer.tsx`

---

### 9. `web/player/src/App.tsx` — REPLACE existing file

```typescript
/**
 * Obie Player — Refactored App.tsx
 *
 * Before: 1,637 lines, 17 useRef guards, 13 useEffect, 3 advance paths.
 * After:  ~350 lines. Single useReducer state machine. One advance path.
 */

import { useEffect, useRef, useState, useCallback, useReducer } from 'react';
import {
  supabase,
  callPlaylistManager,
  callQueueManager,
  callRadioGenerator,
  initializePlayerPlaylist,
  callPlayerControl,
  type MediaItem,
  type PlayerStatus,
  type PlayerSettings,
} from '@shared/supabase-client';

import { ResolvingScreen, JukeboxNamePrompt, StatusOverlays } from './components/IdentityScreens';
import { YouTubePlayer, type YouTubePlayerHandle  } from './players/YouTubePlayer';
import { LocalVideoPlayer, type LocalVideoPlayerHandle } from './players/LocalVideoPlayer';
import { YTMDesktopPlayer } from './players/YTMDesktopPlayer';
import { usePlayerIdentity }  from './hooks/usePlayerIdentity';
import { usePlayerHeartbeat } from './hooks/usePlayerHeartbeat';
import { useKaraokeLyrics }   from './hooks/useKaraokeLyrics';
import { usePlayerRealtime }  from './hooks/usePlayerRealtime';
import { useQueueAdvance }    from './hooks/useQueueAdvance';
import { useLoadingGuard }    from './hooks/useLoadingGuard';
import { useFade }            from './hooks/useFade';
import {
  playbackReducer,
  isAfterSkip as isAfterSkipPhase,
  type PlaybackPhase,
} from './state/playbackMachine';

const DEFAULT_PLAYER_ID      = import.meta.env.VITE_PLAYER_ID || '00000000-0000-0000-0000-000000000001';
const PLAYER_JUKEBOX_STORAGE_KEY = 'obie_player_jukebox_slug';

function App() {
  const { activePlayerId, identityReady, playerId: PLAYER_ID } = usePlayerIdentity({
    defaultPlayerId: DEFAULT_PLAYER_ID,
    storageKey: PLAYER_JUKEBOX_STORAGE_KEY,
  });

  const [playback, dispatch]  = useReducer(playbackReducer, { phase: 'idle' } as PlaybackPhase);
  const [currentMedia, setCurrentMedia] = useState<MediaItem | null>(null);
  const [status, setStatus]             = useState<PlayerStatus | null>(null);
  const [settings, setSettings]         = useState<PlayerSettings | null>(null);
  const [isSlavePlayer, setIsSlavePlayer] = useState(false);
  const [localVideoUrl, setLocalVideoUrl]  = useState<string | null>(null);

  const playerMode  = settings?.player_mode ?? 'iframe';
  const isYTMMode   = playerMode === 'ytm_desktop';
  const isLocalMode = !!localVideoUrl;

  const ytPlayerRef    = useRef<YouTubePlayerHandle | null>(null);
  const localPlayerRef = useRef<LocalVideoPlayerHandle | null>(null);
  const containerRef   = useRef<HTMLDivElement>(null);
  const hasInitRef     = useRef(false);
  const autoRadioRef   = useRef(false);

  const { fadeOut, fadeIn, snapSilent } = useFade({
    ytPlayerRef: { current: ytPlayerRef.current } as any,
    containerRef,
  });

  const { reportStatus } = usePlayerHeartbeat({ isSlavePlayer, playerId: PLAYER_ID });

  useKaraokeLyrics({
    enabled: !!settings?.karaoke_mode,
    currentMedia,
    playerRef: { current: ytPlayerRef.current } as any,
    currentMediaIdRef: { current: currentMedia?.id ?? null },
  });

  const { advance } = useQueueAdvance({
    playerId: PLAYER_ID,
    isSlavePlayer,
    dispatch,
    fadeOut,
    onNextMedia: (media) => setCurrentMedia(media),
    onQueueEmpty: () => setCurrentMedia(null),
  });

  // Trigger advance when state machine enters 'ending'
  useEffect(() => {
    if (playback.phase === 'ending' && !playback.inFlight) {
      advance(playback);
    }
  }, [playback, advance]);

  // Auto-radio when queue empties
  useEffect(() => {
    if (playback.phase !== 'idle' || autoRadioRef.current || isSlavePlayer) return;
    autoRadioRef.current = true;
    callRadioGenerator({ player_id: PLAYER_ID, action: 'generate', source: 'history' })
      .catch((e) => console.error('[App] Auto-radio failed:', e))
      .finally(() => { autoRadioRef.current = false; });
  }, [playback.phase, PLAYER_ID, isSlavePlayer]);

  const handleStatusUpdate = useCallback((newStatus: PlayerStatus) => {
    setStatus(newStatus);
    if (newStatus.current_media_id && newStatus.current_media_id !== currentMedia?.id) {
      if (newStatus.current_media) {
        setCurrentMedia(newStatus.current_media);
        dispatch({ type: 'QUEUE_NEXT_STARTED', mediaId: newStatus.current_media_id, isAfterSkip: false });
      }
    }
    if ((newStatus.source === 'local' || newStatus.source === 'cloudflare') && newStatus.local_url) {
      setLocalVideoUrl(newStatus.local_url);
    } else if (newStatus.source === 'youtube') {
      setLocalVideoUrl(null);
    }
  }, [currentMedia?.id]);

  const handleSettingsUpdate = useCallback((s: PlayerSettings) => setSettings(s), []);

  usePlayerRealtime({
    playerId: PLAYER_ID, identityReady, activePlayerId,
    dispatch,
    onStatusUpdate:  handleStatusUpdate,
    onSettingsUpdate: handleSettingsUpdate,
  });

  useLoadingGuard({
    playback,
    dispatch,
    getYTPlayerState:  useCallback(() => ytPlayerRef.current?.getPlayerState() ?? null, []),
    reportPlaying:     useCallback(() => reportStatus('playing'), [reportStatus]),
  });

  // Load video into player when media changes
  useEffect(() => {
    if (!currentMedia || isYTMMode || isLocalMode) return;
    const isSkip = isAfterSkipPhase(playback);
    if (isSkip) snapSilent();
    ytPlayerRef.current?.loadVideo(currentMedia.url, isSkip);
  }, [currentMedia?.id]);

  // Sync DB state and issue player commands on phase changes
  useEffect(() => {
    if (playback.phase === 'playing') {
      reportStatus('playing');
      if (ytPlayerRef.current?.getVolume() === 0) fadeIn();
    } else if (playback.phase === 'paused') {
      reportStatus('paused');
      if (!isYTMMode && !isLocalMode) {
        fadeOut().then(() => ytPlayerRef.current?.pause());
      }
    }
  }, [playback.phase]);

  // Handle unplayable video removal
  const handleUnplayableVideo = useCallback(async (mediaId: string) => {
    try {
      const { data: queueItem } = await supabase.from('queue')
        .select('id').eq('media_item_id', mediaId).eq('player_id', PLAYER_ID).maybeSingle();
      if (queueItem) {
        await callQueueManager({ player_id: PLAYER_ID, action: 'remove', queue_id: (queueItem as any).id });
      }
      await callPlaylistManager({ action: 'remove_media_globally', player_id: PLAYER_ID, media_item_id: mediaId });
    } catch (err) {
      console.error('[App] Failed to remove unplayable video:', err);
    }
  }, [PLAYER_ID]);

  // Initialization
  useEffect(() => {
    if (!identityReady || !activePlayerId || hasInitRef.current) return;
    hasInitRef.current = true;
    (async () => {
      try {
        await initializePlayerPlaylist(PLAYER_ID);
        const sessionId = crypto.randomUUID();
        const storedPlayerId = localStorage.getItem('obie_priority_player_id');
        const result = await callPlayerControl({
          player_id: PLAYER_ID, action: 'register_session',
          session_id: sessionId, stored_player_id: storedPlayerId ?? undefined,
        });
        setIsSlavePlayer(!result.is_priority);
        if (result.is_priority) localStorage.setItem('obie_priority_player_id', PLAYER_ID);
        else if (storedPlayerId === PLAYER_ID) localStorage.removeItem('obie_priority_player_id');
      } catch (err) {
        console.error('[App] Initialization failed:', err);
      }
    })();
  }, [identityReady, activePlayerId, PLAYER_ID]);

  if (!identityReady)  return <ResolvingScreen />;
  if (!activePlayerId) return <JukeboxNamePrompt />;

  return (
    <div className="relative w-screen h-screen bg-black">
      <div ref={containerRef} className="w-full h-full" style={{ display: (!isYTMMode && !isLocalMode) ? 'block' : 'none' }}>
        <YouTubePlayer
          ref={ytPlayerRef}
          dispatch={dispatch}
          onPlaying={() => { if (ytPlayerRef.current?.getVolume() === 0) fadeIn(); }}
          onUnplayableVideo={handleUnplayableVideo}
          currentMediaId={currentMedia?.id ?? null}
          visible={!isYTMMode && !isLocalMode}
        />
      </div>

      {isLocalMode && localVideoUrl && (
        <LocalVideoPlayer
          ref={localPlayerRef}
          src={localVideoUrl}
          dispatch={dispatch}
          onProgress={(progress) => reportStatus('playing', progress)}
        />
      )}

      {isYTMMode && (
        <YTMDesktopPlayer
          currentMedia={currentMedia}
          dispatch={dispatch}
          onAdminPause={() => {}}
          onAdminResume={() => {}}
        />
      )}

      <img
        src="/Obie_neon_no_BG.png" alt="Obie"
        className="absolute bottom-[40px] left-[20px] w-[8vw] h-auto pointer-events-none z-10"
        style={{ maxWidth: '160px', minWidth: '60px' }}
      />

      <div
        className="absolute inset-0 w-full h-full cursor-default"
        style={{ pointerEvents: isYTMMode ? 'none' : 'auto' }}
        onClick={(e) => {
          e.preventDefault();
          if (playback.phase === 'paused') {
            dispatch({ type: 'ADMIN_RESUME' });
            ytPlayerRef.current?.resume();
          }
        }}
      />

      <StatusOverlays
        state={status?.state}
        playerReady={playback.phase !== 'idle'}
        currentMedia={currentMedia}
        isSlavePlayer={isSlavePlayer}
      />
    </div>
  );
}

export default App;
```

---

## Files to CREATE (DB migrations)

### `supabase/migrations/20260418000001_queue_position_trigger.sql`

```sql
-- Queue position auto-resequencing trigger
-- Fixes gap accumulation that caused shuffle/reorder constraint violations

CREATE OR REPLACE FUNCTION public.queue_resequence_positions()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  WITH ranked AS (
    SELECT id,
      ROW_NUMBER() OVER (PARTITION BY player_id, type ORDER BY position ASC) - 1 AS new_position
    FROM public.queue
    WHERE player_id = OLD.player_id AND type = OLD.type
  )
  UPDATE public.queue q
  SET    position = r.new_position
  FROM   ranked r
  WHERE  q.id = r.id AND q.position <> r.new_position;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS queue_resequence_after_delete ON public.queue;
CREATE TRIGGER queue_resequence_after_delete
  AFTER DELETE ON public.queue
  FOR EACH ROW EXECUTE FUNCTION public.queue_resequence_positions();

-- Clean up existing gaps
WITH ranked AS (
  SELECT id,
    ROW_NUMBER() OVER (PARTITION BY player_id, type ORDER BY position ASC) - 1 AS new_position
  FROM public.queue
)
UPDATE public.queue q SET position = r.new_position
FROM ranked r WHERE q.id = r.id AND q.position <> r.new_position;
```

### `supabase/migrations/20260418000002_queue_next_hardened.sql`

Copy verbatim from `/home/claude/obie-refactor/supabase/migrations/20260418000002_queue_next_hardened.sql`

---

## Validation Steps (run after implementing)

```bash
# TypeScript should compile cleanly with no errors
cd web/player && npx tsc --noEmit

# Check new file structure
find src/state src/hooks src/players -name "*.ts" -o -name "*.tsx" | sort

# Verify old guard patterns are gone from App.tsx
grep -c "isEndingRef\|recentlyLoadedRef\|videoHasPlayedRef\|adminPausedRef\|isSkipLoadingRef" src/App.tsx
# Expected: 0

# Verify single advance path
grep -c "action: 'ended'" src/App.tsx
# Expected: 0 (all calls now go through useQueueAdvance)
```

## Commit message

```
refactor(player): replace God Component with state machine architecture

- Extract playback state machine (useReducer) replacing 17 useRef guards
- Single queue advance path via useQueueAdvance (was 3 parallel paths)
- YOUTUBE_ENDED from non-PLAYING phase structurally dropped (no isEndingRef)
- Player modes extracted: YouTubePlayer, LocalVideoPlayer, YTMDesktopPlayer
- usePlayerRealtime: 30s baseline polling replaces fragile 10s silence detection
- useLoadingGuard: consolidated loading/pause timeouts into one hook
- useFade: extracted from App.tsx into reusable hook
- DB: queue position trigger auto-resequences on DELETE (fixes gap corruption)
- DB: queue_next hardened with explicit position cleanup

App.tsx: 1637 → 359 lines
```
