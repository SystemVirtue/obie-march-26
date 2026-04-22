// Player Control Edge Function
// Handles player status updates, heartbeat, and queue progression
// Queue progression is now server-controlled via complete_and_advance RPC
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
    const { player_id, state, progress, action = 'update', current_media_id, expected_state, queue_id } = body;
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
      // Mark player as online
      const { error: updateError } = await supabase
        .from('players')
        .update({ status: 'online', last_seen: new Date().toISOString() })
        .eq('id', player_id);
      if (updateError) throw updateError;

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

      const updateData: Record<string, unknown> = {
        last_updated: new Date().toISOString()
      };
      if (state !== undefined) {
        updateData.state = state;
      }
      if (progress !== undefined) {
        updateData.progress = Math.min(1, Math.max(0, progress));
      }
      const { error: updateError } = await supabase.from('player_status').update(updateData).eq('player_id', player_id);
      if (updateError) throw updateError;

      // Handle queue completion via complete_and_advance RPC
      if (action === 'ended' || action === 'skip') {
        if (!queue_id) {
          console.error(`[player-control] Missing queue_id for ${action} action`);
          return new Response(JSON.stringify({
            success: false,
            reason: 'missing_queue_id'
          }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        console.log(`[player-control] Calling complete_and_advance for queue item: ${queue_id}`);
        const { data: result, error: advanceError } = await supabase.rpc('complete_and_advance', {
          p_queue_id: queue_id
        });

        if (advanceError) {
          console.error('[player-control] ❌ complete_and_advance failed:', advanceError);
          return new Response(JSON.stringify({
            success: false,
            error: advanceError.message
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        console.log('[player-control] complete_and_advance result:', result);
        return new Response(JSON.stringify({
          success: true,
          result,
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
    let message = 'Unknown error';
    if (error instanceof Error) {
      message = error.message;
    } else if (error && typeof error === 'object') {
      // Handle Supabase error objects which are plain objects with message property
      message = (error as any).message || JSON.stringify(error);
    } else {
      message = String(error);
    }
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
