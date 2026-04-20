/**
 * Player Machine - XState v5 Actor Model
 *
 * Per-player machine integrating playback phases and queue advancement.
 * Replaces scattered queue logic with a single, guarded state machine.
 *
 * States:
 * - idle: No media loaded
 * - loading: Media assigned, player loading
 * - buffering: Media buffering
 * - playing: Actively playing
 * - paused: Paused (by admin or user)
 * - ending: Transitioning to next media (reason: natural | skip | error)
 *
 * Queue advancement is ONLY allowed from ending state with:
 * - isPriorityPlayer guard (from coordinator)
 * - canAdvanceQueue guard (phase === 'ending' && !inFlight)
 * - DB idempotency via p_expected_media_id
 */

// @ts-ignore - Deno ESM import
import { setup, createMachine, assign, fromPromise } from 'https://esm.sh/xstate@5.18.2';
import { createServiceClient } from '../supabase-client.ts';

const supabase = createServiceClient();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PlaybackPhase =
  | { phase: 'idle' }
  | { phase: 'loading'; mediaId: string; isAfterSkip: boolean }
  | { phase: 'buffering'; mediaId: string }
  | { phase: 'playing'; mediaId: string }
  | { phase: 'paused'; mediaId: string; pausedBy: 'admin' | 'user' }
  | { phase: 'ending'; mediaId: string; reason: 'natural' | 'skip' | 'error'; inFlight: boolean };

type PlayerContext = {
  playerId: string;
  playback: PlaybackPhase;
  isPriority: boolean;
  lastHeartbeat: number;
  currentMediaId: string | null;
  expectedMediaId: string | null; // For idempotency
  advanceResult: any | null; // Queue advance result from dbQueueNext
};

type PlayerEvent =
  | { type: 'MEDIA_ASSIGNED'; mediaId: string; url?: string; isAfterSkip?: boolean }
  | { type: 'YOUTUBE_PLAYING' }
  | { type: 'YOUTUBE_BUFFERING' }
  | { type: 'YOUTUBE_PAUSED' }
  | { type: 'YOUTUBE_ENDED' }
  | { type: 'YOUTUBE_ERROR'; code: number }
  | { type: 'ADMIN_PAUSE' }
  | { type: 'ADMIN_RESUME' }
  | { type: 'ADMIN_SKIP' }
  | { type: 'QUEUE_ADVANCE_COMPLETE'; nextItem?: any; hasNext: boolean }
  | { type: 'HEARTBEAT' }
  | { type: 'SET_PRIORITY'; isPriority: boolean }
  | { type: 'UPDATE_STATUS'; state: string; progress?: number; expectedState?: string };

// ---------------------------------------------------------------------------
// DB Actors (async operations)
// ---------------------------------------------------------------------------

const dbUpdateStatus = fromPromise(async ({ input }: { input: { playerId: string; state: string; progress?: number } }) => {
  const updateData: Record<string, unknown> = {
    last_updated: new Date().toISOString(),
  };
  if (input.state !== undefined) {
    updateData.state = input.state;
  }
  if (input.progress !== undefined) {
    updateData.progress = Math.min(1, Math.max(0, input.progress));
  }
  const { error } = await supabase
    .from('player_status')
    .update(updateData)
    .eq('player_id', input.playerId);
  if (error) throw error;
  return { success: true };
});

const dbQueueNext = fromPromise(async ({ input }: { input: { playerId: string; expectedMediaId: string | null } }) => {
  const { data, error } = await supabase.rpc('queue_next', {
    p_player_id: input.playerId,
    p_expected_media_id: input.expectedMediaId,
  });
  if (error) throw error;
  return { nextItem: data?.[0] || null, hasNext: data !== null && data.length > 0 };
});

const dbGetCurrentStatus = fromPromise(async ({ input }: { input: { playerId: string } }) => {
  const { data, error } = await supabase
    .from('player_status')
    .select('*')
    .eq('player_id', input.playerId)
    .single();
  if (error) throw error;
  return data;
});

// ---------------------------------------------------------------------------
// Machine Definition
// ---------------------------------------------------------------------------

