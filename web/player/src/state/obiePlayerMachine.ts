/**
 * obiePlayerMachine — XState v5
 *
 * Open in https://stately.ai/viz to see the full playback + master/slave +
 * realtime contract as an interactive diagram.
 *
 * Architecture: three parallel regions
 *   playback    — exact port of playbackReducer; structurally prevents impossible
 *                 transitions (e.g. YOUTUBE_ENDED only valid from 'playing')
 *   coordination — master/slave election, heartbeat actor, realtime actor,
 *                  priority-claim modal lifecycle, declined-claim guard
 *   media        — tracks currentMedia, settings, localVideoUrl from realtime
 *
 * Before: 17 useRef guards, 13 scattered useEffects, 3 advance paths.
 * After : single machine, 3 spawned actors, 1 queue-advance useEffect in App.tsx.
 *
 * ─── Event flow ──────────────────────────────────────────────────────────────
 *
 *  YouTube callbacks → App.tsx → actor.send({ type: 'YOUTUBE_*' })
 *       ↓ flows to playback region automatically (parallel)
 *
 *  Supabase Realtime → realtimeActor (sendParent) → machine root
 *       ↓ STATUS_UPDATE, SETTINGS_UPDATE, ADMIN_PAUSE/RESUME/SKIP,
 *         PRIORITY_LOST, PRIORITY_SELECTION_PENDING, MASTER_OFFLINE_CHANGE
 *
 *  Heartbeat timer → heartbeatActor (sendParent) → machine root
 *       ↓ HEARTBEAT_RESULT (raw DB data, machine guards derive meaning)
 *
 *  Queue advance — remains a single useEffect in App.tsx watching
 *  snapshot.matches({ playback: 'ending' }) + !context.inFlight.
 *  Fade is a browser API (non-serialisable ref) so it stays in React.
 *  The 7 playback-shaped events sent via actor.send() are:
 *    YOUTUBE_PLAYING, YOUTUBE_BUFFERING, YOUTUBE_PAUSED, YOUTUBE_ENDED,
 *    YOUTUBE_ERROR, ADMIN_PAUSE, ADMIN_RESUME
 *  (ADMIN_SKIP comes from realtime region; QUEUE_* from App advance effect)
 */

import { setup, assign, fromCallback, fromPromise } from 'xstate';
import { supabase, callPlayerControl, initializePlayerPlaylist } from '@shared/supabase-client';
import type { MediaItem, PlayerStatus, PlayerSettings } from '@shared/supabase-client';
import type { RealtimeChannel } from '@supabase/supabase-js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ObiePlayerContext {
  // Identity
  playerId: string;
  sessionId: string;
  // Coordination
  isMaster: boolean;
  isMasterOffline: boolean;
  showPriorityModal: boolean;
  pendingMasterId: string | null;
  declinedClaimForId: string | null;
  // Playback phase data (cross-region context)
  currentMediaId: string | null;
  currentMedia: MediaItem | null;
  isAfterSkip: boolean;
  pausedBy: 'admin' | 'user' | null;
  endReason: 'natural' | 'skip' | 'error' | null;
  inFlight: boolean;
  // Media / settings
  status: PlayerStatus | null;
  settings: PlayerSettings | null;
  localVideoUrl: string | null;
}

