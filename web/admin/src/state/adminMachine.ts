/**
 * adminMachine — XState v5
 *
 * Open in https://stately.ai/viz to see the full admin state contract.
 *
 * Parallel regions:
 *   auth          — unauthenticated → resolving → authenticated → error
 *   operations    — play/pause (400ms debounce), skip (3s cooldown),
 *                   shuffle, radio, reorder — all guarded as sub-machines
 *   subscriptions — single Supabase channel per active player ID
 *
 * XState v5 rule: ALL invoke.src values must be registered in setup({ actors }).
 * Inline fromPromise() is rejected by the strict types from setup(). Each async
 * operation is extracted to a named actor below and registered in setup.
 *
 * Realtime optimisation: subscriptionsActor creates ONE channel per player:
 *   admin:${playerId} — queue + player_status + player_settings + kiosk_sessions
 * Plus per-player channels for the Connected Devices panel.
 * DB indexes required: queue(player_id), player_status(player_id),
 *   player_settings(player_id), kiosk_sessions(player_id), players(id)
 */

import { setup, assign, fromCallback, fromPromise } from 'xstate';
import { arrayMove } from '@dnd-kit/sortable';
import type { DragEndEvent } from '@dnd-kit/core';
import {
  supabase,
  callQueueManager,
  callPlayerControl,
  callRadioGenerator,
  getCurrentUser,
  getUserPlayerId,
  getMyJukeboxes,
  resolveJukeboxSlug,
  getPlayersByIds,
  getKioskSessions,
  type Player,
  type PlayerStatus,
  type PlayerSettings,
  type QueueItem,
  type AuthUser,
  type JukeboxSummary,
  type KioskSession,
} from '@shared/supabase-client';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AdminContext {
  user: AuthUser | null;
  routeSlug: string;
  activePlayerId: string | null;
  activeJukeboxSlug: string | null;
  availableJukeboxes: JukeboxSummary[];
  resolveError: string | null;
  queue: QueueItem[];
  status: PlayerStatus | null;
  settings: PlayerSettings | null;
  players: Player[];
  kioskSessions: KioskSession[];
  activePlaylistName: string | null;
  isSkipping: boolean;
  isShuffling: boolean;
  isGeneratingRadio: boolean;
  playPauseInFlight: boolean;
  pendingRadioSource: 'now_playing' | 'history' | 'playlist';
}

export type AdminEvent =
  | { type: 'AUTH_CHANGE'; user: AuthUser | null }
  | { type: 'SIGN_OUT' }
  | { type: 'ROUTE_CHANGE'; slug: string }
  | { type: 'SWITCH_JUKEBOX'; slug: string }
  | { type: 'QUEUE_UPDATE'; items: QueueItem[] }
  | { type: 'STATUS_UPDATE'; status: PlayerStatus }
  | { type: 'SETTINGS_UPDATE'; settings: PlayerSettings }
  | { type: 'PLAYER_UPDATE'; player: Player }
  | { type: 'KIOSK_UPDATE'; sessions: KioskSession[] }
  | { type: 'PLAYERS_LOADED'; players: Player[] }
  | { type: 'PLAYLIST_NAME_LOADED'; name: string | null }
  | { type: 'PLAY_PAUSE' }
  | { type: 'SKIP' }
  | { type: 'REMOVE_QUEUE_ITEM'; queueId: string }
  | { type: 'REORDER_QUEUE'; event: DragEndEvent }
  | { type: 'SHUFFLE' }
  | { type: 'START_RADIO'; source: 'now_playing' | 'history' | 'playlist' };

// ─── Actor input types ────────────────────────────────────────────────────────

interface SubscriptionsInput { playerId: string; playerIds: string[] }
interface ResolveInput { routeSlug: string; fallbackPlayerId: string }
interface PlayPauseInput { status: PlayerStatus | null; playerId: string }
interface SkipInput { playerId: string }
interface ShuffleInput { playerId: string }
interface RadioInput { playerId: string; source: 'now_playing' | 'history' | 'playlist' }

// ─── Named actors — ALL must be registered in setup() ────────────────────────

