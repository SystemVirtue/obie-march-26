// Player Control Edge Function
// Handles player status updates and heartbeat
import { corsHeaders } from '../_shared/cors.ts';
import { createServiceClient } from '../_shared/supabase-client.ts';
Deno.serve(async (req)=>{
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders
    });
  }
  try {
    // Create Supabase client with service role key to bypass RLS
    const supabase = createServiceClient();
    // Parse request body
    const body = await req.json();
    const { player_id, state, progress, action = 'update', session_id, stored_player_id, current_media_id } = body;
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

    // Handle session registration for priority player mechanism
    if (action === 'register_session') {
      if (!session_id) {
        return new Response(JSON.stringify({
          error: 'session_id is required for register_session'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }

      // Check if this player was previously priority (stored_player_id matches)
      if (stored_player_id === player_id) {
        // This player was previously priority - restore priority status
        const { error: updateError } = await supabase
          .from('players')
          .update({ priority_player_id: player_id })
          .eq('id', player_id);

        if (updateError) throw updateError;

        console.log(`[player-control] Player ${player_id} restored as priority player (session: ${session_id})`);
        return new Response(JSON.stringify({
          success: true,
          is_priority: true,
          restored: true
        }), {
          status: 200,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }

      // Check if there's already a priority player
      const { data: existingPriority } = await supabase
        .from('players')
        .select('priority_player_id')
        .eq('id', player_id)
        .single();

      if (!existingPriority?.priority_player_id) {
        // No priority player yet - check if any players are currently playing
        const { data: playingPlayers } = await supabase
          .from('player_status')
          .select('id')
          .eq('state', 'playing');

        if (!playingPlayers || playingPlayers.length === 0) {
          // No players are currently playing - make this one priority
          const { error: updateError } = await supabase
            .from('players')
            .update({ priority_player_id: player_id })
            .eq('id', player_id);

          if (updateError) throw updateError;

          console.log(`[player-control] Player ${player_id} registered as priority player (no players playing, session: ${session_id})`);
          return new Response(JSON.stringify({
            success: true,
            is_priority: true
          }), {
            status: 200,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json'
            }
          });
        } else {
          // Players are playing - this becomes a slave
          console.log(`[player-control] Player ${player_id} registered as slave player (other players playing, session: ${session_id})`);
          return new Response(JSON.stringify({
            success: true,
            is_priority: false
          }), {
            status: 200,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json'
            }
          });
        }
      } else {
        console.log(`[player-control] Player ${player_id} registered as slave player (priority exists, session: ${session_id})`);
        return new Response(JSON.stringify({
          success: true,
          is_priority: false
        }), {
          status: 200,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
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
