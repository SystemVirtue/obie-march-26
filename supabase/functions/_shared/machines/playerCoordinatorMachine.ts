/**
 * Player Coordinator Machine - XState v5 Actor Model
 *
 * Central actor for global priority election, eliminating scattered priority checks
 * across player-control. Handles master/slave coordination atomically.
 *
 * States:
 * - noMaster: No priority player exists
 * - hasMaster: Priority player active, tracking heartbeats
 * - electionInProgress: Temporary state during master handoff
 * - resetPending: Admin triggered reset, awaiting player claim
 */

// @ts-ignore - Deno ESM import
import { setup, createMachine, assign, fromPromise } from 'https://esm.sh/xstate@5.18.2';
import { createServiceClient } from '../supabase-client.ts';

const supabase = createServiceClient();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CoordinatorContext = {
  priorityPlayerId: string | null;
  activePlayers: Map<string, { lastHeartbeat: number }>;
  electionCandidate: string | null;
  resetRequestedAt: number | null;
  resetRequestedBy: string | null;
};

type CoordinatorEvent =
  | { type: 'PLAYER_REGISTER'; playerId: string; sessionId: string }
  | { type: 'CLAIM_MASTER'; playerId: string; previousPriorityId?: string | null }
  | { type: 'RESET_PRIORITY'; requestedBy: string }
  | { type: 'HEARTBEAT'; playerId: string }
  | { type: 'PLAYER_OFFLINE'; playerId: string }
  | { type: 'PLAYER_ENDED'; playerId: string; currentMediaId?: string | null };

// ---------------------------------------------------------------------------
// DB Actors (async operations)
// ---------------------------------------------------------------------------

const dbClaimPriority = fromPromise(async ({ input }: { input: { playerId: string } }) => {
  const { error } = await supabase.rpc('claim_priority_player', {
    p_player_id: input.playerId
  });
  if (error) throw error;
  return { success: true };
});

const dbResetPriority = fromPromise(async () => {
  const { error } = await supabase.rpc('reset_priority_player_global');
  if (error) throw error;
  return { success: true };
});

const dbLogEvent = fromPromise(async ({ input }: { input: { eventType: string; playerId: string; previousPriorityId?: string | null; notes?: string } }) => {
  const { error } = await supabase.from('priority_player_events').insert({
    event_type: input.eventType,
    player_id: input.playerId,
    previous_priority_id: input.previousPriorityId,
    notes: input.notes,
  });
  if (error) throw error;
  return { success: true };
});

const dbGetCurrentMaster = fromPromise(async () => {
  const { data, error } = await supabase
    .from('players')
    .select('priority_player_id')
    .limit(1)
    .single();
  if (error) throw error;
  return data?.priority_player_id ?? null;
});

// ---------------------------------------------------------------------------
// Machine Definition
// ---------------------------------------------------------------------------