/** Fetches the current user on initial load. */
export const loadCurrentUserActor = fromPromise(
  async (): Promise<{ user: AuthUser | null }> => {
    const user = await getCurrentUser();
    return { user };
  }
);

/** Resolves jukebox slug → player_id with retry. */
export const resolveActor = fromPromise<
  { playerId: string; jukeboxSlug: string | null; jukeboxes: JukeboxSummary[] },
  ResolveInput
>(async ({ input, signal }) => {
  const { routeSlug, fallbackPlayerId } = input;
  const myJukeboxes = await getMyJukeboxes();

  if (routeSlug) {
    const resolved = await resolveJukeboxSlug(routeSlug);
    if (!resolved) throw new Error(`Jukebox "${routeSlug}" was not found.`);
    const hasAccess = myJukeboxes.some(j => j.player_id === resolved.player_id);
    if (!hasAccess) throw new Error(`You do not have access to jukebox "${resolved.jukebox_slug}".`);
    return { playerId: resolved.player_id, jukeboxSlug: resolved.jukebox_slug, jukeboxes: myJukeboxes };
  }

  if (myJukeboxes.length > 0) {
    const first = myJukeboxes[0];
    return { playerId: first.player_id, jukeboxSlug: first.jukebox_slug, jukeboxes: myJukeboxes };
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    if (signal.aborted) throw new Error('aborted');
    const id = await getUserPlayerId();
    if (id) return { playerId: id, jukeboxSlug: null, jukeboxes: [] };
    await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
  }

  return { playerId: fallbackPlayerId, jukeboxSlug: null, jukeboxes: [] };
});

/** Toggle play/pause with compare-and-swap guard on the server. */
export const playPauseActor = fromPromise<void, PlayPauseInput>(
  async ({ input }) => {
    const currentState = input.status?.state;
    if (currentState !== 'playing' && currentState !== 'paused') return;
    const newState = currentState === 'playing' ? 'paused' : 'playing';
    await callPlayerControl({
      player_id:      input.playerId,
      state:          newState,
      action:         'update',
      expected_state: currentState,
    } as any);
  }
);

/** Skip current track. */
export const skipActor = fromPromise<void, SkipInput>(
  async ({ input }) => {
    await callPlayerControl({ player_id: input.playerId, state: 'idle', action: 'skip' });
  }
);

/** Shuffle the normal queue. */
export const shuffleActor = fromPromise<void, ShuffleInput>(
  async ({ input }) => {
    await callQueueManager({ player_id: input.playerId, action: 'shuffle', type: 'normal' });
  }
);

/** Generate radio suggestions. */
export const radioActor = fromPromise<void, RadioInput>(
  async ({ input }) => {
    await callRadioGenerator({ player_id: input.playerId, action: 'generate', source: input.source });
  }
);

