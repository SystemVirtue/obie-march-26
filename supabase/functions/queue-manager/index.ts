import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 100;

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

// Actions that require the player to be online (playback control)
const REQUIRES_ONLINE = new Set(["add", "next"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false, autoRefreshToken: false } }
    );

    const body = await req.json();
    const {
      player_id,
      action,
      media_item_id,
      queue_id,
      queue_ids,
      type = "normal",
      requested_by = "admin",
    } = body;

    if (!player_id) {
      return new Response(JSON.stringify({ error: "player_id is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify player exists
    const { data: player, error: playerError } = await supabase
      .from("players")
      .select("status")
      .eq("id", player_id)
      .single();

    if (playerError || !player) {
      return new Response(JSON.stringify({ error: "Player not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Only block playback-triggering actions when player is offline.
    // Admin queue management (remove, reorder, clear, skip) works regardless.
    if (REQUIRES_ONLINE.has(action) && player.status !== "online") {
      return new Response(JSON.stringify({ error: "Player is offline" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let result: unknown;

    switch (action) {
      case "add": {
        if (!media_item_id) {
          return new Response(
            JSON.stringify({ error: "media_item_id is required for add action" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        const { data: queueId, error: addError } = await supabase.rpc("queue_add", {
          p_player_id: player_id,
          p_media_item_id: media_item_id,
          p_type: type,
          p_requested_by: requested_by,
        });
        if (addError) throw addError;
        result = { queue_id: queueId };
        break;
      }

      case "remove": {
        if (!queue_id) {
          return new Response(
            JSON.stringify({ error: "queue_id is required for remove action" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        const { error: removeError } = await supabase.rpc("queue_remove", {
          p_queue_id: queue_id,
        });
        if (removeError) throw removeError;
        result = { success: true };
        break;
      }

      case "reorder": {
        if (!queue_ids || !Array.isArray(queue_ids)) {
          return new Response(
            JSON.stringify({ error: "queue_ids array is required for reorder action" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        let attempt = 0;
        let lastError: unknown = null;
        while (attempt < MAX_RETRIES) {
          attempt++;
          const { error: reorderError } = await supabase.rpc("queue_reorder", {
            p_player_id: player_id,
            p_queue_ids: queue_ids,
            p_type: type,
          });
          if (!reorderError) { lastError = null; break; }
          lastError = reorderError;
          const isConflict =
            (reorderError as { status?: number })?.status === 409 ||
            /duplicate key|unique constraint/i.test((reorderError as Error)?.message ?? "");
          if (!isConflict) break;
          const backoff = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), 2000);
          await sleep(backoff + Math.floor(Math.random() * 100));
        }
        if (lastError) throw lastError;
        result = { success: true };
        break;
      }

      case "next": {
        const { data: nextItem, error: nextError } = await supabase.rpc("queue_next", {
          p_player_id: player_id,
        });
        if (nextError) throw nextError;
        result = { next_item: Array.isArray(nextItem) ? nextItem[0] : nextItem ?? null };
        break;
      }

      case "skip": {
        const { error: skipError } = await supabase.rpc("queue_skip", {
          p_player_id: player_id,
        });
        if (skipError) throw skipError;
        result = { success: true };
        break;
      }

      case "clear": {
        const { error: clearError } = await supabase.rpc("queue_clear", {
          p_player_id: player_id,
          p_type: type === "normal" || type === "priority" ? type : null,
        });
        if (clearError) throw clearError;
        result = { success: true };
        break;
      }

      case "shuffle": {
        const { error: shuffleError } = await supabase.rpc("queue_shuffle", {
          p_player_id: player_id,
          p_type: type === "priority" ? "priority" : "normal",
        });
        if (shuffleError) throw shuffleError;
        result = { success: true };
        break;
      }

      default:
        return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Queue manager error:", error);
    return new Response(
      JSON.stringify({ error: (error as Error)?.message ?? String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