export type ObiePlayerEvent =
  // ── The 7 playback-shaped events (from YouTube callbacks via actor.send) ──
  | { type: 'YOUTUBE_PLAYING' }
  | { type: 'YOUTUBE_BUFFERING' }
  | { type: 'YOUTUBE_PAUSED' }
  | { type: 'YOUTUBE_ENDED' }
  | { type: 'YOUTUBE_ERROR'; code: number }
  | { type: 'ADMIN_PAUSE' }
  | { type: 'ADMIN_RESUME' }
  // ── Admin commands (also playback-shaped, from realtime actor) ──
  | { type: 'ADMIN_SKIP' }
  // ── Queue lifecycle (from App.tsx advance effect) ──
  | { type: 'QUEUE_NEXT_STARTED'; mediaId: string; media: MediaItem; isAfterSkip: boolean }
  | { type: 'QUEUE_EXHAUSTED' }
  | { type: 'ADVANCE_IN_FLIGHT' }
  | { type: 'ADVANCE_COMPLETE' }
  // ── Realtime / data updates (from realtimeActor) ──
  | { type: 'STATUS_UPDATE'; status: PlayerStatus }
  | { type: 'SETTINGS_UPDATE'; settings: PlayerSettings }
  // ── Coordination (from heartbeatActor + realtimeActor) ──
  | { type: 'PRIORITY_LOST' }
  | { type: 'PRIORITY_SELECTION_PENDING'; masterId: string | null }
  | { type: 'MASTER_OFFLINE_CHANGE'; offline: boolean }
  // ── Init result (from initActor) ──
  | { type: 'INIT_DONE'; isMaster: boolean; prioritySelectionPending: boolean; currentPriorityId: string | null }
  // ── Priority modal actions (from UI) ──
  | { type: 'CLAIM_PRIORITY' }
  | { type: 'DECLINE_PRIORITY' }
  // ── Hard reset ──
  | { type: 'RESET' };

// ─── Actor input types ────────────────────────────────────────────────────────

interface RealtimeActorInput { playerId: string }
interface HeartbeatActorInput { playerId: string }
interface InitActorInput { playerId: string; sessionId: string }
interface ClaimActorInput { playerId: string }

// ─── Realtime actor ──────────────────────────────────────────────────────────
// Single channel per tab — ONE Supabase channel with 3 postgres_changes listeners.
// Before: 3–4 separate channels (player_status, player_settings, queue,
//         priority-watch). Now: 1 channel with tight per-column filters.
// DB indexes required: players(id), player_status(player_id),
//                      player_settings(player_id)

export const realtimeActor = fromCallback<ObiePlayerEvent, RealtimeActorInput>(
  ({ input, sendBack }) => {
    const { playerId } = input;
    let prevState: string | null = null;
    // Tracks whether this actor instance has observed itself as master at least
    // once. Used to only send PRIORITY_LOST on a master→non-master transition,
    // not on every update for players that were always slaves.
    let wasMaster = false;
    let channel: RealtimeChannel;

    channel = supabase
      .channel(`player:${playerId}`, { config: { broadcast: { self: false } } })

      // ── player_status → derive ADMIN_* events + STATUS_UPDATE ──────────────
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'player_status',
          filter: `player_id=eq.${playerId}` },
        (payload) => {
          const newRow = payload.new as PlayerStatus;
          const newState = newRow.state;

          // Derive admin command events from genuine DB state changes
          if (prevState !== null && prevState !== newState) {
            if (newState === 'playing' && prevState === 'paused') {
              sendBack({ type: 'ADMIN_RESUME' });
            } else if (newState === 'paused' && (prevState === 'playing' || prevState === 'loading')) {
              sendBack({ type: 'ADMIN_PAUSE' });
            } else if (newState === 'idle' && (prevState === 'playing' || prevState === 'paused')) {
              sendBack({ type: 'ADMIN_SKIP' });
            }
          }
          prevState = newState;
          sendBack({ type: 'STATUS_UPDATE', status: newRow });
        }
      )

      // ── player_settings ────────────────────────────────────────────────────
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'player_settings',
          filter: `player_id=eq.${playerId}` },
        (payload) => {
          sendBack({ type: 'SETTINGS_UPDATE', settings: payload.new as PlayerSettings });
        }
      )

      // ── players (priority watch) ───────────────────────────────────────────
      // Fires when admin resets priority or another player claims master.
      // Requires: players table in Realtime publication + REPLICA IDENTITY FULL
      // (both set in migrations 20260419000003 and 20260419000004).
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'players',
          filter: `id=eq.${playerId}` },
        (payload) => {
          const row = payload.new as { priority_player_id: string | null; priority_selection_pending: boolean };

          // Track master status in closure so we only fire PRIORITY_LOST when
          // this actor has observed a master→non-master transition, not on every
          // update for players that were always slaves.
          if (row.priority_player_id === playerId) {
            wasMaster = true;
          } else if (wasMaster) {
            // Was master, now isn't — genuine demotion event
            sendBack({ type: 'PRIORITY_LOST' });
            wasMaster = false;
          }

          // Fire PRIORITY_SELECTION_PENDING whenever pending=true, regardless
          // of whether priority_player_id is null. Null means no master exists —
          // any player should be able to claim. The machine guard handles dedup.
          if (row.priority_selection_pending) {
            sendBack({ type: 'PRIORITY_SELECTION_PENDING', masterId: row.priority_player_id });
          }
        }
      )

      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }
);