/** Single Supabase channel for all live-data subscriptions. */
export const subscriptionsActor = fromCallback<AdminEvent, SubscriptionsInput>(
  ({ input, sendBack }) => {
    const { playerId, playerIds } = input;

    const primary = supabase
      .channel(`admin:${playerId}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'queue',
        filter: `player_id=eq.${playerId}`,
      }, async () => {
        const { data } = await supabase
          .from('queue')
          .select('id,player_id,type,media_item_id,position,requested_by,requested_at,played_at,expires_at,media_item:media_items(*)')
          .eq('player_id', playerId)
          .is('played_at', null)
          .order('type', { ascending: false })
          .order('position', { ascending: true });
        if (data) sendBack({ type: 'QUEUE_UPDATE', items: data as QueueItem[] });
      })
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'player_status',
        filter: `player_id=eq.${playerId}`,
      }, (payload) => {
        sendBack({ type: 'STATUS_UPDATE', status: payload.new as PlayerStatus });
      })
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'player_settings',
        filter: `player_id=eq.${playerId}`,
      }, (payload) => {
        sendBack({ type: 'SETTINGS_UPDATE', settings: payload.new as PlayerSettings });
      })
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'kiosk_sessions',
        filter: `player_id=eq.${playerId}`,
      }, async () => {
        const sessions = await getKioskSessions(playerId).catch(() => [] as KioskSession[]);
        sendBack({ type: 'KIOSK_UPDATE', sessions });
      })
      .subscribe();

    const playerChannels = playerIds.map(pid =>
      supabase
        .channel(`admin:player:${pid}`)
        .on('postgres_changes', {
          event: 'UPDATE', schema: 'public', table: 'players',
          filter: `id=eq.${pid}`,
        }, (payload) => {
          sendBack({ type: 'PLAYER_UPDATE', player: payload.new as Player });
        })
        .subscribe()
    );

    const kioskPoll = setInterval(async () => {
      const sessions = await getKioskSessions(playerId).catch(() => [] as KioskSession[]);
      sendBack({ type: 'KIOSK_UPDATE', sessions });
    }, 60_000);

    // Initial fetch — cast Supabase partial-select results to avoid `never` inference
    (async () => {
      const [queueData, statusData, settingsData, kioskData, playerData] = await Promise.allSettled([
        supabase.from('queue')
          .select('id,player_id,type,media_item_id,position,requested_by,requested_at,played_at,expires_at,media_item:media_items(*)')
          .eq('player_id', playerId).is('played_at', null)
          .order('type', { ascending: false }).order('position', { ascending: true }),
        supabase.from('player_status').select('*,current_media:media_items(*)').eq('player_id', playerId).single(),
        supabase.from('player_settings').select('*').eq('player_id', playerId).single(),
        getKioskSessions(playerId),
        getPlayersByIds(playerIds),
      ]);

      if (queueData.status === 'fulfilled' && queueData.value.data)
        sendBack({ type: 'QUEUE_UPDATE', items: queueData.value.data as QueueItem[] });
      if (statusData.status === 'fulfilled') {
        const d = (statusData.value as any).data as PlayerStatus | null;
        if (d) sendBack({ type: 'STATUS_UPDATE', status: d });
      }
      if (settingsData.status === 'fulfilled') {
        const d = (settingsData.value as any).data as PlayerSettings | null;
        if (d) sendBack({ type: 'SETTINGS_UPDATE', settings: d });
      }
      if (kioskData.status === 'fulfilled')
        sendBack({ type: 'KIOSK_UPDATE', sessions: kioskData.value });
      if (playerData.status === 'fulfilled')
        sendBack({ type: 'PLAYERS_LOADED', players: playerData.value });
    })();

    return () => {
      clearInterval(kioskPoll);
      supabase.removeChannel(primary);
      playerChannels.forEach(ch => supabase.removeChannel(ch));
    };
  }
);

// ─── Machine ──────────────────────────────────────────────────────────────────

const FALLBACK_PLAYER_ID = (typeof import.meta !== 'undefined' ? (import.meta as any).env?.VITE_PLAYER_ID : undefined)
  ?? '00000000-0000-0000-0000-000000000001';

export const adminMachine = setup({
  types: {
    context: {} as AdminContext,
    events:  {} as AdminEvent,
    input:   {} as { routeSlug: string },
  },
  actors: {
    loadCurrentUserActor,
    resolveActor,
    playPauseActor,
    skipActor,
    shuffleActor,
    radioActor,
    subscriptionsActor,
  },
  guards: {
    hasActivePlayer: ({ context }) => context.activePlayerId !== null,
    canPlayPause: ({ context }) => {
      if (context.isSkipping || context.playPauseInFlight) return false;
      const s = context.status?.state;
      return s === 'playing' || s === 'paused';
    },
    canSkip:     ({ context }) => !context.isSkipping,
    canShuffle:  ({ context }) => context.queue.filter(i => i.type === 'normal').length > 1,
  },
  actions: {
    assignUser:     assign({ user: ({ event }) => (event as Extract<AdminEvent, { type: 'AUTH_CHANGE' }>).user }),
    assignQueueUpdate:    assign({ queue:    ({ event }) => (event as Extract<AdminEvent, { type: 'QUEUE_UPDATE'    }>).items }),
    assignStatusUpdate:   assign({ status:   ({ event }) => (event as Extract<AdminEvent, { type: 'STATUS_UPDATE'   }>).status }),
    assignSettingsUpdate: assign({ settings: ({ event }) => (event as Extract<AdminEvent, { type: 'SETTINGS_UPDATE' }>).settings }),
    assignKioskUpdate:    assign({ kioskSessions: ({ event }) => (event as Extract<AdminEvent, { type: 'KIOSK_UPDATE' }>).sessions }),
    assignPlayersLoaded:  assign({ players:  ({ event }) => (event as Extract<AdminEvent, { type: 'PLAYERS_LOADED'  }>).players }),
    assignPlayerUpdate:   assign({
      players: ({ context, event }) => {
        const e = event as Extract<AdminEvent, { type: 'PLAYER_UPDATE' }>;
        const idx = context.players.findIndex(p => p.id === e.player.id);
        if (idx === -1) return [...context.players, e.player];
        const next = [...context.players]; next[idx] = e.player; return next;
      },
    }),
    assignPlaylistName: assign({
      activePlaylistName: ({ event }) => (event as Extract<AdminEvent, { type: 'PLAYLIST_NAME_LOADED' }>).name,
    }),
    setPlayPauseInFlight:   assign({ playPauseInFlight: true }),
    clearPlayPauseInFlight: assign({ playPauseInFlight: false }),
    setSkipping:    assign({ isSkipping: true }),
    clearSkipping:  assign({ isSkipping: false }),
    setShuffling:   assign({ isShuffling: true }),
    clearShuffling: assign({ isShuffling: false }),
    setGeneratingRadio:   assign({ isGeneratingRadio: true }),
    clearGeneratingRadio: assign({ isGeneratingRadio: false }),
    clearUser: assign({
      user: null, activePlayerId: null, activeJukeboxSlug: null,
      availableJukeboxes: [], queue: [], status: null, settings: null,
    }),
    optimisticRemoveQueue: assign({
      queue: ({ context, event }) => {
        const e = event as Extract<AdminEvent, { type: 'REMOVE_QUEUE_ITEM' }>;
        return context.queue.filter(i => i.id !== e.queueId);
      },
    }),
    optimisticReorder: assign({
      queue: ({ context, event }) => {
        const e = event as Extract<AdminEvent, { type: 'REORDER_QUEUE' }>;
        const { active, over } = e.event;
        if (!over || active.id === over.id) return context.queue;
        const currentMediaId = context.status?.current_media_id;
        const normal = context.queue.filter(i => i.type === 'normal' && i.media_item_id !== currentMediaId && i.id);
        const oldIdx = normal.findIndex(i => i.id === active.id);
        const newIdx = normal.findIndex(i => i.id === over.id);
        const reordered = arrayMove(normal, oldIdx, newIdx);
        const priority = context.queue.filter(i => i.type === 'priority');
        const current  = context.queue.filter(i => i.media_item_id === currentMediaId);
        return [...current, ...priority, ...reordered];
      },
    }),
    optimisticSkipQueue: assign({
      queue: ({ context }) => {
        const currentMediaId = context.status?.current_media_id;
        return currentMediaId ? context.queue.filter(q => q.media_item_id !== currentMediaId) : context.queue;
      },
    }),
    storePendingRadioSource: assign({
      pendingRadioSource: ({ event }) =>
        (event as Extract<AdminEvent, { type: 'START_RADIO' }>).source,
    }),
    doRemoveQueueItem: ({ context, event }) => {
      const e = event as Extract<AdminEvent, { type: 'REMOVE_QUEUE_ITEM' }>;
      callQueueManager({ player_id: context.activePlayerId!, action: 'remove', queue_id: e.queueId })
        .catch(console.error);
    },
    doReorderQueue: ({ context, event }) => {
      const e = event as Extract<AdminEvent, { type: 'REORDER_QUEUE' }>;
      const { active, over } = e.event;
      if (!over || active.id === over.id) return;
      const currentMediaId = context.status?.current_media_id;
      const normal = context.queue.filter(i => i.type === 'normal' && i.media_item_id !== currentMediaId && i.id);
      const oldIdx = normal.findIndex(i => i.id === active.id);
      const newIdx = normal.findIndex(i => i.id === over.id);
      const reordered = arrayMove(normal, oldIdx, newIdx);
      const ids = Array.from(new Set(reordered.map(i => i.id).filter(Boolean))) as string[];
      callQueueManager({ player_id: context.activePlayerId!, action: 'reorder', queue_ids: ids, type: 'normal' })
        .catch(console.error);
    },
  },
}).createMachine({
  id: 'admin',
  type: 'parallel',

  context: ({ input }) => ({
    user:                null,
    routeSlug:           input.routeSlug,
    activePlayerId:      null,
    activeJukeboxSlug:   null,
    availableJukeboxes:  [],
    resolveError:        null,
    queue:               [],
    status:              null,
    settings:            null,
    players:             [],
    kioskSessions:       [],
    activePlaylistName:  null,
    isSkipping:          false,
    isShuffling:         false,
    isGeneratingRadio:   false,
    playPauseInFlight:   false,
    pendingRadioSource:  'history' as const,
  }),

  on: {
    QUEUE_UPDATE:         { actions: 'assignQueueUpdate' },
    STATUS_UPDATE:        { actions: 'assignStatusUpdate' },
    SETTINGS_UPDATE:      { actions: 'assignSettingsUpdate' },
    KIOSK_UPDATE:         { actions: 'assignKioskUpdate' },
    PLAYER_UPDATE:        { actions: 'assignPlayerUpdate' },
    PLAYERS_LOADED:       { actions: 'assignPlayersLoaded' },
    PLAYLIST_NAME_LOADED: { actions: 'assignPlaylistName' },
    ROUTE_CHANGE:  { actions: assign({ routeSlug: ({ event }) => event.slug }) },
    AUTH_CHANGE:   [
      { guard: ({ event }) => event.user !== null, actions: 'assignUser' },
      { actions: 'clearUser' },
    ],
  },

  states: {
    // ══════════════════════════════════════════════════════════════════════════
    // AUTH
    // ══════════════════════════════════════════════════════════════════════════
    auth: {
      initial: 'loading',
      states: {
        loading: {
          invoke: {
            src:    'loadCurrentUserActor',
            onDone: [
              {
                guard:   ({ event }) => event.output.user !== null,
                target:  'resolving',
                actions: assign({ user: ({ event }) => event.output.user }),
              },
              { target: 'unauthenticated' },
            ],
            onError: { target: 'unauthenticated' },
          },
        },

        unauthenticated: {
          on: {
            AUTH_CHANGE: {
              guard:   ({ event }) => event.user !== null,
              target:  'resolving',
              actions: 'assignUser',
            },
          },
        },

        resolving: {
          invoke: {
            src:   'resolveActor',
            input: ({ context }) => ({
              routeSlug:        context.routeSlug,
              fallbackPlayerId: FALLBACK_PLAYER_ID,
            }),
            onDone: {
              target: 'authenticated',
              actions: assign({
                activePlayerId:     ({ event }) => event.output.playerId,
                activeJukeboxSlug:  ({ event }) => event.output.jukeboxSlug,
                availableJukeboxes: ({ event }) => event.output.jukeboxes,
                resolveError:       null,
              }),
            },
            onError: {
              target: 'error',
              actions: assign({
                resolveError: ({ event }) => (event.error as Error).message,
              }),
            },
          },
          on: {
            ROUTE_CHANGE:    { target: 'resolving', actions: assign({ routeSlug: ({ event }) => event.slug }) },
            SWITCH_JUKEBOX:  { target: 'resolving', actions: assign({ routeSlug: ({ event }) => event.slug }) },
          },
        },

        authenticated: {
          on: {
            SIGN_OUT:       { target: 'unauthenticated', actions: 'clearUser' },
            ROUTE_CHANGE:   { target: 'resolving', actions: assign({ routeSlug: ({ event }) => event.slug }) },
            SWITCH_JUKEBOX: { target: 'resolving', actions: assign({ routeSlug: ({ event }) => event.slug }) },
          },
        },

        error: {
          on: {
            AUTH_CHANGE:    { guard: ({ event }) => event.user !== null, target: 'resolving', actions: 'assignUser' },
            SWITCH_JUKEBOX: { target: 'resolving', actions: assign({ routeSlug: ({ event }) => event.slug }) },
          },
        },
      },
    },

    // ══════════════════════════════════════════════════════════════════════════
    // SUBSCRIPTIONS
    // ══════════════════════════════════════════════════════════════════════════
    subscriptions: {
      initial: 'idle',
      states: {
        idle: {
          always: { guard: 'hasActivePlayer', target: 'active' },
        },
        active: {
          invoke: {
            id:  'subscriptions',
            src: 'subscriptionsActor',
            input: ({ context }) => ({
              playerId:  context.activePlayerId!,
              playerIds: context.availableJukeboxes.map(j => j.player_id),
            }),
          },
          on: {
            // Re-subscribe when the active player changes
            ROUTE_CHANGE:   { target: 'idle' },
            SWITCH_JUKEBOX: { target: 'idle' },
          },
        },
      },
    },

    // ══════════════════════════════════════════════════════════════════════════
    // OPERATIONS
    // ══════════════════════════════════════════════════════════════════════════
    operations: {
      type: 'parallel',
      states: {

        playPause: {
          initial: 'idle',
          states: {
            idle: {
              on: {
                PLAY_PAUSE: {
                  guard:   'canPlayPause',
                  target:  'inFlight',
                  actions: 'setPlayPauseInFlight',
                },
              },
            },
            inFlight: {
              invoke: {
                src:   'playPauseActor',
                input: ({ context }) => ({ status: context.status, playerId: context.activePlayerId! }),
                onDone:  { target: 'debounce' },
                onError: { target: 'debounce' },
              },
            },
            // Hold 400ms — covers Realtime round-trip, prevents toggle-loop
            debounce: {
              after: { 400: { target: 'idle', actions: 'clearPlayPauseInFlight' } },
            },
          },
        },

        skip: {
          initial: 'idle',
          states: {
            idle: {
              on: {
                SKIP: {
                  guard:   'canSkip',
                  target:  'inFlight',
                  actions: ['setSkipping', 'optimisticSkipQueue'],
                },
              },
            },
            inFlight: {
              invoke: {
                src:   'skipActor',
                input: ({ context }) => ({ playerId: context.activePlayerId! }),
                onDone:  { target: 'cooldown' },
                onError: { target: 'idle', actions: 'clearSkipping' },
              },
            },
            cooldown: {
              after: { 3000: { target: 'idle', actions: 'clearSkipping' } },
              on: {
                STATUS_UPDATE: {
                  guard:   ({ event }) => event.status.state === 'playing' || event.status.state === 'loading',
                  target:  'idle',
                  actions: 'clearSkipping',
                },
              },
            },
          },
        },

        queueOps: {
          initial: 'idle',
          states: {
            idle: {
              on: {
                REMOVE_QUEUE_ITEM: { actions: ['optimisticRemoveQueue', 'doRemoveQueueItem'] },
                REORDER_QUEUE:     { actions: ['optimisticReorder', 'doReorderQueue'] },
              },
            },
          },
        },

        shuffle: {
          initial: 'idle',
          states: {
            idle: {
              on: {
                SHUFFLE: {
                  guard:   'canShuffle',
                  target:  'inFlight',
                  actions: 'setShuffling',
                },
              },
            },
            inFlight: {
              invoke: {
                src:   'shuffleActor',
                input: ({ context }) => ({ playerId: context.activePlayerId! }),
                onDone:  { target: 'idle', actions: 'clearShuffling' },
                onError: { target: 'idle', actions: 'clearShuffling' },
              },
            },
          },
        },

        radio: {
          initial: 'idle',
          states: {
            idle: {
              on: {
                START_RADIO: {
                  target:  'inFlight',
                  actions: ['setGeneratingRadio', 'storePendingRadioSource'],
                },
              },
            },
            inFlight: {
              invoke: {
                src:   'radioActor',
                input: ({ context }) => ({
                  playerId: context.activePlayerId!,
                  source:   context.pendingRadioSource,
                }),
                onDone:  { target: 'idle', actions: 'clearGeneratingRadio' },
                onError: { target: 'idle', actions: 'clearGeneratingRadio' },
              },
            },
          },
        },

      },
    },
  },
});
