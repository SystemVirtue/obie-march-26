// Kiosk Handler Edge Function
// Handles kiosk operations: search, credits, song requests
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
    // Initialize Supabase client with service role key
    const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
    // Parse request body
    const body = await req.json();
    const { action } = body;
    console.log('Action:', action);
    // Handle session initialization
    if (action === 'init') {
      console.log('Creating new kiosk session');
      // Get the default player (first player in the system)
      const { data: player, error: playerError } = await supabase.from('players').select('id').limit(1).single();
      if (playerError || !player) {
        console.error('No player found:', playerError);
        return new Response(JSON.stringify({
          error: 'No player configured'
        }), {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      // Create new session
      const { data: session, error: sessionError } = await supabase.from('kiosk_sessions').insert({
        player_id: player.id,
        credits: 0
      }).select().single();
      if (sessionError || !session) {
        console.error('Failed to create session:', sessionError);
        return new Response(JSON.stringify({
          error: 'Failed to create session'
        }), {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      console.log('Created session:', session.session_id);
      return new Response(JSON.stringify({
        session
      }), {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Handle free-text search forwarded to youtube-scraper (server-side)
    if (action === 'search') {
      const query = body.query || '';
      try {
        // Forward search to youtube-scraper using service role key so yt-dlp or API can be used server-side
        const scraperResp = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/youtube-scraper`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`
          },
          body: JSON.stringify({
            query,
            type: 'search'
          })
        });
        const payload = await scraperResp.text();
        // Pass through status and body
        return new Response(payload, {
          status: scraperResp.status,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      } catch (err) {
        console.error('Kiosk handler search error:', err);
        return new Response(JSON.stringify({
          error: err.message
        }), {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
    }
    // Handle atomic request enqueue: deduct credits (unless freeplay) and enqueue as priority
    if (action === 'request') {
      const { session_id, url, player_id, media_item_id } = body;
      if (!session_id || (!url && !media_item_id)) {
        return new Response(JSON.stringify({
          error: 'session_id and either url or media_item_id are required for request action'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }

      let mediaItemId = media_item_id;

      // If URL provided, scrape it first to get/create media item
      if (url && !mediaItemId) {
        try {
          console.log('Scraping URL for kiosk request:', url);
          const scraperResp = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/youtube-scraper`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${Deno.env.get('SUPABASE_ANON_KEY')}`,
            },
            body: JSON.stringify({ url, type: 'auto' }),
          });

          if (!scraperResp.ok) {
            const errorText = await scraperResp.text();
            console.error('Scraper failed:', errorText);
            return new Response(JSON.stringify({
              error: 'Failed to scrape video URL'
            }), {
              status: 400,
              headers: {
                ...corsHeaders,
                'Content-Type': 'application/json'
              }
            });
          }

          const { videos } = await scraperResp.json();
          if (!videos || videos.length === 0) {
            return new Response(JSON.stringify({
              error: 'No videos found at the provided URL'
            }), {
              status: 400,
              headers: {
                ...corsHeaders,
                'Content-Type': 'application/json'
              }
            });
          }

          // Use the first video
          const video = videos[0];

          // Stricter validation: required fields must be non-empty strings
          if (!video || typeof video.id !== 'string' || !video.id.trim() ||
              typeof video.url !== 'string' || !video.url.trim() ||
              typeof video.title !== 'string' || !video.title.trim()) {
            console.error('Invalid video object from scraper:', video);
            // Log to system_logs for failed scrape/validation
            await supabase.from('system_logs').insert({
              player_id,
              event: 'kiosk_request_failed',
              severity: 'error',
              payload: {
                reason: 'Invalid video data from YouTube scraper',
                video
              }
            });
            return new Response(JSON.stringify({
              error: 'Invalid video data from YouTube scraper.',
              details: video
            }), {
              status: 400,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
          }

          // Use video.id directly for source_id
          const sourceId = `youtube:${video.id}`;

          // Create or update media item — canonical dedup via create_or_get_media_item RPC
          const { data: resolvedId, error: mediaError } = await supabase.rpc('create_or_get_media_item', {
            p_source_id:   sourceId,
            p_source_type: 'youtube',
            p_title:       video.title,
            p_artist:      video.artist || null,
            p_url:         video.url,
            p_duration:    video.duration || null,
            p_thumbnail:   video.thumbnail || null,
            p_metadata:    {},
          });

          if (mediaError || !resolvedId) {
            console.error('Failed to create/get media item:', mediaError, video);
            // Log to system_logs for failed media item creation
            await supabase.from('system_logs').insert({
              player_id,
              event: 'media_item_create_failed',
              severity: 'error',
              payload: {
                error: mediaError,
                video,
                sourceId
              }
            });
            return new Response(JSON.stringify({
              error: 'Failed to create media item',
              details: mediaError,
              video
            }), {
              status: 500,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
          }

          mediaItemId = resolvedId;
        } catch (scrapeError) {
          console.error('Scraping error:', scrapeError);
          return new Response(JSON.stringify({
            error: 'Failed to process video URL'
          }), {
            status: 500,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json'
            }
          });
        }
      }

      if (!mediaItemId) {
        return new Response(JSON.stringify({
          error: 'No media item ID available'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }

      try {
        // Call DB RPC which performs an atomic debit-and-enqueue
        const { data: queueId, error: rpcError } = await supabase.rpc('kiosk_request_enqueue', {
          p_session_id: session_id,
          p_media_item_id: mediaItemId
        });
        if (rpcError) {
          console.error('kiosk_request_enqueue error:', rpcError);
          return new Response(JSON.stringify({
            error: rpcError.message || rpcError
          }), {
            status: 400,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json'
            }
          });
        }
        // Log the successful kiosk request
        const { data: mediaItem } = await supabase
          .from('media_items')
          .select('title, artist')
          .eq('id', mediaItemId)
          .single();

        await supabase.from('system_logs').insert({
          player_id,
          event: 'kiosk_request',
          severity: 'info',
          payload: {
            session_id,
            media_item_id: mediaItemId,
            queue_id: queueId,
            title: mediaItem?.title || 'Unknown',
            artist: mediaItem?.artist || 'Unknown'
          }
        });

        return new Response(JSON.stringify({
          queue_id: queueId
        }), {
          status: 200,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      } catch (err) {
        console.error('Kiosk handler request error:', err);
        return new Response(JSON.stringify({
          error: err.message
        }), {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
    }
    // Handle iframe video validation check
    if (action === 'check') {
      const { url } = body;
      if (!url) {
        return new Response(JSON.stringify({
          error: 'url is required for check action'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }

      try {
        // Extract video ID from YouTube URL
        let videoId = null;
        const youtubeRegex = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\n?#]+)/;
        const match = url.match(youtubeRegex);
        if (match && match[1]) {
          videoId = match[1];
        }

        if (!videoId) {
          return new Response(JSON.stringify({
            valid: false,
            reason: 'Invalid YouTube URL'
          }), {
            status: 200,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json'
            }
          });
        }

        // Test iframe embedding by attempting to load the video in an iframe
        // Use GET request (HEAD often fails with YouTube), but don't download the full page
        try {
          const embedUrl = `https://www.youtube.com/embed/${videoId}?autoplay=0`;
          const embedResponse = await fetch(embedUrl, {
            method: 'GET',
            redirect: 'follow'
          });

          // Only mark as invalid if we get a clear 404 or 403 error
          // Status 200-399 = valid (includes redirects handled by fetch)
          if (embedResponse.status === 404 || embedResponse.status === 403) {
            return new Response(JSON.stringify({
              valid: false,
              reason: 'Video is not available for iframe playback'
            }), {
              status: 200,
              headers: {
                ...corsHeaders,
                'Content-Type': 'application/json'
              }
            });
          }

          // Video appears to be embeddable
          return new Response(JSON.stringify({
            valid: true,
            reason: 'Video is available for iframe playback'
          }), {
            status: 200,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json'
            }
          });
        } catch (embedError) {
          console.error('Error checking iframe availability:', embedError);
          // On network errors, assume the video is valid (fail open)
          return new Response(JSON.stringify({
            valid: true,
            reason: 'Could not verify, but proceeding with video'
          }), {
            status: 200,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json'
            }
          });
        }
      } catch (err) {
        console.error('Check action error:', err);
        return new Response(JSON.stringify({
          error: err.message
        }), {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
    }

    // Handle R2 video search — queries r2_files table
    if (action === 'search_r2') {
      const query = (body.query || '').trim();
      try {
        let dbQuery = supabase
          .from('r2_files')
          .select('*')
          .order('title', { ascending: true })
          .limit(50);

        if (query.length > 0) {
          // Search across title, file_name, and artist using ilike
          dbQuery = supabase
            .from('r2_files')
            .select('*')
            .or(`title.ilike.%${query}%,file_name.ilike.%${query}%,artist.ilike.%${query}%`)
            .order('title', { ascending: true })
            .limit(50);
        }

        const { data: files, error: searchError } = await dbQuery;
        if (searchError) {
          console.error('R2 search error:', searchError);
          return new Response(JSON.stringify({ error: searchError.message }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Map r2_files to the same SearchResult shape as YouTube results
        const videos = (files || []).map((f: any) => ({
          id: f.id,
          title: f.title || f.file_name,
          artist: f.artist || null,
          channelTitle: f.artist || 'Cloudflare R2',
          thumbnail: f.thumbnail || '',
          thumbnailUrl: f.thumbnail || '',
          url: f.public_url,
          videoUrl: f.public_url,
          duration: f.duration || null,
          source: 'cloudflare',
        }));

        return new Response(JSON.stringify({ videos }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } catch (err) {
        console.error('R2 search error:', err);
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // Handle R2 video request — creates media_item from r2_file and enqueues
    if (action === 'request_r2') {
      const { session_id, r2_file_id, player_id } = body;
      if (!session_id || !r2_file_id) {
        return new Response(JSON.stringify({
          error: 'session_id and r2_file_id are required for request_r2 action',
        }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      try {
        // Fetch the R2 file metadata
        const { data: r2File, error: r2Error } = await supabase
          .from('r2_files')
          .select('*')
          .eq('id', r2_file_id)
          .single();

        if (r2Error || !r2File) {
          return new Response(JSON.stringify({ error: 'R2 file not found' }), {
            status: 404,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Create or get media item using the existing RPC
        const sourceId = `cloudflare:${r2File.object_key}`;
        const { data: mediaItemId, error: mediaError } = await supabase.rpc('create_or_get_media_item', {
          p_source_id: sourceId,
          p_source_type: 'cloudflare',
          p_title: r2File.title || r2File.file_name,
          p_artist: r2File.artist || null,
          p_url: r2File.public_url,
          p_duration: r2File.duration || null,
          p_thumbnail: r2File.thumbnail || null,
          p_metadata: { bucket: r2File.bucket_name, object_key: r2File.object_key },
        });

        if (mediaError || !mediaItemId) {
          console.error('Failed to create media item from R2 file:', mediaError);
          return new Response(JSON.stringify({
            error: 'Failed to create media item',
            details: mediaError,
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Enqueue using existing kiosk_request_enqueue RPC (handles credits)
        const { data: queueId, error: rpcError } = await supabase.rpc('kiosk_request_enqueue', {
          p_session_id: session_id,
          p_media_item_id: mediaItemId,
        });

        if (rpcError) {
          console.error('kiosk_request_enqueue error:', rpcError);
          return new Response(JSON.stringify({ error: rpcError.message || rpcError }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        // Log the request
        await supabase.from('system_logs').insert({
          player_id,
          event: 'kiosk_request_r2',
          severity: 'info',
          payload: {
            session_id,
            r2_file_id,
            media_item_id: mediaItemId,
            queue_id: queueId,
            title: r2File.title || r2File.file_name,
            artist: r2File.artist || null,
          },
        });

        return new Response(JSON.stringify({ queue_id: queueId }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } catch (err) {
        console.error('R2 request error:', err);
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // Handle adding credits to a session (e.g., coin insert)
    if (action === 'credit') {
      const { session_id, amount } = body;
      if (!session_id || typeof amount !== 'number') {
        return new Response(JSON.stringify({
          error: 'session_id and numeric amount are required for credit action'
        }), {
          status: 400,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
      try {
        const { data: existing, error: fetchErr } = await supabase.from('kiosk_sessions').select('credits').eq('session_id', session_id).single();
        if (fetchErr || !existing) {
          return new Response(JSON.stringify({
            error: 'Session not found'
          }), {
            status: 404,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json'
            }
          });
        }
        const newCredits = (existing.credits || 0) + amount;
        const { data: updated, error: updErr } = await supabase.from('kiosk_sessions').update({
          credits: newCredits
        }).eq('session_id', session_id).select().single();
        if (updErr) {
          console.error('Failed to update credits:', updErr);
          return new Response(JSON.stringify({
            error: updErr.message || updErr
          }), {
            status: 500,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json'
            }
          });
        }
        return new Response(JSON.stringify({
          credits: updated.credits
        }), {
          status: 200,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      } catch (err) {
        console.error('Credit action error:', err);
        return new Response(JSON.stringify({
          error: err.message
        }), {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        });
      }
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
    console.error('Kiosk handler error:', error);
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