// ─── Heartbeat actor ─────────────────────────────────────────────────────────
// Fires every 15 s. Calls player-control heartbeat, then reads priority state.
// Sends raw HEARTBEAT_RESULT — machine guards determine PRIORITY_LOST / modal.
// Also detects master-offline for slave players.

export const heartbeatActor = fromCallback<ObiePlayerEvent, HeartbeatActorInput>(
  ({ input, sendBack }) => {
    const { playerId } = input;

    // Explicit types because Supabase's generated types can't infer partial selects
    type PlayerRow = {
      priority_player_id:        string | null;
      priority_selection_pending: boolean;
      status:                    string | null;
    };

    const tick = async () => {
      try {
        await callPlayerControl({ player_id: playerId, action: 'heartbeat' });

        const { data: rawData } = await supabase
          .from('players')
          .select('priority_player_id, priority_selection_pending, status')
          .eq('id', playerId)
          .single();

        const data = rawData as PlayerRow | null;
        if (!data) return;

        // Check if current master is offline (for slave overlay)
        if (data.priority_player_id && data.priority_player_id !== playerId) {
          const { data: rawMaster } = await supabase
            .from('players')
            .select('status')
            .eq('id', data.priority_player_id)
            .single();
          const masterRow = rawMaster as { status: string | null } | null;
          const offline = !masterRow || masterRow.status !== 'online';
          sendBack({ type: 'MASTER_OFFLINE_CHANGE', offline });
        }

        // Forward priority state — machine guards enforce per-role behaviour.
        // PRIORITY_LOST: send even for non-masters; the isCurrentMaster guard
        // in the machine will discard it if this player is already a slave.
        if (data.priority_player_id !== playerId) {
          sendBack({ type: 'PRIORITY_LOST' });
        }
        // Send PRIORITY_SELECTION_PENDING whenever pending=true, regardless of
        // priority_player_id being null. Null means no master has been elected
        // yet — all players should be offered the chance to claim.
        if (data.priority_selection_pending) {
          sendBack({ type: 'PRIORITY_SELECTION_PENDING', masterId: data.priority_player_id });
        }
      } catch (e) {
        console.warn('[heartbeatActor] tick failed:', e);
      }
    };

    tick(); // Immediate first tick
    const id = setInterval(tick, 15_000);
    return () => clearInterval(id);
  }
);

// ─── Init actor ──────────────────────────────────────────────────────────────
// One-shot: initializes playlist, calls register_session, resolves master/slave.

export const initActor = fromPromise<
  { isMaster: boolean; prioritySelectionPending: boolean; currentPriorityId: string | null },
  InitActorInput
>(async ({ input }) => {
  const { playerId, sessionId } = input;

  await initializePlayerPlaylist(playerId);

  const storedPlayerId = localStorage.getItem('obie_priority_player_id');

  const result = await callPlayerControl({
    player_id:        playerId,
    action:           'register_session',
    session_id:       sessionId,
    stored_player_id: storedPlayerId ?? undefined,
  });

  const isMaster = !!result.is_priority;

  if (isMaster) {
    localStorage.setItem('obie_priority_player_id', playerId);
  } else if (storedPlayerId === playerId) {
    localStorage.removeItem('obie_priority_player_id');
  }

  return {
    isMaster,
    prioritySelectionPending: !!result.priority_selection_pending,
    currentPriorityId: (result as any).current_priority_id ?? null,
  };
});

// ─── Claim priority actor ────────────────────────────────────────────────────

export const claimPriorityActor = fromPromise<void, ClaimActorInput>(
  async ({ input }) => {
    await callPlayerControl({ player_id: input.playerId, action: 'claim_priority' });
    localStorage.setItem('obie_priority_player_id', input.playerId);
  }
);