export const playerCoordinatorMachine = setup({
  types: {
    context: {} as CoordinatorContext,
    events: {} as CoordinatorEvent,
  },
  actors: {
    dbClaimPriority,
    dbResetPriority,
    dbLogEvent,
    dbGetCurrentMaster,
  },
  actions: {
    setPriorityPlayer: assign({
      priorityPlayerId: ({ event }: any) => {
        if (event.type === 'PLAYER_REGISTER' || event.type === 'CLAIM_MASTER') {
          return event.playerId;
        }
        return null;
      },
    }),
    clearPriorityPlayer: assign({
      priorityPlayerId: () => null,
    }),
    setElectionCandidate: assign({
      electionCandidate: ({ event }: any) => {
        if (event.type === 'CLAIM_MASTER') return event.playerId;
        return null;
      },
    }),
    setResetPending: assign({
      resetRequestedAt: () => Date.now(),
      resetRequestedBy: ({ event }: any) => {
        if (event.type === 'RESET_PRIORITY') return event.requestedBy;
        return null;
      },
    }),
    clearResetPending: assign({
      resetRequestedAt: () => null,
      resetRequestedBy: () => null,
    }),
    trackHeartbeat: assign({
      activePlayers: ({ context, event }: any) => {
        if (event.type !== 'HEARTBEAT') return context.activePlayers;
        const updated = new Map(context.activePlayers);
        updated.set(event.playerId, { lastHeartbeat: Date.now() });
        return updated;
      },
    }),
    cleanupOfflinePlayer: assign({
      activePlayers: ({ context, event }: any) => {
        if (event.type !== 'PLAYER_OFFLINE') return context.activePlayers;
        const updated = new Map(context.activePlayers);
        updated.delete(event.playerId);
        return updated;
      },
    }),
  },
  guards: {
    isCurrentMaster: ({ context, event }: any) => {
      const playerId = event.type === 'HEARTBEAT' || event.type === 'PLAYER_OFFLINE' || event.type === 'PLAYER_ENDED'
        ? event.playerId
        : null;
      return playerId === context.priorityPlayerId;
    },
    hasNoMaster: ({ context }: any) => context.priorityPlayerId === null,
    isResetPending: ({ context }: any) => context.resetRequestedAt !== null,
    isEligibleToClaim: ({ context, event }: any) => {
      if (event.type !== 'PLAYER_REGISTER') return false;
      // Player can claim if no master exists
      return context.priorityPlayerId === null;
    },
  },
}).createMachine({
  id: 'playerCoordinator',
  initial: 'noMaster',
  context: {
    priorityPlayerId: null,
    activePlayers: new Map(),
    electionCandidate: null,
    resetRequestedAt: null,
    resetRequestedBy: null,
  },
  states: {
    noMaster: {
      initial: 'hydrating',
      states: {
        hydrating: {
          invoke: {
            src: 'dbGetCurrentMaster',
            onDone: [
              {
                guard: ({ event }: any) => event.output !== null,
                actions: assign({
                  priorityPlayerId: ({ event }: any) => event.output,
                }),
                target: '#playerCoordinator.hasMaster',
              },
              {
                target: '#playerCoordinator.noMaster.idle',
              },
            ],
            onError: {
              target: '#playerCoordinator.noMaster.idle',
            },
          },
        },
        idle: {},
      },
      on: {
        PLAYER_REGISTER: [
          {
            guard: 'isEligibleToClaim',
            actions: 'setPriorityPlayer',
            target: 'hasMaster',
          },
          {
            // Register as slave - no state change needed
            target: 'noMaster',
          },
        ],
        CLAIM_MASTER: {
          actions: ['setPriorityPlayer', 'setElectionCandidate'],
          target: 'hasMaster',
        },
      },
    },
    hasMaster: {
      on: {
        HEARTBEAT: [
          {
            guard: 'isCurrentMaster',
            actions: 'trackHeartbeat',
            target: 'hasMaster',
          },
          {
            // Slave heartbeat - track but no priority change
            actions: 'trackHeartbeat',
            target: 'hasMaster',
          },
        ],
        PLAYER_OFFLINE: [
          {
            guard: 'isCurrentMaster',
            actions: ['cleanupOfflinePlayer', 'clearPriorityPlayer'],
            target: 'noMaster',
          },
          {
            actions: 'cleanupOfflinePlayer',
            target: 'hasMaster',
          },
        ],
        CLAIM_MASTER: {
          actions: 'setPriorityPlayer',
          target: 'hasMaster',
        },
        RESET_PRIORITY: {
          actions: ['setResetPending'],
          target: 'resetPending',
        },
        PLAYER_ENDED: {
          // Only priority player can trigger queue advancement
          guard: 'isCurrentMaster',
          target: 'hasMaster',
        },
      },
    },
    electionInProgress: {
      on: {
        CLAIM_MASTER: {
          actions: 'setPriorityPlayer',
          target: 'hasMaster',
        },
      },
    },
    resetPending: {
      on: {
        CLAIM_MASTER: {
          actions: ['setPriorityPlayer', 'clearResetPending'],
          target: 'hasMaster',
        },
      },
    },
  },
});

export type PlayerCoordinatorMachine = typeof playerCoordinatorMachine;
