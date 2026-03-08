// Playlist Manager Edge Function
// Handles playlist CRUD operations and media scraping
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
Deno.serve(async (req)=>{
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders
    });
  }
  try {
    // Create Supabase client (uses service role for admin operations)
    const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });
    // Parse request body
    const body = await req.json();
    const { action, player_id, playlist_id, name, description, media_item_id, item_ids, url, current_index } = body;
    // Handle playlist creation
    if (action === 'create') {
      if (!player_id || !name) {
        return new Response(JSON.stringify({
          error: 'player_id and name are required'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      const { data: playlist, error: createError } = await supabase.from('playlists').insert({
        player_id,
        name,
        description: description || null
      }).select().maybeSingle();
      if (createError) throw createError;
      if (!playlist) {
        return new Response(JSON.stringify({
          error: 'Playlist creation failed'
        }), {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      return new Response(JSON.stringify({
        playlist
      }), {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Handle playlist update
    if (action === 'update') {
      if (!playlist_id) {
        return new Response(JSON.stringify({
          error: 'playlist_id is required'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      const updateData = {};
      if (name) updateData.name = name;
      if (description !== undefined) updateData.description = description;
      const { data: playlist, error: updateError } = await supabase.from('playlists').update(updateData).eq('id', playlist_id).select().maybeSingle();
      if (updateError) throw updateError;
      if (!playlist) {
        return new Response(JSON.stringify({
          error: 'Playlist update failed'
        }), {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      return new Response(JSON.stringify({
        playlist
      }), {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Handle playlist deletion
    if (action === 'delete') {
      if (!playlist_id) {
        return new Response(JSON.stringify({
          error: 'playlist_id is required'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      const { error: deleteError } = await supabase.from('playlists').delete().eq('id', playlist_id);
      if (deleteError) throw deleteError;
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
    // Handle adding item to playlist
    if (action === 'add_item') {
      if (!playlist_id || !media_item_id) {
        return new Response(JSON.stringify({
          error: 'playlist_id and media_item_id are required'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      // Get next position
      const { data: maxPos } = await supabase.from('playlist_items').select('position').eq('playlist_id', playlist_id).order('position', {
        ascending: false
      }).limit(1).maybeSingle();
      const nextPosition = (maxPos?.position ?? -1) + 1;
      const { data: item, error: addError } = await supabase.from('playlist_items').insert({
        playlist_id,
        media_item_id,
        position: nextPosition
      }).select().maybeSingle();
      if (addError) throw addError;
      if (!item) {
        return new Response(JSON.stringify({
          error: 'Failed to add item to playlist'
        }), {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      return new Response(JSON.stringify({
        item
      }), {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Handle removing item from playlist
    if (action === 'remove_item') {
      if (!playlist_id || !media_item_id) {
        return new Response(JSON.stringify({
          error: 'playlist_id and media_item_id are required'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      const { error: removeError } = await supabase.from('playlist_items').delete().eq('playlist_id', playlist_id).eq('media_item_id', media_item_id);
      if (removeError) throw removeError;
      // Reorder remaining items
      const { data: items } = await supabase.from('playlist_items').select('id').eq('playlist_id', playlist_id).order('position', {
        ascending: true
      });
      if (items && items.length > 0) {
        for(let i = 0; i < items.length; i++){
          await supabase.from('playlist_items').update({
            position: i
          }).eq('id', items[i].id);
        }
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
    // Handle reordering playlist items
    if (action === 'reorder') {
      if (!playlist_id || !item_ids || !Array.isArray(item_ids)) {
        return new Response(JSON.stringify({
          error: 'playlist_id and item_ids array are required'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      // Update positions
      for(let i = 0; i < item_ids.length; i++){
        await supabase.from('playlist_items').update({
          position: i
        }).eq('id', item_ids[i]).eq('playlist_id', playlist_id);
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
    // Handle media scraping (YouTube integration)
    if (action === 'scrape') {
      if (!url) {
        return new Response(JSON.stringify({
          error: 'url is required for scraping'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      // Call youtube-scraper function
      const scrapeResponse = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/youtube-scraper`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`
        },
        body: JSON.stringify({
          url
        })
      });
      if (!scrapeResponse.ok) {
        const errorData = await scrapeResponse.json();
        throw new Error(errorData.error || 'YouTube scraper failed');
      }
      const { videos } = await scrapeResponse.json();
      if (!videos || videos.length === 0) {
        return new Response(JSON.stringify({
          error: 'No videos found at the provided URL'
        }), {
          status: 404,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      // Insert media items — canonical deduplication via create_or_get_media_item RPC
      const mediaItems = [];
      for (const video of videos){
        const { data: mediaId } = await supabase.rpc('create_or_get_media_item', {
          p_source_id:   video.id,
          p_source_type: 'youtube',
          p_title:       video.title,
          p_artist:      video.artist || null,
          p_url:         video.url,
          p_duration:    video.duration || null,
          p_thumbnail:   video.thumbnail || null,
          p_metadata:    {},
        });
        if (mediaId) {
          const { data: fullItem } = await supabase.from('media_items').select('*').eq('id', mediaId).maybeSingle();
          if (fullItem) mediaItems.push(fullItem);
        }
      }
      // If playlist_id provided, add items to playlist
      if (playlist_id) {
        // Get current max position
        const { data: maxPos } = await supabase.from('playlist_items').select('position').eq('playlist_id', playlist_id).order('position', {
          ascending: false
        }).limit(1).maybeSingle();
        let position = (maxPos?.position || 0) + 1;
        // Batch insert playlist items
        const playlistItems = mediaItems.map((media)=>({
            playlist_id,
            media_item_id: media.id,
            position: position++
          }));
        await supabase.from('playlist_items').insert(playlistItems);
      }
      return new Response(JSON.stringify({
        media_items: mediaItems,
        count: mediaItems.length,
        playlist_id: playlist_id || null
      }), {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Handle setting a playlist as active for a player (server-side)
    if (action === 'set_active') {
      if (!player_id || !playlist_id) {
        return new Response(JSON.stringify({
          error: 'player_id and playlist_id are required'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      // Unset any existing active playlists for this player
      const { error: unsetError } = await supabase.from('playlists').update({
        is_active: false
      }).eq('player_id', player_id);
      if (unsetError) throw unsetError;
      // Set the requested playlist active
      const { error: setError } = await supabase.from('playlists').update({
        is_active: true
      }).eq('id', playlist_id);
      if (setError) throw setError;
      // Update player's active_playlist_id
      const { error: playerUpdateError } = await supabase.from('players').update({
        active_playlist_id: playlist_id
      }).eq('id', player_id);
      if (playerUpdateError) throw playerUpdateError;
      // If current_index is provided, update player_status
      if (current_index !== undefined) {
        const { error: statusError } = await supabase.from('player_status').update({
          now_playing_index: current_index
        }).eq('player_id', player_id);
        if (statusError) throw statusError;
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
    // Handle clearing the queue
    // NOTE: always pass p_type='normal' so priority (kiosk) items are never destroyed.
    // The old 3-step flow (set_active→clear_queue→import_queue) called this with no type,
    // which cleared ALL items including priority queue entries.
    if (action === 'clear_queue') {
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
      const { error: clearError } = await supabase.rpc('queue_clear', {
        p_player_id: player_id,
        p_type: 'normal'
      });
      if (clearError) throw clearError;
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
    // Handle importing playlist into queue
    if (action === 'import_queue') {
      if (!player_id || !playlist_id) {
        return new Response(JSON.stringify({
          error: 'player_id and playlist_id are required'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      // Check current player state
      const { data: currentStatus } = await supabase.from('player_status').select('state').eq('player_id', player_id).maybeSingle();
      // Use load_playlist RPC to import the playlist into queue
      const { data: loaded, error: importError } = await supabase.rpc('load_playlist', {
        p_player_id: player_id,
        p_playlist_id: playlist_id,
        p_start_index: 0
      });
      if (importError) throw importError;
      // Reset now_playing_index to -1 (Now Playing position)
      // Only reset state/progress/current_media if player is not currently playing
      const updateData = {
        now_playing_index: -1
      };
      // If player is not playing or paused, reset the playback state
      if (!currentStatus || currentStatus.state !== 'playing' && currentStatus.state !== 'paused') {
        updateData.current_media_id = null;
        updateData.state = 'idle';
        updateData.progress = 0;
      }
      const { error: indexError } = await supabase.from('player_status').update(updateData).eq('player_id', player_id);
      if (indexError) throw indexError;
      return new Response(JSON.stringify({
        loaded_count: loaded?.[0]?.loaded_count || 0
      }), {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Handle atomic playlist load (replaces the 3-call set_active+clear_queue+import_queue sequence)
    // Uses the load_playlist RPC which handles locking, shuffle, queue clear, and status update atomically.
    if (action === 'load_playlist') {
      if (!player_id || !playlist_id) {
        return new Response(JSON.stringify({
          error: 'player_id and playlist_id are required'
        }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      const { data: loaded, error: loadError } = await supabase.rpc('load_playlist', {
        p_player_id:   player_id,
        p_playlist_id: playlist_id,
        p_start_index: 0
      });
      if (loadError) throw loadError;
      return new Response(JSON.stringify({
        success: true,
        loaded_count: loaded?.[0]?.loaded_count || 0
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    // Handle removing a media item from all playlists for a player.
    // Used when a video becomes unavailable — player calls this so the
    // deletion goes through a server function rather than direct DB access.
    if (action === 'remove_media_globally') {
      if (!player_id || !media_item_id) {
        return new Response(JSON.stringify({
          error: 'player_id and media_item_id are required'
        }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      // Delete from all playlist_items regardless of which playlist they belong to
      const { error: deleteError } = await supabase
        .from('playlist_items')
        .delete()
        .eq('media_item_id', media_item_id);
      if (deleteError) throw deleteError;
      // Log the removal for operator visibility
      await supabase.from('system_logs').insert({
        player_id,
        level:   'warn',
        event:   'media_removed_unavailable',
        details: { media_item_id }
      });
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({
      error: `Unknown action: ${action}`
    }), {
      status: 400,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('Playlist manager error:', error);
    return new Response(JSON.stringify({
      error: error.message
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
});
