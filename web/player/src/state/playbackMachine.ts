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

// ---------------------------------------------------------------------------
// State types
// ---------------------------------------------------------------------------

export type PlaybackPhase =
  | { phase: 'idle' }
  | { phase: 'loading';   mediaId: string; isAfterSkip: boolean }
  | { phase: 'buffering'; mediaId: string }
  | { phase: 'playing';   mediaId: string }
  | { phase: 'paused';    mediaId: string; pausedBy: 'admin' | 'user' }
  | { phase: 'ending';    mediaId: string; reason: 'natural' | 'skip' | 'error'; inFlight: boolean }

export type PlaybackAction =
  // Queue / navigation
  | { type: 'QUEUE_NEXT_STARTED';  mediaId: string; isAfterSkip?: boolean }
  | { type: 'QUEUE_EXHAUSTED' }

  // YouTube / player events
  | { type: 'YOUTUBE_PLAYING' }
  | { type: 'YOUTUBE_BUFFERING' }
  | { type: 'YOUTUBE_PAUSED' }
  | { type: 'YOUTUBE_ENDED' }
  | { type: 'YOUTUBE_ERROR';       code: number }

  // Admin commands (from Supabase Realtime)
  | { type: 'ADMIN_PAUSE' }
  | { type: 'ADMIN_RESUME' }
  | { type: 'ADMIN_SKIP' }

  // Internal
  | { type: 'ADVANCE_IN_FLIGHT' }   // mark queue_next HTTP call started
  | { type: 'ADVANCE_COMPLETE' }    // queue_next HTTP call returned (success or empty)
  | { type: 'RESET' }               // hard reset on identity change

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function playbackReducer(
  state: PlaybackPhase,
  action: PlaybackAction
): PlaybackPhase {

  switch (action.type) {

    // ── Queue navigation ────────────────────────────────────────────────────

    case 'QUEUE_NEXT_STARTED':
      // Valid from any phase — a new media item is being loaded.
      return {
        phase: 'loading',
        mediaId: action.mediaId,
        isAfterSkip: action.isAfterSkip ?? false,
      };

    case 'QUEUE_EXHAUSTED':
      return { phase: 'idle' };

    // ── YouTube events ──────────────────────────────────────────────────────

    case 'YOUTUBE_PLAYING':
      // Accept from loading, buffering, paused (auto-resume), or ending (shouldn't
      // happen but don't crash). Ignore from idle (stale event from previous media).
      if (state.phase === 'idle' || state.phase === 'ending') return state;
      return { phase: 'playing', mediaId: state.mediaId };

    case 'YOUTUBE_BUFFERING':
      if (state.phase === 'loading' || state.phase === 'playing' || state.phase === 'paused') {
        return { phase: 'buffering', mediaId: state.mediaId };
      }
      return state;

    case 'YOUTUBE_PAUSED':
      // YouTube fires PAUSED transitorily during load and sometimes at end of video.
      // We mark it as 'user' pause but the parent component should auto-resume if
      // this wasn't an explicit user action. Only 'admin' pauses should persist.
      if (state.phase === 'playing' || state.phase === 'buffering') {
        return { phase: 'paused', mediaId: state.mediaId, pausedBy: 'user' };
      }
      return state;

    case 'YOUTUBE_ENDED':
      // CRITICAL: only valid from PLAYING. This is the key fix for stale ENDED events —
      // if we're in LOADING (new video just started), this event is a ghost from the
      // previous video and must be dropped. No isEndingRef needed.
      if (state.phase !== 'playing') return state;
      return { phase: 'ending', mediaId: state.mediaId, reason: 'natural', inFlight: false };

    case 'YOUTUBE_ERROR':
      // Accept from loading, buffering, or playing.
      if (
        state.phase === 'loading' ||
        state.phase === 'buffering' ||
        state.phase === 'playing'
      ) {
        return { phase: 'ending', mediaId: state.mediaId, reason: 'error', inFlight: false };
      }
      return state;

    // ── Admin commands ───────────────────────────────────────────────────────

    case 'ADMIN_PAUSE':
      if (state.phase === 'playing' || state.phase === 'buffering') {
        return { phase: 'paused', mediaId: state.mediaId, pausedBy: 'admin' };
      }
      return state;

    case 'ADMIN_RESUME':
      if (state.phase === 'paused') {
        // Go back to playing — the actual playVideo() call happens in the effect
        return { phase: 'playing', mediaId: state.mediaId };
      }
      return state;

    case 'ADMIN_SKIP':
      if (
        state.phase === 'playing' ||
        state.phase === 'paused' ||
        state.phase === 'buffering'
      ) {
        return { phase: 'ending', mediaId: state.mediaId, reason: 'skip', inFlight: false };
      }
      return state;

    // ── Internal ─────────────────────────────────────────────────────────────

    case 'ADVANCE_IN_FLIGHT':
      if (state.phase === 'ending') {
        return { ...state, inFlight: true };
      }
      return state;

    case 'ADVANCE_COMPLETE':
      // ADVANCE_COMPLETE does NOT transition state — QUEUE_NEXT_STARTED or
      // QUEUE_EXHAUSTED follows immediately after depending on the RPC result.
      return state;

    case 'RESET':
      return { phase: 'idle' };

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Selectors — derived booleans used by effects
// ---------------------------------------------------------------------------

/** Is a queue advance currently permitted (not already in-flight)? */
export function canAdvance(state: PlaybackPhase): boolean {
  return state.phase === 'ending' && !state.inFlight;
}

/** Should we show a fade-out before advancing? */
export function needsFadeOnAdvance(state: PlaybackPhase): boolean {
  return state.phase === 'ending' && state.reason === 'skip';
}

/** Is this a post-skip load (needs fade-in)? */
export function isAfterSkip(state: PlaybackPhase): boolean {
  return state.phase === 'loading' && state.isAfterSkip;
}

/** Is this an auto-skip due to error? */
export function isErrorAdvance(state: PlaybackPhase): boolean {
  return state.phase === 'ending' && state.reason === 'error';
}