// ─── Machine ──────────────────────────────────────────────────────────────────

export const obiePlayerMachine = setup({
  types: {
    context: {} as ObiePlayerContext,
    events:  {} as ObiePlayerEvent,
    input:   {} as { playerId: string; sessionId: string },
  },
  actors: {
    realtimeActor,
    heartbeatActor,
    initActor,
    claimPriorityActor,
  },
  guards: {
    // Coordination guards
    isMasterResult: ({ event }) =>
      event.type === 'INIT_DONE' && event.isMaster,
    hasModalPending: ({ event }) =>
      event.type === 'INIT_DONE' && event.prioritySelectionPending,
    isCurrentMaster: ({ context }) => context.isMaster,
    notDeclinedForThisMaster: ({ context, event }) => {
      if (event.type !== 'PRIORITY_SELECTION_PENDING') return false;
      return context.declinedClaimForId !== event.masterId;
    },
    // Playback guards
    canAdvance: ({ context }) =>
      context.endReason !== null && !context.inFlight,
    hasNextMedia: ({ event }) =>
      event.type === 'QUEUE_NEXT_STARTED',
  },
  actions: {
    // Context updates — coordination
    assignInitResult: assign({
      isMaster:       ({ event }) => event.type === 'INIT_DONE' ? event.isMaster : false,
      showPriorityModal: ({ event }) =>
        event.type === 'INIT_DONE' ? event.prioritySelectionPending : false,
      pendingMasterId: ({ event }) =>
        event.type === 'INIT_DONE' ? event.currentPriorityId : null,
    }),
    assignPriorityLost: assign({
      isMaster: false,
      showPriorityModal: false,
    }),
    assignPrioritySelectionPending: assign({
      showPriorityModal: true,
      pendingMasterId: ({ event }) =>
        event.type === 'PRIORITY_SELECTION_PENDING' ? event.masterId : null,
    }),
    assignClaimed: assign({
      isMaster: true,
      showPriorityModal: false,
      declinedClaimForId: null,
      pendingMasterId: null,
    }),
    assignDeclined: assign({
      showPriorityModal: false,
      declinedClaimForId: ({ context }) => context.pendingMasterId,
    }),
    assignMasterOffline: assign({
      isMasterOffline: ({ event }) =>
        event.type === 'MASTER_OFFLINE_CHANGE' ? event.offline : false,
    }),
    // Context updates — media / status
    assignStatusUpdate: assign({
      status: ({ event }) => event.type === 'STATUS_UPDATE' ? event.status : null,
      localVideoUrl: ({ context, event }) => {
        if (event.type !== 'STATUS_UPDATE') return context.localVideoUrl;
        const s = event.status;
        if ((s.source === 'local' || s.source === 'cloudflare') && s.local_url) {
          return s.local_url;
        }
        if (s.source === 'youtube') return null;
        return context.localVideoUrl;
      },
    }),
    assignSettingsUpdate: assign({
      settings: ({ event }) => event.type === 'SETTINGS_UPDATE' ? event.settings : null,
    }),
    // Playback context updates
    assignNextMedia: assign({
      currentMediaId: ({ event }) =>
        event.type === 'QUEUE_NEXT_STARTED' ? event.mediaId : null,
      currentMedia: ({ event }) =>
        event.type === 'QUEUE_NEXT_STARTED' ? event.media : null,
      isAfterSkip: ({ event }) =>
        event.type === 'QUEUE_NEXT_STARTED' ? event.isAfterSkip : false,
      inFlight: false,
    }),
    assignQueueExhausted: assign({
      currentMediaId: null,
      currentMedia:   null,
      inFlight:       false,
    }),
    assignEndReason: assign({
      endReason: ({ event }) => {
        if (event.type === 'YOUTUBE_ENDED') return 'natural';
        if (event.type === 'YOUTUBE_ERROR') return 'error';
        if (event.type === 'ADMIN_SKIP')    return 'skip';
        return 'natural';
      },
      inFlight: false,
    }),
    setInFlight: assign({ inFlight: true }),
    setPausedByUser:  assign({ pausedBy: 'user'  as const }),
    setPausedByAdmin: assign({ pausedBy: 'admin' as const }),
    clearEndState: assign({
      endReason: null,
      inFlight: false,
      pausedBy: null,
    }),
  },
}).createMachine({
  id: 'obiePlayer',
  type: 'parallel',

  context: ({ input }) => ({
    playerId:            input.playerId,
    sessionId:           input.sessionId,
    isMaster:            false,
    isMasterOffline:     false,
    showPriorityModal:   false,
    pendingMasterId:     null,
    declinedClaimForId:  null,
    currentMediaId:      null,
    currentMedia:        null,
    isAfterSkip:         false,
    pausedBy:            null,
    endReason:           null,
    inFlight:            false,
    status:              null,
    settings:            null,
    localVideoUrl:       null,
  }),

  // Root-level handlers for events that affect multiple regions
  on: {
    STATUS_UPDATE:         { actions: 'assignStatusUpdate' },
    SETTINGS_UPDATE:       { actions: 'assignSettingsUpdate' },
    MASTER_OFFLINE_CHANGE: { actions: 'assignMasterOffline' },
    RESET: {
      // Hard reset — re-enter both parallel regions
      target: ['#obiePlayer.playback.idle', '#obiePlayer.coordination.ready'],
      actions: assign({
        currentMediaId: null, currentMedia: null,
        endReason: null, inFlight: false, pausedBy: null,
        isAfterSkip: false,
      }),
    },
  },

  states: {
    // ══════════════════════════════════════════════════════════════════════════
    // PLAYBACK — exact port of playbackReducer
    // Invalid transitions are structurally absent (not guarded) — XState drops
    // events with no matching transition, giving us the same "stale event guard"
    // behavior for free.
    // ══════════════════════════════════════════════════════════════════════════
    playback: {
      initial: 'idle',
      // QUEUE_EXHAUSTED from any state → idle (unconditional in original reducer)
      on: {
        QUEUE_EXHAUSTED: {
          target: '.idle',
          actions: 'assignQueueExhausted',
        },
      },
      states: {
        idle: {
          entry: 'clearEndState',
          on: {
            QUEUE_NEXT_STARTED: {
              target: 'loading',
              actions: 'assignNextMedia',
            },
          },
        },

        loading: {
          on: {
            // YOUTUBE_PLAYING from loading is valid (fast load, no buffer)
            YOUTUBE_PLAYING:   { target: 'playing' },
            YOUTUBE_BUFFERING: { target: 'buffering' },
            YOUTUBE_PAUSED:    { target: 'paused', actions: 'setPausedByUser' },
            YOUTUBE_ERROR:     { target: 'ending', actions: 'assignEndReason' },
            QUEUE_NEXT_STARTED: { target: 'loading', actions: 'assignNextMedia' },
          },
        },

        buffering: {
          on: {
            YOUTUBE_PLAYING:   { target: 'playing' },
            YOUTUBE_PAUSED:    { target: 'paused', actions: 'setPausedByUser' },
            YOUTUBE_ERROR:     { target: 'ending', actions: 'assignEndReason' },
            ADMIN_PAUSE:       { target: 'paused', actions: 'setPausedByAdmin' },
            ADMIN_SKIP:        { target: 'ending', actions: 'assignEndReason' },
            QUEUE_NEXT_STARTED: { target: 'loading', actions: 'assignNextMedia' },
          },
        },

        playing: {
          on: {
            YOUTUBE_BUFFERING: { target: 'buffering' },
            YOUTUBE_PAUSED:    { target: 'paused', actions: 'setPausedByUser' },
            // CRITICAL: YOUTUBE_ENDED only valid from 'playing'. Stale ENDED
            // events from a previous video are dropped automatically — no guard needed.
            YOUTUBE_ENDED:     { target: 'ending', actions: 'assignEndReason' },
            YOUTUBE_ERROR:     { target: 'ending', actions: 'assignEndReason' },
            ADMIN_PAUSE:       { target: 'paused', actions: 'setPausedByAdmin' },
            ADMIN_SKIP:        { target: 'ending', actions: 'assignEndReason' },
          },
        },

        paused: {
          on: {
            YOUTUBE_PLAYING:   { target: 'playing' },
            YOUTUBE_BUFFERING: { target: 'buffering' },
            ADMIN_RESUME:      { target: 'playing' },
            ADMIN_SKIP:        { target: 'ending', actions: 'assignEndReason' },
            QUEUE_NEXT_STARTED: { target: 'loading', actions: 'assignNextMedia' },
          },
        },

        ending: {
          // App.tsx useEffect watches: matches({ playback: 'ending' }) && !context.inFlight
          // → calls advance() which dispatches ADVANCE_IN_FLIGHT, then
          //   QUEUE_NEXT_STARTED or QUEUE_EXHAUSTED when the edge-fn responds.
          on: {
            ADVANCE_IN_FLIGHT: { actions: 'setInFlight' },
            QUEUE_NEXT_STARTED: {
              target: 'loading',
              actions: 'assignNextMedia',
            },
            // QUEUE_EXHAUSTED handled at parent level (any state → idle)
          },
        },
      },
    },

    // ══════════════════════════════════════════════════════════════════════════
    // COORDINATION — master/slave election, heartbeat, realtime, priority modal
    // ══════════════════════════════════════════════════════════════════════════
    coordination: {
      initial: 'resolving',
      states: {
        resolving: {
          invoke: {
            id:  'init',
            src: 'initActor',
            input: ({ context }) => ({
              playerId:  context.playerId,
              sessionId: context.sessionId,
            }),
            onDone: {
              target: 'ready',
              actions: assign({
                isMaster: ({ event }) => event.output.isMaster,
                showPriorityModal: ({ event }) => event.output.prioritySelectionPending,
                pendingMasterId: ({ event }) => event.output.currentPriorityId,
              }),
            },
            onError: {
              // Init failed — default to slave, still enter ready so realtime/heartbeat starts
              target: 'ready',
              actions: assign({ isMaster: false }),
            },
          },
        },

        ready: {
          // Both master and slave run realtime + heartbeat. Guards enforce per-role behaviour.
          invoke: [
            {
              id:    'realtime',
              src:   'realtimeActor',
              input: ({ context }) => ({ playerId: context.playerId }),
            },
            {
              id:    'heartbeat',
              src:   'heartbeatActor',
              input: ({ context }) => ({ playerId: context.playerId }),
            },
          ],
          on: {
            // Master lost priority (heartbeat detected or realtime push)
            PRIORITY_LOST: {
              guard: 'isCurrentMaster',
              actions: [
                'assignPriorityLost',
                () => localStorage.removeItem('obie_priority_player_id'),
              ],
            },

            // Admin reset pending — show modal only if not already declined for this master
            PRIORITY_SELECTION_PENDING: {
              guard: 'notDeclinedForThisMaster',
              actions: 'assignPrioritySelectionPending',
            },

            // User clicks "Yes — Set as MASTER" in PriorityClaimModal
            CLAIM_PRIORITY: {
              target: 'claiming',
            },

            // User clicks "No — Stay as Slave" or modal auto-dismisses
            DECLINE_PRIORITY: {
              actions: 'assignDeclined',
            },
          },
        },

        claiming: {
          invoke: {
            id:  'claimPriority',
            src: 'claimPriorityActor',
            input: ({ context }) => ({ playerId: context.playerId }),
            onDone:  { target: 'ready', actions: 'assignClaimed' },
            onError: { target: 'ready' }, // Claim failed — stay as slave, close modal
          },
        },
      },
    },
  },
});

// ─── Selectors (used in App.tsx) ──────────────────────────────────────────────

export type ObiePlayerSnapshot = ReturnType<typeof obiePlayerMachine.transition>;

/** True when the machine is in ending state and no advance is in-flight. */
export function selectCanAdvance(ctx: ObiePlayerContext): boolean {
  return ctx.endReason !== null && !ctx.inFlight;
}

/** True when we should fade before advancing (skip, not error or natural). */
export function selectNeedsFadeBeforeAdvance(ctx: ObiePlayerContext): boolean {
  return ctx.endReason === 'skip';
}
