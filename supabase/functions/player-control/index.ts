// Player Control Edge Function
// Handles player status updates and heartbeat
import { corsHeaders } from '../_shared/cors.ts';
import { createServiceClient } from '../_shared/supabase-client.ts';

// Helper: Log admin actions to system_logs for audit trail
async function logAdminAction(supabase: any, action: string, player_id: string, payload: Record<string, any> = {}) {
  try {
    await supabase.from('system_logs').insert({
      player_id: player_id,
      event: `admin_${action}`,
      severity: 'info',
      payload: payload,
      source: 'edge',
    });
  } catch (err) {
    console.error('[player-control] Failed to log admin action:', err);
    // Don't throw - logging failure shouldn't block the action itself
  }
}

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
          .update({ priority_player_id: player_id, priority_session_id: session_id })
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

      const currentPriorityId = existingPriority?.priority_player_id ?? null;

      // Allow claim/reclaim if: no priority player set, OR this player WAS the priority player.
      // A page reload clears localStorage, so we can't rely solely on stored_player_id —
      // the DB record is the authoritative source for whether this player should be priority.
      if (!currentPriorityId || currentPriorityId === player_id) {
        // Check if any players are currently playing (only block if another player is active)
        const { data: playingPlayers } = await supabase
          .from('player_status')
          .select('player_id, state')
          .eq('state', 'playing');

        const otherPlayerPlaying = playingPlayers?.some((p: any) => p.player_id !== player_id) ?? false;

        if (!otherPlayerPlaying) {
          // Safe to claim / reclaim priority
          const { error: updateError } = await supabase
            .from('players')
            .update({ priority_player_id: player_id, priority_session_id: session_id })
            .eq('id', player_id);

          if (updateError) throw updateError;

          const verb = currentPriorityId === player_id ? 'reclaimed' : 'registered as';
          console.log(`[player-control] Player ${player_id} ${verb} priority player (session: ${session_id})`);
          return new Response(JSON.stringify({
            success: true,
            is_priority: true,
            restored: currentPriorityId === player_id,
          }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        } else {
          // Another player is actively playing — become slave
          console.log(`[player-control] Player ${player_id} registered as slave (another player is playing, session: ${session_id})`);
          return new Response(JSON.stringify({
            success: true,
            is_priority: false
          }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }
      } else {
        // A different player holds priority
        console.log(`[player-control] Player ${player_id} registered as slave (priority held by ${currentPriorityId}, session: ${session_id})`);
        return new Response(JSON.stringify({
          success: true,
          is_priority: false
        }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }
    // Handle reset priority player
    if (action === 'reset_priority') {
      // Get player jukebox_id for scoped reset
      const { data: playerData, error: playerError } = await supabase
        .from('players')
        .select('jukebox_id')
        .eq('id', player_id)
        .single();

      if (playerError || !playerData?.jukebox_id) {
        throw new Error('Could not find player jukebox_id');
      }

      // Call function to reset priority with flag
      const { data: resetResult, error: resetError } = await supabase
        .rpc('admin_reset_priority_player', {
          p_jukebox_id: playerData.jukebox_id
        });

      if (resetError) throw resetError;

      console.log(`[player-control] Priority player reset for jukebox ${playerData.jukebox_id}. Results:`, resetResult);
      return new Response(JSON.stringify({
        success: true,
        message: 'Priority player reset - reassignment blocked until flag cleared',
        reset_flag_active: true
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
        // Log admin skip action
        await logAdminAction(supabase, 'skip', player_id, {
          pre_update_state: preUpdateState,
          pre_update_media_id: preUpdateMediaId,
          timestamp: new Date().toISOString()
        });

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
