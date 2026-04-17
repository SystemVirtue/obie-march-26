// Player Control Edge Function
// Handles player status updates and heartbeat
import { corsHeaders } from '../_shared/cors.ts';
import { createServiceClient } from '../_shared/supabase-client.ts';
import { validateAuth, unauthorizedResponse } from '../_shared/auth.ts';
Deno.serve(async (req)=>{
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders
    });
  }
  if (!validateAuth(req)) return unauthorizedResponse();
  try {
    // Create Supabase client with service role key to bypass RLS
    const supabase = createServiceClient();
    // Parse request body
    const body = await req.json();
    const { player_id, state, progress, action = 'update', session_id, current_media_id, expected_state, expected_media_id } = body;
    if (!player_id) {
      return new Response(JSON.stringify({
        error: 'player_id is required'
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Handle heartbeat
    if (action === 'heartbeat') {
      const { error } = await supabase.rpc('player_heartbeat', {
        p_player_id: player_id
      });
      if (error) throw error;
      return new Response(JSON.stringify({
        success: true
      }), {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }

    // Handle session registration for priority player mechanism.
    // Uses the atomic claim_priority_player() DB function (migration 000004)
    // which holds an advisory lock, eliminating the three-query race condition.
    if (action === 'register_session') {
      if (!session_id) {
        return new Response(JSON.stringify({
          error: 'session_id is required for register_session'
        }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const { data: isPriority, error: claimError } = await supabase.rpc('claim_priority_player', {
        p_player_id:   player_id,
        p_session_id:  session_id,
      });

      if (claimError) throw claimError;

      console.log(`[player-control] Player ${player_id} register_session → is_priority=${!!isPriority} (session: ${session_id})`);
      return new Response(JSON.stringify({
        success: true,
        is_priority: !!isPriority,
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    // Handle reset priority player
    if (action === 'reset_priority') {
      const { error: resetError } = await supabase
        .from('players')
        .update({ priority_player_id: null })
        .eq('id', player_id);

      if (resetError) throw resetError;

      console.log(`[player-control] Priority player reset for player ${player_id}`);
      return new Response(JSON.stringify({
        success: true,
        message: 'Priority player reset'
      }), {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }

    // Handle status update
    if (action === 'update' || action === 'ended' || action === 'skip') {
      // ── Compare-and-swap guard for play/pause ────────────────────────────
      // If the caller sends expected_state, verify the DB still matches before
      // writing. This prevents two admin consoles racing — the second console's
      // stale click arrives with expected_state='playing' but the DB already
      // says 'paused' (first console won), so we return a no-op instead of
      // toggling back.
      if (action === 'update' && expected_state !== undefined) {
        const { data: currentStatus } = await supabase
          .from('player_status')
          .select('state')
          .eq('player_id', player_id)
          .single();

        if (currentStatus?.state !== expected_state) {
          console.log(`[player-control] CAS rejected: expected=${expected_state} actual=${currentStatus?.state} — stale admin click ignored`);
          return new Response(JSON.stringify({ success: true, noop: true, reason: 'cas_mismatch' }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }
      // For skip: capture current player state AND current_media_id BEFORE updating,
      // so we can decide whether the player needs to fade out or whether it's already
      // idle, and so the server-side advance can pass an idempotency key to queue_next.
      let preUpdateState: string | null = null;
      let preUpdateMediaId: string | null = null;
      if (action === 'skip') {
        const { data: currentStatus } = await supabase
          .from('player_status')
          .select('state, current_media_id')
          .eq('player_id', player_id)
          .single();
        preUpdateState = currentStatus?.state ?? null;
        preUpdateMediaId = currentStatus?.current_media_id ?? null;

        // Compare-and-swap guard for skip: if the caller sends expected_media_id,
        // reject the skip if the song has already changed (e.g. a second admin
        // console clicked Skip 50ms later — same guard pattern as play/pause CAS).
        if (expected_media_id && preUpdateMediaId && expected_media_id !== preUpdateMediaId) {
          console.log(`[player-control] Skip CAS rejected: expected=${expected_media_id} actual=${preUpdateMediaId} — stale skip ignored`);
          return new Response(JSON.stringify({ success: true, noop: true, reason: 'media_changed' }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      const updateData: Record<string, unknown> = {
        last_updated: new Date().toISOString()
      };
      // For 'ended', skip writing state to player_status.  Writing state='idle' here
      // fires a Realtime event that the player's status subscription misinterprets as
      // an admin skip (playing→idle), triggering a second queue_next call.
      // queue_next will set state='loading' atomically, so no intermediate write needed.
      if (action !== 'ended' && state !== undefined) {
        updateData.state = state;
      }
      if (progress !== undefined) {
        updateData.progress = Math.min(1, Math.max(0, progress));
      }
      const { error: updateError } = await supabase.from('player_status').update(updateData).eq('player_id', player_id);
      if (updateError) throw updateError;
      // If action is 'skip' from Admin, check if player was already idle.
      // If idle: call queue_next directly (no fade needed, nothing is playing).
      // If playing/paused: let the Player handle the fade and then call queue_next.
      if (action === 'skip' && state === 'idle') {
        // Check if this player is the priority player before allowing queue progression
        const { data: player } = await supabase
          .from('players')
          .select('priority_player_id')
          .eq('id', player_id)
          .single();

        if (player?.priority_player_id !== player_id) {
          console.log(`[player-control] Ignoring skip from non-priority player ${player_id}`);
          return new Response(JSON.stringify({
            success: false,
            reason: 'not_priority_player'
          }), {
            status: 200,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json'
            }
          });
        }

        const shouldAdvanceServerSide = preUpdateState !== 'playing' && preUpdateState !== 'paused';

        if (shouldAdvanceServerSide) {
          // Nothing is actively playing (idle/loading/error/unknown), so the player-side
          // fade callback may never fire. Advance queue immediately on the server.
          // Use preUpdateMediaId (read from DB before the state update) as the idempotency
          // key so queue_next won't double-skip if a natural end already advanced the queue.
          console.log('[player-control] Skip while not actively playing - calling queue_next directly', {
            pre_update_state: preUpdateState,
            pre_update_media_id: preUpdateMediaId
          });
          const { data: nextItem, error: nextError } = await supabase.rpc('queue_next', {
            p_player_id: player_id,
            p_expected_media_id: preUpdateMediaId || null
          });
          if (nextError) {
            console.error('[player-control] ❌ Failed to get next item on idle-skip:', nextError);
          } else {
            console.log('[player-control] 🎵 Idle-skip queue_next returned:', nextItem?.[0]?.title?.slice(0, 30) || 'none');
          }
          return new Response(JSON.stringify({
            success: true,
            next_item: nextItem?.[0] || null,
            action: 'skip_server_advance',
            pre_update_state: preUpdateState
          }), {
            status: 200,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json'
            }
          });
        }

        console.log('[player-control] Skip action from Admin - state updated, Player will handle fade');
        return new Response(JSON.stringify({
          success: true,
          skip_pending: true
        }), {
          status: 200,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      // If song ended naturally (from Player), trigger queue_next.
      // Only action='ended' should advance the queue — the old '|| state === 'idle''
      // branch was a latent bug that would fire queue_next for any status update
      // that happened to include state:'idle' (e.g. a stale heartbeat).
      if (action === 'ended') {
        // Check if this player is the priority player before allowing queue progression
        const { data: player } = await supabase
          .from('players')
          .select('priority_player_id')
          .eq('id', player_id)
          .single();

        if (player?.priority_player_id !== player_id) {
          console.log(`[player-control] Ignoring ${action} from non-priority player ${player_id}`);
          return new Response(JSON.stringify({
            success: false,
            reason: 'not_priority_player'
          }), {
            status: 200,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json'
            }
          });
        }

        console.log('[player-control] Song ended, calling queue_next for priority player:', player_id);
        const { data: nextItem, error: nextError } = await supabase.rpc('queue_next', {
          p_player_id: player_id,
          p_expected_media_id: current_media_id || null
        });
        if (nextError) {
          console.error('[player-control] ❌ Failed to get next item:', nextError);
        } else {
          console.log('[player-control] 🎵 Queue_next returned:', nextItem?.[0]?.title?.slice(0, 30) || 'none');
        }
        return new Response(JSON.stringify({
          success: true,
          next_item: nextItem?.[0] || null,
          action
        }), {
          status: 200,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      return new Response(JSON.stringify({
        success: true
      }), {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    return new Response(JSON.stringify({
      error: 'Invalid action'
    }), {
      status: 400,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('Player control error:', error);
    const message = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({
      error: 'Internal server error',
      message
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
});