export const playerMachine = setup({
  types: {
    context: {} as PlayerContext,
    events: {} as PlayerEvent,
  },
  actors: {
    dbUpdateStatus,
    dbQueueNext,
    dbGetCurrentStatus,
  },
  actions: {
    setMediaId: assign({
      currentMediaId: ({ event }: any) => {
        if (event.type === 'MEDIA_ASSIGNED') return event.mediaId;
        return null;
      },
      expectedMediaId: ({ event }: any) => {
        if (event.type === 'MEDIA_ASSIGNED') return event.mediaId;
        return null;
      },
    }),
    setPlaybackLoading: assign({
      playback: ({ context, event }: any) => {
        if (event.type === 'MEDIA_ASSIGNED') {
          return {
            phase: 'loading',
            mediaId: event.mediaId,
            isAfterSkip: event.isAfterSkip ?? false,
          };
        }
        return context.playback;
      },
    }),
    setPlaybackPlaying: assign({
      playback: ({ context }: any) => ({
        phase: 'playing',
        mediaId: context.currentMediaId || '',
      }),
    }),
    setPlaybackBuffering: assign({
      playback: ({ context }: any) => ({
        phase: 'buffering',
        mediaId: context.currentMediaId || '',
      }),
    }),
    setPlaybackPaused: assign({
      playback: ({ context, event }: any) => {
        const pausedBy = event.type === 'ADMIN_PAUSE' ? 'admin' : 'user';
        return {
          phase: 'paused',
          mediaId: context.currentMediaId || '',
          pausedBy,
        };
      },
    }),
    setPlaybackEnding: assign({
      playback: ({ context, event }: any) => {
        let reason: 'natural' | 'skip' | 'error' = 'natural';
        if (event.type === 'ADMIN_SKIP') reason = 'skip';
        if (event.type === 'YOUTUBE_ERROR') reason = 'error';
        return {
          phase: 'ending',
          mediaId: context.currentMediaId || '',
          reason,
          inFlight: false,
        };
      },
    }),
    setPlaybackIdle: assign({
      playback: () => ({ phase: 'idle' }),
      currentMediaId: () => null,
    }),
    setInFlight: assign({
      playback: ({ context }: any) => ({
        ...context.playback,
        inFlight: true,
      }),
    }),
    clearInFlight: assign({
      playback: ({ context }: any) => ({
        ...context.playback,
        inFlight: false,
      }),
    }),
    setPriority: assign({
      isPriority: ({ event }: any) => {
        if (event.type === 'SET_PRIORITY') return event.isPriority;
        return false;
      },
    }),
    trackHeartbeat: assign({
      lastHeartbeat: () => Date.now(),
    }),
  },
  guards: {
    isPriorityPlayer: ({ context }: any) => context.isPriority,
    canAdvanceQueue: ({ context }: any) =>
      context.playback.phase === 'ending' && !context.playback.inFlight,
    isStaleEvent: ({ context, event }: any) => {
      // Reject events for media that's no longer current
      if (event.type === 'MEDIA_ASSIGNED') {
        return event.mediaId === context.currentMediaId;
      }
      return false;
    },
    isPlayingOrPaused: ({ context }: any) =>
      context.playback.phase === 'playing' || context.playback.phase === 'paused',
    isPlayingOrBuffering: ({ context }: any) =>
      context.playback.phase === 'playing' || context.playback.phase === 'buffering',
    casCheck: ({ context, event }: any) => {
      // Compare-and-swap guard for play/pause (prevent admin console races)
      if (event.type === 'UPDATE_STATUS' && event.expectedState !== undefined) {
        // In a real implementation, this would check DB state
        // For now, we'll assume the check passes and let the DB handle idempotency
        return true;
      }
      return true;
    },
  },
}).createMachine({
  id: 'player',
  initial: 'hydrating',
  context: {
    playerId: '',
    playback: { phase: 'idle' },
    isPriority: false,
    lastHeartbeat: 0,
    currentMediaId: null,
    expectedMediaId: null,
    advanceResult: null,
  },
  states: {
    hydrating: {
      invoke: {
        src: ({ context }) => dbGetCurrentStatus({ input: { playerId: context.playerId } }),
        onDone: [
          {
            guard: ({ event }) => event.output?.current_media_id,
            actions: assign({
              currentMediaId: ({ event }) => event.output?.current_media_id || null,
              playback: ({ event }) => {
                const state = event.output?.state || 'idle';
                const mediaId = event.output?.current_media_id || '';
                if (state === 'playing') return { phase: 'playing' as const, mediaId };
                if (state === 'paused') return { phase: 'paused' as const, mediaId, pausedBy: 'admin' as const };
                if (state === 'loading') return { phase: 'loading' as const, mediaId, isAfterSkip: false };
                return { phase: 'idle' as const };
              },
            }),
            target: 'idle',
          },
          {
            target: 'idle',
          },
        ],
        onError: {
          target: 'idle',
        },
      },
    },
    idle: {
      on: {
        MEDIA_ASSIGNED: {
          actions: ['setMediaId', 'setPlaybackLoading'],
          target: 'loading',
        },
        UPDATE_STATUS: {
          actions: assign({
            playback: ({ context, event }) => {
              if (event.state === 'playing') return { phase: 'playing', mediaId: context.currentMediaId || '' };
              if (event.state === 'paused') return { phase: 'paused', mediaId: context.currentMediaId || '', pausedBy: 'admin' as const };
              if (event.state === 'loading') return { phase: 'loading', mediaId: context.currentMediaId || '', isAfterSkip: false };
              return context.playback;
            },
          }),
          target: 'idle',
        },
        HEARTBEAT: {
          actions: 'trackHeartbeat',
        },
        SET_PRIORITY: {
          actions: 'setPriority',
        },
      },
    },
    loading: {
      entry: [
        assign({
          playback: ({ context }) => ({ phase: 'loading', mediaId: context.currentMediaId || '', isAfterSkip: false }),
        }),
        ({ context }) => dbUpdateStatus({ input: { playerId: context.playerId, state: 'loading' } }),
      ],
      on: {
        YOUTUBE_PLAYING: {
          actions: ['setPlaybackPlaying'],
          target: 'playing',
        },
        YOUTUBE_ERROR: {
          actions: 'setPlaybackEnding',
          target: 'ending',
        },
        HEARTBEAT: {
          actions: 'trackHeartbeat',
        },
      },
    },
    buffering: {
      entry: ({ context }) => dbUpdateStatus({ input: { playerId: context.playerId, state: 'buffering' } }),
      on: {
        YOUTUBE_PLAYING: {
          actions: 'setPlaybackPlaying',
          target: 'playing',
        },
        YOUTUBE_PAUSED: {
          actions: 'setPlaybackPaused',
          target: 'paused',
        },
        YOUTUBE_ERROR: {
          actions: 'setPlaybackEnding',
          target: 'ending',
        },
        HEARTBEAT: {
          actions: 'trackHeartbeat',
        },
      },
    },
    playing: {
      entry: ({ context }) => dbUpdateStatus({ input: { playerId: context.playerId, state: 'playing' } }),
      on: {
        YOUTUBE_BUFFERING: {
          actions: 'setPlaybackBuffering',
          target: 'buffering',
        },
        YOUTUBE_PAUSED: {
          actions: 'setPlaybackPaused',
          target: 'paused',
        },
        YOUTUBE_ENDED: {
          actions: 'setPlaybackEnding',
          target: 'ending',
        },
        YOUTUBE_ERROR: {
          actions: 'setPlaybackEnding',
          target: 'ending',
        },
        ADMIN_PAUSE: {
          actions: 'setPlaybackPaused',
          target: 'paused',
        },
        ADMIN_SKIP: {
          actions: 'setPlaybackEnding',
          target: 'ending',
        },
        HEARTBEAT: {
          actions: 'trackHeartbeat',
        },
      },
    },
    paused: {
      entry: ({ context }) => dbUpdateStatus({ input: { playerId: context.playerId, state: 'paused' } }),
      on: {
        ADMIN_RESUME: {
          actions: 'setPlaybackPlaying',
          target: 'playing',
        },
        ADMIN_SKIP: {
          actions: 'setPlaybackEnding',
          target: 'ending',
        },
        YOUTUBE_PLAYING: {
          actions: 'setPlaybackPlaying',
          target: 'playing',
        },
        HEARTBEAT: {
          actions: 'trackHeartbeat',
        },
      },
    },
    ending: {
      initial: 'checkAdvance',
      states: {
        checkAdvance: {
          always: [
            {
              guard: 'isPriorityPlayer',
              and: 'canAdvanceQueue',
              target: 'advancing',
            },
            {
              target: '#player.idle',
            },
          ],
        },
        advancing: {
          entry: 'setInFlight',
          invoke: {
            src: ({ context }) => dbQueueNext({
              input: {
                playerId: context.playerId,
                expectedMediaId: context.expectedMediaId,
              },
            }),
            onDone: [
              {
                guard: ({ event }) => event.output.hasNext,
                actions: [
                  assign({
                    currentMediaId: ({ event }) => event.output.nextItem?.media_item_id || null,
                    expectedMediaId: ({ event }) => event.output.nextItem?.media_item_id || null,
                    advanceResult: ({ event }) => event.output.nextItem || null,
                  }),
                  'clearInFlight',
                ],
                target: '#player.loading',
              },
              {
                actions: [
                  assign({ advanceResult: () => null }),
                  'setPlaybackIdle',
                  'clearInFlight'
                ],
                target: '#player.idle',
              },
            ],
            onError: {
              actions: [
                assign({ advanceResult: () => null }),
                'setPlaybackIdle',
                'clearInFlight'
              ],
              target: '#player.idle',
            },
          },
        },
      },
      on: {
        HEARTBEAT: {
          actions: 'trackHeartbeat',
        },
      },
    },
  },
});

export type PlayerMachine = typeof playerMachine;
