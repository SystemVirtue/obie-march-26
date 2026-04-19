/**
 * adminMachine — XState v5
 *
 * Open in https://stately.ai/viz to see the full admin state contract.
 *
 * Parallel regions:
 *   auth        — unauthenticated → resolving → authenticated → error
 *   operations  — play/pause (debounce guard), skip (in-flight guard),
 *                 shuffle, radio generation, reorder
 *   subscriptions — single Supabase channel per active player ID
 *
 * Before: 8 useState + 3 useRef + 5 subscribeToX calls + setInterval in App.tsx
 * After : one machine, one spawned subscriptionsActor per activePlayerId
 *
 * ─── Realtime optimisation ────────────────────────────────────────────────────
 * subscriptionsActor creates ONE channel (`admin:${playerId}`) with listeners on:
 *   • queue (player_id filter)          → QUEUE_UPDATE
 *   • player_status (player_id filter)  → STATUS_UPDATE
 *   • player_settings (player_id filter)→ SETTINGS_UPDATE
 *   • players (id filter, each player)  → PLAYER_UPDATE
 *   • kiosk_sessions (player_id filter) → KIOSK_UPDATE
 * Plus 60s interval for kiosk fallback.
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
  createJukebox,
  resolveJukeboxSlug,
  subscribeToAuth,
  getPlayersByIds,
  getKioskSessions,
  getPlaylistById,
  type Player,
  type PlayerStatus,
  type PlayerSettings,
  type QueueItem,
  type AuthUser,
  type JukeboxSummary,
  type KioskSession,
} from '@shared/supabase-client';
import { normalizeJukeboxSlug } from '@shared/jukebox-utils';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AdminContext {
  // Auth
  user: AuthUser | null;
  // Jukebox resolution
  routeSlug: string;
  activePlayerId: string | null;
  activeJukeboxSlug: string | null;
  availableJukeboxes: JukeboxSummary[];
  resolveError: string | null;
  // Live data
  queue: QueueItem[];
  status: PlayerStatus | null;
  settings: PlayerSettings | null;
  players: Player[];
  kioskSessions: KioskSession[];
  activePlaylistName: string | null;
  // Operation guards (replaces useRef guards)
  isSkipping: boolean;
  isShuffling: boolean;
  isGeneratingRadio: boolean;
  playPauseInFlight: boolean;
}

export type AdminEvent =
  // Auth
  | { type: 'AUTH_CHANGE'; user: AuthUser | null }
  | { type: 'SIGN_OUT' }
  // Route
  | { type: 'ROUTE_CHANGE'; slug: string }
  | { type: 'SWITCH_JUKEBOX'; slug: string }
  | { type: 'CREATE_JUKEBOX'; name: string }
  // Resolve results
  | { type: 'RESOLVE_DONE'; playerId: string; jukeboxSlug: string | null; jukeboxes: JukeboxSummary[] }
  | { type: 'RESOLVE_ERROR'; message: string }
  // Live data (from subscriptionsActor)
  | { type: 'QUEUE_UPDATE'; items: QueueItem[] }
  | { type: 'STATUS_UPDATE'; status: PlayerStatus }
  | { type: 'SETTINGS_UPDATE'; settings: PlayerSettings }
  | { type: 'PLAYER_UPDATE'; player: Player }
  | { type: 'KIOSK_UPDATE'; sessions: KioskSession[] }
  | { type: 'PLAYERS_LOADED'; players: Player[] }
  | { type: 'PLAYLIST_NAME_LOADED'; name: string | null }
  // Operations
  | { type: 'PLAY_PAUSE' }
  | { type: 'PLAY_PAUSE_DONE' }
  | { type: 'SKIP' }
  | { type: 'SKIP_DONE' }
  | { type: 'REMOVE_QUEUE_ITEM'; queueId: string }
  | { type: 'REORDER_QUEUE'; event: DragEndEvent }
  | { type: 'SHUFFLE' }
  | { type: 'SHUFFLE_DONE' }
  | { type: 'START_RADIO'; source: 'now_playing' | 'history' | 'playlist' }
  | { type: 'RADIO_DONE' };

// ─── Subscriptions actor ──────────────────────────────────────────────────────
// Single channel for all live-data subscriptions for the active player.

interface SubscriptionsInput { playerId: string; playerIds: string[] }

export const subscriptionsActor = fromCallback<AdminEvent, SubscriptionsInput>(
  ({ input, sendBack }) => {
    const { playerId, playerIds } = input;

    // ── Primary channel — queue + status + settings + kiosk ──────────────────
    const primary = supabase
      .channel(`admin:${playerId}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'queue',
        filter: `player_id=eq.${playerId}`,
      }, async () => {
        // Fetch full queue on any change (INSERT/UPDATE/DELETE)
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

    // ── Per-player channels for connected-devices panel ───────────────────────
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

    // Kiosk 60s fallback poll
    const kioskPoll = setInterval(async () => {
      const sessions = await getKioskSessions(playerId).catch(() => [] as KioskSession[]);
      sendBack({ type: 'KIOSK_UPDATE', sessions });
    }, 60_000);

    // Initial fetch
    (async () => {
      const [queueData, statusData, settingsData, kioskData, playerData] = await Promise.allSettled([
        supabase.from('queue').select('id,player_id,type,media_item_id,position,requested_by,requested_at,played_at,expires_at,media_item:media_items(*)')
          .eq('player_id', playerId).is('played_at', null)
          .order('type', { ascending: false }).order('position', { ascending: true }),
        supabase.from('player_status').select('*,current_media:media_items(*)').eq('player_id', playerId).single(),
        supabase.from('player_settings').select('*').eq('player_id', playerId).single(),
        getKioskSessions(playerId),
        getPlayersByIds(playerIds),
      ]);

      if (queueData.status === 'fulfilled' && queueData.value.data)
        sendBack({ type: 'QUEUE_UPDATE', items: queueData.value.data as QueueItem[] });
      if (statusData.status === 'fulfilled' && statusData.value.data)
        sendBack({ type: 'STATUS_UPDATE', status: statusData.value.data as PlayerStatus });
      if (settingsData.status === 'fulfilled' && settingsData.value.data)
        sendBack({ type: 'SETTINGS_UPDATE', settings: settingsData.value.data as PlayerSettings });
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

// ─── Resolve actor ────────────────────────────────────────────────────────────

interface ResolveInput { user: AuthUser; routeSlug: string; fallbackPlayerId: string }

export const resolveActor = fromPromise<
  { playerId: string; jukeboxSlug: string | null; jukeboxes: JukeboxSummary[] },
  ResolveInput
>(async ({ input, signal }) => {
  const { user, routeSlug, fallbackPlayerId } = input;
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

// ─── Machine ──────────────────────────────────────────────────────────────────

const FALLBACK_PLAYER_ID = import.meta.env?.VITE_PLAYER_ID ?? '00000000-0000-0000-0000-000000000001';

export const adminMachine = setup({
  types: {
    context: {} as AdminContext,
    events:  {} as AdminEvent,
    input:   {} as { routeSlug: string },
  },
  actors: { subscriptionsActor, resolveActor },
  guards: {
    isAuthenticated:       ({ context }) => context.user !== null,
    hasActivePlayer:       ({ context }) => context.activePlayerId !== null,
    canPlayPause:          ({ context }) => {
      if (context.isSkipping || context.playPauseInFlight) return false;
      const s = context.status?.state;
      return s === 'playing' || s === 'paused';
    },
    canSkip:               ({ context }) => !context.isSkipping,
    isCurrentlySkipping:   ({ context }) => context.isSkipping,
  },
  actions: {
    assignUser:     assign({ user: ({ event }) => event.type === 'AUTH_CHANGE' ? event.user : null }),
    assignResolved: assign({
      activePlayerId:    ({ event }) => event.type === 'RESOLVE_DONE' ? event.playerId : null,
      activeJukeboxSlug: ({ event }) => event.type === 'RESOLVE_DONE' ? event.jukeboxSlug : null,
      availableJukeboxes:({ event }) => event.type === 'RESOLVE_DONE' ? event.jukeboxes : [],
      resolveError:      null,
    }),
    assignResolveError: assign({
      resolveError: ({ event }) => event.type === 'RESOLVE_ERROR' ? event.message : null,
    }),
    assignQueueUpdate:    assign({ queue:    ({ event }) => event.type === 'QUEUE_UPDATE'    ? event.items   : [] }),
    assignStatusUpdate:   assign({ status:   ({ event }) => event.type === 'STATUS_UPDATE'   ? event.status  : null }),
    assignSettingsUpdate: assign({ settings: ({ event }) => event.type === 'SETTINGS_UPDATE' ? event.settings: null }),
    assignKioskUpdate:    assign({ kioskSessions: ({ event }) => event.type === 'KIOSK_UPDATE' ? event.sessions : [] }),
    assignPlayersLoaded:  assign({ players:  ({ event }) => event.type === 'PLAYERS_LOADED'  ? event.players : [] }),
    assignPlayerUpdate:   assign({
      players: ({ context, event }) => {
        if (event.type !== 'PLAYER_UPDATE') return context.players;
        const idx = context.players.findIndex(p => p.id === event.player.id);
        if (idx === -1) return [...context.players, event.player];
        const next = [...context.players]; next[idx] = event.player; return next;
      },
    }),
    setPlayPauseInFlight: assign({ playPauseInFlight: true }),
    clearPlayPauseInFlight: assign({ playPauseInFlight: false }),
    setSkipping:   assign({ isSkipping: true }),
    clearSkipping: assign({ isSkipping: false }),
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
        if (event.type !== 'REMOVE_QUEUE_ITEM') return context.queue;
        return context.queue.filter(i => i.id !== event.queueId);
      },
    }),
    optimisticReorder: assign({
      queue: ({ context, event }) => {
        if (event.type !== 'REORDER_QUEUE') return context.queue;
        const { active, over } = event.event;
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
        return currentMediaId
          ? context.queue.filter(q => q.media_item_id !== currentMediaId)
          : context.queue;
      },
    }),
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
  }),

  on: {
    QUEUE_UPDATE:    { actions: 'assignQueueUpdate' },
    STATUS_UPDATE:   { actions: 'assignStatusUpdate' },
    SETTINGS_UPDATE: { actions: 'assignSettingsUpdate' },
    KIOSK_UPDATE:    { actions: 'assignKioskUpdate' },
    PLAYER_UPDATE:   { actions: 'assignPlayerUpdate' },
    PLAYERS_LOADED:  { actions: 'assignPlayersLoaded' },
    ROUTE_CHANGE:    { actions: assign({ routeSlug: ({ event }) => event.slug }) },
    AUTH_CHANGE:     [
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
            src: fromPromise(async () => {
              const user = await getCurrentUser();
              const sub  = subscribeToAuth(() => {}); // Real sub handled in React via send
              return { user, sub };
            }),
            onDone: [
              {
                guard: ({ event }) => event.output.user !== null,
                target: 'resolving',
                actions: assign({ user: ({ event }) => event.output.user }),
              },
              { target: 'unauthenticated' },
            ],
            onError: { target: 'unauthenticated' },
          },
        },
        unauthenticated: {
          on: { AUTH_CHANGE: { guard: ({ event }) => event.user !== null, target: 'resolving', actions: 'assignUser' } },
        },
        resolving: {
          invoke: {
            src:   'resolveActor',
            input: ({ context }) => ({
              user:             context.user!,
              routeSlug:        context.routeSlug,
              fallbackPlayerId: FALLBACK_PLAYER_ID,
            }),
            onDone: {
              target: 'authenticated',
              actions: 'assignResolved',
            },
            onError: {
              target: 'error',
              actions: assign({ resolveError: ({ event }) => (event.error as Error).message }),
            },
          },
          on: {
            ROUTE_CHANGE: { target: 'resolving', actions: assign({ routeSlug: ({ event }) => event.slug }) },
          },
        },
        authenticated: {
          on: {
            SIGN_OUT:    { target: 'unauthenticated', actions: 'clearUser' },
            ROUTE_CHANGE: { target: 'resolving', actions: assign({ routeSlug: ({ event }) => event.slug }) },
            SWITCH_JUKEBOX: {
              target: 'resolving',
              actions: assign({
                routeSlug: ({ event }) => normalizeJukeboxSlug(event.slug),
              }),
            },
            CREATE_JUKEBOX: {
              // Handled via side-effect in App.tsx; on success dispatches ROUTE_CHANGE
            },
          },
        },
        error: {
          on: {
            AUTH_CHANGE:  { target: 'resolving', actions: 'assignUser' },
            SWITCH_JUKEBOX: { target: 'resolving' },
          },
        },
      },
    },

    // ══════════════════════════════════════════════════════════════════════════
    // SUBSCRIPTIONS — spawned when activePlayerId is known
    // ══════════════════════════════════════════════════════════════════════════
    subscriptions: {
      initial: 'idle',
      states: {
        idle: {
          always: {
            guard: 'hasActivePlayer',
            target: 'active',
          },
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
            // Re-subscribe when player changes
            RESOLVE_DONE: {
              target: 'active',
              actions: 'assignResolved',
            },
          },
        },
      },
    },

    // ══════════════════════════════════════════════════════════════════════════
    // OPERATIONS — play/pause, skip, shuffle, radio, reorder
    // ══════════════════════════════════════════════════════════════════════════
    operations: {
      type: 'parallel',
      states: {
        // Play/pause has a 400ms debounce guard (CAS on server)
        playPause: {
          initial: 'idle',
          states: {
            idle: {
              on: {
                PLAY_PAUSE: {
                  guard: 'canPlayPause',
                  target: 'inFlight',
                  actions: 'setPlayPauseInFlight',
                },
              },
            },
            inFlight: {
              invoke: {
                src: fromPromise(async ({ input }: { input: { status: PlayerStatus | null; playerId: string } }) => {
                  const currentState = input.status?.state;
                  if (currentState !== 'playing' && currentState !== 'paused') return;
                  const newState = currentState === 'playing' ? 'paused' : 'playing';
                  await callPlayerControl({
                    player_id:      input.playerId,
                    state:          newState,
                    action:         'update',
                    expected_state: currentState,
                  } as any);
                }),
                input: ({ context }) => ({ status: context.status, playerId: context.activePlayerId! }),
                onDone:  { target: 'debounce' },
                onError: { target: 'debounce' },
              },
            },
            debounce: {
              // Hold 400ms before allowing next play/pause (covers Realtime round-trip)
              after: { 400: { target: 'idle', actions: 'clearPlayPauseInFlight' } },
            },
          },
        },

        // Skip
        skip: {
          initial: 'idle',
          states: {
            idle: {
              on: {
                SKIP: {
                  guard: 'canSkip',
                  target: 'inFlight',
                  actions: ['setSkipping', 'optimisticSkipQueue'],
                },
              },
            },
            inFlight: {
              invoke: {
                src: fromPromise(async ({ input }: { input: { playerId: string } }) => {
                  await callPlayerControl({ player_id: input.playerId, state: 'idle', action: 'skip' });
                }),
                input: ({ context }) => ({ playerId: context.activePlayerId! }),
                onDone:  { target: 'cooldown' },
                onError: { target: 'idle', actions: 'clearSkipping' },
              },
            },
            cooldown: {
              after: { 3000: { target: 'idle', actions: 'clearSkipping' } },
              on: {
                STATUS_UPDATE: {
                  guard: ({ event }) => event.status.state === 'playing' || event.status.state === 'loading',
                  target: 'idle',
                  actions: 'clearSkipping',
                },
              },
            },
          },
        },

        // Remove queue item
        queueRemove: {
          initial: 'idle',
          states: {
            idle: {
              on: {
                REMOVE_QUEUE_ITEM: {
                  actions: [
                    'optimisticRemoveQueue',
                    ({ context, event }) => {
                      callQueueManager({ player_id: context.activePlayerId!, action: 'remove', queue_id: event.queueId })
                        .catch(console.error);
                    },
                  ],
                },
              },
            },
          },
        },

        // Reorder
        queueReorder: {
          initial: 'idle',
          states: {
            idle: {
              on: {
                REORDER_QUEUE: {
                  actions: [
                    'optimisticReorder',
                    ({ context, event }) => {
                      const { active, over } = event.event;
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
                  ],
                },
              },
            },
          },
        },

        // Shuffle
        shuffle: {
          initial: 'idle',
          states: {
            idle: {
              on: {
                SHUFFLE: {
                  guard: ({ context }) => context.queue.filter(i => i.type === 'normal').length > 1,
                  target: 'inFlight',
                  actions: 'setShuffling',
                },
              },
            },
            inFlight: {
              invoke: {
                src: fromPromise(async ({ input }: { input: { playerId: string } }) => {
                  await callQueueManager({ player_id: input.playerId, action: 'shuffle', type: 'normal' });
                }),
                input: ({ context }) => ({ playerId: context.activePlayerId! }),
                onDone:  { target: 'idle', actions: 'clearShuffling' },
                onError: { target: 'idle', actions: 'clearShuffling' },
              },
            },
          },
        },

        // Radio
        radio: {
          initial: 'idle',
          states: {
            idle: {
              on: {
                START_RADIO: {
                  target: 'inFlight',
                  actions: 'setGeneratingRadio',
                },
              },
            },
            inFlight: {
              invoke: {
                src: fromPromise(async ({ input }: { input: { playerId: string; source: string } }) => {
                  await callRadioGenerator({ player_id: input.playerId, action: 'generate', source: input.source as any });
                }),
                input: ({ context, event }) => ({
                  playerId: context.activePlayerId!,
                  source:   event.type === 'START_RADIO' ? event.source : 'history',
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
