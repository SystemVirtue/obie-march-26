// Player Control Edge Function - XState v5 Actor Model
// Thin router: hydrate → create actors → send events → yield → return snapshot data
import { corsHeaders } from '../_shared/cors.ts';
import { createServiceClient } from '../_shared/supabase-client.ts';
import { createActor } from 'https://esm.sh/xstate@5.18.2';
import { playerCoordinatorMachine } from '../_shared/machines/playerCoordinatorMachine.ts';
import { playerMachine } from '../_shared/machines/playerMachine.ts';
import { 
  hydrateCoordinatorState, 
  hydratePlayerState,
  logPriorityEvent,
  resetPriorityPlayerGlobal
} from '../_shared/machines/actions.ts';

const supabase = createServiceClient();

// Small yield delay to allow async DB actors to complete before reading snapshot
// This is a simple approach - for critical operations, consider using actor subscriptions
// to wait for specific state transitions instead.
const YIELD_MS = 10;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const body = await req.json();
    const { player_id, state, progress, action = 'update', session_id, current_media_id, expected_state } = body;
    
    if (!player_id) return new Response(JSON.stringify({ error: 'player_id is required' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

    // Hydrate state from DB
    const coordinatorContext = await hydrateCoordinatorState();
    const playerContext = await hydratePlayerState(player_id);

    // Create actors
    const coordinator = createActor(playerCoordinatorMachine, { input: coordinatorContext }).start();
    const player = createActor(playerMachine, { input: { ...playerContext, playerId: player_id } }).start();
    switch (action) {
      case 'heartbeat': {
        coordinator.send({ type: 'HEARTBEAT', playerId: player_id });
        player.send({ type: 'HEARTBEAT' });
        const playerSnapshot = player.getSnapshot();
        return new Response(JSON.stringify({ success: true, is_priority: playerSnapshot.context.isPriority }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      case 'register_session': {
        if (!session_id) return new Response(JSON.stringify({ error: 'session_id is required' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
        coordinator.send({ type: 'PLAYER_REGISTER', playerId: player_id, sessionId: session_id });
        await new Promise(resolve => setTimeout(resolve, YIELD_MS)); // Yield for coordinator processing
        const coordinatorSnapshot = coordinator.getSnapshot();
        const isPriority = coordinatorSnapshot.context.priorityPlayerId === player_id;
        player.send({ type: 'SET_PRIORITY', isPriority });
        return new Response(JSON.stringify({ success: true, is_priority: isPriority }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      case 'claim_priority': {
        const coordinatorSnapshot = coordinator.getSnapshot();
        const previousPriorityId = coordinatorSnapshot.context.priorityPlayerId;
        coordinator.send({ type: 'CLAIM_MASTER', playerId: player_id, previousPriorityId });
        await logPriorityEvent('claimed', player_id, previousPriorityId, 'Player confirmed as master via modal');
        player.send({ type: 'SET_PRIORITY', isPriority: true });
        return new Response(JSON.stringify({ success: true, is_priority: true }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      case 'reset_priority': {
        const coordinatorSnapshot = coordinator.getSnapshot();
        const currentPriorityId = coordinatorSnapshot.context.priorityPlayerId;
        coordinator.send({ type: 'RESET_PRIORITY', requestedBy: 'admin' });
        await resetPriorityPlayerGlobal();
        await logPriorityEvent('reset_requested', currentPriorityId || '', null, 'Admin triggered re-assignment');
        return new Response(JSON.stringify({ success: true, message: 'Priority reassignment pending' }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      case 'update': {
        // CAS guard for UI-level races (keep in edge function)
        if (expected_state !== undefined) {
          const { data: currentStatus } = await supabase.from('player_status').select('state').eq('player_id', player_id).single();
          if (currentStatus?.state !== expected_state) return new Response(JSON.stringify({ success: true, noop: true, reason: 'cas_mismatch' }), {
            status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }
        // Send to player machine - machine handles dbUpdateStatus internally
        if (state === 'playing') player.send({ type: 'YOUTUBE_PLAYING' });
        else if (state === 'paused') player.send({ type: 'YOUTUBE_PAUSED' });
        else if (state === 'loading') player.send({ type: 'MEDIA_ASSIGNED', mediaId: current_media_id || '', isAfterSkip: false });
        await new Promise(resolve => setTimeout(resolve, YIELD_MS)); // Yield for dbUpdateStatus actor
        return new Response(JSON.stringify({ success: true }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      case 'skip': {
        // Send to player machine - machine handles priority guard → ending → dbQueueNext
        player.send({ type: 'ADMIN_SKIP' });
        await new Promise(resolve => setTimeout(resolve, YIELD_MS)); // Yield for dbQueueNext actor
        const playerSnapshot = player.getSnapshot();
        return new Response(JSON.stringify({
          success: true,
          next_media_id: playerSnapshot.context.currentMediaId,
          advance_result: playerSnapshot.context.advanceResult
        }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      case 'ended': {
        // Send to player machine - machine handles priority guard → ending → dbQueueNext with idempotency
        player.send({ type: 'YOUTUBE_ENDED' });
        await new Promise(resolve => setTimeout(resolve, YIELD_MS)); // Yield for dbQueueNext actor
        const playerSnapshot = player.getSnapshot();
        return new Response(JSON.stringify({
          success: true,
          next_media_id: playerSnapshot.context.currentMediaId,
          advance_result: playerSnapshot.context.advanceResult
        }), {
          status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      default:
        return new Response(JSON.stringify({ error: 'Invalid action' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
    }
  } catch (error) {
    console.error('Player control error:', error);
    const message = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: 'Internal server error', message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
