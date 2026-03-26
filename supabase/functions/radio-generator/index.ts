// Radio Generator Edge Function
// Generates a "radio" playlist based on seed tracks (now playing, history, or active playlist).
// Uses OpenRouter LLM to recommend songs, then matches against R2 collection with YouTube fallback.
import { corsHeaders } from '../_shared/cors.ts';
import { createServiceClient } from '../_shared/supabase-client.ts';
import { callYouTubeScraperWithFallback } from '../_shared/youtube-scraper-caller.ts';

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const PRIMARY_MODEL = 'deepseek/deepseek-chat';
const FALLBACK_MODEL = 'google/gemini-2.0-flash-lite-001';
const FALLBACK_MODEL_2 = 'meta-llama/llama-3.3-70b-instruct:free';
const MAX_ARTIST_COUNT = 2;

interface SeedTrack {
  title: string;
  artist: string | null;
}

interface LLMRecommendation {
  title: string;
  artist: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function calculateTargetCount(seedCount: number): number {
  return Math.min(50, Math.max(10, Math.round(seedCount * 2.5)));
}

function formatTimestamp(): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  return `${yy}${mm}${dd}${hh}${mi}`;
}

function buildPrompt(seeds: SeedTrack[], requestCount: number): string {
  const seedList = seeds
    .map((s, i) => `${i + 1}. "${s.title}" - ${s.artist || 'Unknown Artist'}`)
    .join('\n');

  return `You are a music recommendation engine. Given these recently played songs, suggest ${requestCount} songs for a radio playlist that continues this listening session's vibe.

Recently played:
${seedList}

Rules:
- Match the overall genre, mood, era, and style of the seed songs
- Include variety while maintaining stylistic coherence
- Maximum 2 songs per artist
- Do NOT repeat any of the seed songs
- Do NOT include any artist that already appears in the seed songs
- Include a mix of well-known and lesser-known tracks
- Focus on real, existing songs

Return ONLY a valid JSON array with no other text:
[{"title": "...", "artist": "..."}, ...]`;
}

function parseRecommendations(text: string): LLMRecommendation[] {
  // Try to extract JSON array from the response
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('No JSON array found in LLM response');

  const parsed = JSON.parse(jsonMatch[0]);
  if (!Array.isArray(parsed)) throw new Error('LLM response is not an array');

  return parsed
    .filter((item: any) => item && typeof item.title === 'string' && typeof item.artist === 'string')
    .map((item: any) => ({ title: item.title.trim(), artist: item.artist.trim() }));
}

function enforceArtistCap(tracks: { title: string; artist: string; mediaId: string; source: string }[], maxPerArtist: number) {
  const artistCounts: Record<string, number> = {};
  return tracks.filter(t => {
    const key = t.artist.toLowerCase();
    artistCounts[key] = (artistCounts[key] || 0) + 1;
    return artistCounts[key] <= maxPerArtist;
  });
}

// ─── OpenRouter LLM Call ────────────────────────────────────────────────────

async function callLLM(prompt: string, apiKey: string): Promise<string> {
  const models = [PRIMARY_MODEL, FALLBACK_MODEL, FALLBACK_MODEL_2];
  const errors: string[] = [];

  for (const model of models) {
    try {
      console.log(`[Radio] Calling OpenRouter model: ${model}`);
      const response = await fetch(OPENROUTER_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://djamms.app',
          'X-Title': 'DJAMMS Radio Generator',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.8,
          max_tokens: 4096,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        const errMsg = `${model}: HTTP ${response.status} - ${errText.slice(0, 300)}`;
        console.error(`[Radio] ${errMsg}`);
        errors.push(errMsg);
        continue;
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        const errMsg = `${model}: No content in response - ${JSON.stringify(data).slice(0, 200)}`;
        console.error(`[Radio] ${errMsg}`);
        errors.push(errMsg);
        continue;
      }

      console.log(`[Radio] Got response from ${model} (${content.length} chars)`);
      try {
        parseRecommendations(content); // validate before accepting
      } catch (parseErr) {
        const errMsg = `${model}: parse failed - ${parseErr.message}`;
        console.error(`[Radio] ${errMsg}`);
        errors.push(errMsg);
        continue;
      }
      return content;
    } catch (err) {
      const errMsg = `${model}: ${err.message}`;
      console.error(`[Radio] ${errMsg}`);
      errors.push(errMsg);
      continue;
    }
  }

  throw new Error(`All LLM models failed: ${errors.join(' | ')}`);
}

// ─── R2 Fuzzy Match ─────────────────────────────────────────────────────────

async function matchR2(supabase: any, title: string, artist: string): Promise<any | null> {
  // Strategy 1: Match both title and artist with ILIKE
  const { data: exact } = await supabase
    .from('r2_files')
    .select('id, title, artist, public_url, duration, thumbnail, object_key')
    .ilike('title', `%${title}%`)
    .ilike('artist', `%${artist}%`)
    .limit(1)
    .maybeSingle();

  if (exact) return exact;

  // Strategy 2: Title-only match (looser)
  const { data: titleOnly } = await supabase
    .from('r2_files')
    .select('id, title, artist, public_url, duration, thumbnail, object_key')
    .ilike('title', `%${title}%`)
    .limit(1)
    .maybeSingle();

  return titleOnly || null;
}

// ─── Seed Track Loaders ─────────────────────────────────────────────────────

async function loadSeedsNowPlaying(supabase: any, playerId: string): Promise<SeedTrack[]> {
  const { data: status } = await supabase
    .from('player_status')
    .select('current_media_id')
    .eq('player_id', playerId)
    .maybeSingle();

  if (!status?.current_media_id) throw new Error('Nothing is currently playing');

  const { data: media } = await supabase
    .from('media_items')
    .select('title, artist')
    .eq('id', status.current_media_id)
    .maybeSingle();

  if (!media) throw new Error('Current media item not found');
  return [{ title: media.title, artist: media.artist }];
}

async function loadSeedsHistory(supabase: any, playerId: string): Promise<SeedTrack[]> {
  const { data: queueItems } = await supabase
    .from('queue')
    .select('media_item_id, media_item:media_items(title, artist)')
    .eq('player_id', playerId)
    .not('played_at', 'is', null)
    .order('played_at', { ascending: false })
    .limit(20);

  if (!queueItems || queueItems.length === 0) throw new Error('No play history found');

  return queueItems
    .filter((q: any) => q.media_item)
    .map((q: any) => ({ title: q.media_item.title, artist: q.media_item.artist }));
}

async function loadSeedsPlaylist(supabase: any, playerId: string): Promise<SeedTrack[]> {
  const { data: player } = await supabase
    .from('players')
    .select('active_playlist_id')
    .eq('id', playerId)
    .maybeSingle();

  if (!player?.active_playlist_id) throw new Error('No active playlist');

  const { data: items } = await supabase
    .from('playlist_items')
    .select('media_item:media_items(title, artist)')
    .eq('playlist_id', player.active_playlist_id)
    .order('position', { ascending: true })
    .limit(50);

  if (!items || items.length === 0) throw new Error('Active playlist is empty');

  return items
    .filter((i: any) => i.media_item)
    .map((i: any) => ({ title: i.media_item.title, artist: i.media_item.artist }));
}

// ─── Main Handler ───────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const openrouterApiKey = Deno.env.get('OPENROUTER_API_KEY') ?? Deno.env.get('DJAMMS_RADIO');
    if (!openrouterApiKey) throw new Error('OPENROUTER_API_KEY (or DJAMMS_RADIO) not configured');

    const serviceRoleToken = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_JWT');
    const anonJwt = Deno.env.get('SUPABASE_ANON_KEY');
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabase = createServiceClient();

    const raw = await req.text();
    if (!raw) {
      return new Response(JSON.stringify({ error: 'Request body is required (JSON).' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let body: any;
    try {
      body = JSON.parse(raw);
    } catch (e) {
      console.error('[Radio] Invalid JSON body:', raw);
      return new Response(JSON.stringify({ error: 'Invalid JSON body.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { action, player_id, source } = body;

    // Debug action: test OpenRouter connectivity (service role only)
    if (action === 'debug') {
      const authHeader = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
      if (!authHeader || authHeader !== serviceRoleToken) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const testResponse = await fetch(OPENROUTER_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openrouterApiKey}`,
          'HTTP-Referer': 'https://djamms.app',
          'X-Title': 'DJAMMS Radio Generator',
        },
        body: JSON.stringify({
          model: PRIMARY_MODEL,
          messages: [{ role: 'user', content: 'Say hello in 5 words.' }],
          max_tokens: 50,
        }),
      });
      return new Response(JSON.stringify({
        ok: testResponse.ok,
        status: testResponse.status,
        model: PRIMARY_MODEL,
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (action !== 'generate') {
      return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!player_id) {
      return new Response(JSON.stringify({ error: 'player_id is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!['now_playing', 'history', 'playlist'].includes(source)) {
      return new Response(JSON.stringify({ error: 'source must be now_playing, history, or playlist' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 1. Load seed tracks
    console.log(`[Radio] Loading seeds from ${source} for player ${player_id}`);
    let seeds: SeedTrack[];
    if (source === 'now_playing') {
      seeds = await loadSeedsNowPlaying(supabase, player_id);
    } else if (source === 'history') {
      seeds = await loadSeedsHistory(supabase, player_id);
    } else {
      seeds = await loadSeedsPlaylist(supabase, player_id);
    }
    console.log(`[Radio] Loaded ${seeds.length} seed tracks`);

    // 2. Calculate target and request counts
    const targetCount = calculateTargetCount(seeds.length);
    const requestCount = Math.round(targetCount * 1.5);
    console.log(`[Radio] Target: ${targetCount}, requesting: ${requestCount}`);

    // 3. Call LLM for recommendations
    const prompt = buildPrompt(seeds, requestCount);
    const llmResponse = await callLLM(prompt, openrouterApiKey);
    const recommendations = parseRecommendations(llmResponse);
    console.log(`[Radio] LLM returned ${recommendations.length} recommendations`);

    // 4. Match recommendations against R2 and YouTube
    const resolvedTracks: { title: string; artist: string; mediaId: string; source: string }[] = [];
    let r2Matches = 0;
    let ytMatches = 0;

    for (const rec of recommendations) {
      if (resolvedTracks.length >= targetCount) break;

      // Try R2 first
      const r2Match = await matchR2(supabase, rec.title, rec.artist);
      if (r2Match) {
        const sourceId = `cloudflare:${r2Match.object_key}`;
        const { data: mediaId } = await supabase.rpc('create_or_get_media_item', {
          p_source_id: sourceId,
          p_source_type: 'cloudflare',
          p_title: r2Match.title || rec.title,
          p_artist: r2Match.artist || rec.artist,
          p_url: r2Match.public_url,
          p_duration: r2Match.duration || null,
          p_thumbnail: r2Match.thumbnail || null,
          p_metadata: {},
        });
        if (mediaId) {
          resolvedTracks.push({ title: r2Match.title || rec.title, artist: r2Match.artist || rec.artist, mediaId, source: 'r2' });
          r2Matches++;
          continue;
        }
      }

      // Fall back to YouTube search
      try {
        const searchQuery = `${rec.title} ${rec.artist} official`;
        const scrapeResponse = await callYouTubeScraperWithFallback({
          supabaseUrl,
          payload: { url: searchQuery, type: 'search' },
          incomingAuthorization: req.headers.get('Authorization'),
          serviceRoleToken,
          anonJwt,
        });

        if (scrapeResponse.ok) {
          const { videos } = await scrapeResponse.json();
          if (videos && videos.length > 0) {
            const video = videos[0];
            const sourceId = `youtube:${video.id}`;
            const { data: mediaId } = await supabase.rpc('create_or_get_media_item', {
              p_source_id: sourceId,
              p_source_type: 'youtube',
              p_title: video.title || rec.title,
              p_artist: video.artist || rec.artist,
              p_url: video.url,
              p_duration: video.duration || null,
              p_thumbnail: video.thumbnail || null,
              p_metadata: {},
            });
            if (mediaId) {
              resolvedTracks.push({ title: video.title || rec.title, artist: video.artist || rec.artist, mediaId, source: 'youtube' });
              ytMatches++;
            }
          }
        }
      } catch (err) {
        console.error(`[Radio] YouTube search failed for "${rec.title} - ${rec.artist}":`, err);
      }
    }

    console.log(`[Radio] Resolved ${resolvedTracks.length} tracks (R2: ${r2Matches}, YT: ${ytMatches})`);

    // 5. Post-process: enforce artist cap
    const capped = enforceArtistCap(resolvedTracks, MAX_ARTIST_COUNT);
    const finalTracks = capped.slice(0, targetCount);
    console.log(`[Radio] After artist cap: ${finalTracks.length} tracks`);

    if (finalTracks.length === 0) {
      throw new Error('No tracks could be resolved from LLM recommendations');
    }

    // 6. Create playlist
    const playlistName = `RADIO - ${formatTimestamp()}`;
    const seedSummary = seeds.slice(0, 5).map(s => `${s.title} - ${s.artist || '?'}`).join(', ');
    const description = `Generated from ${source} (${seeds.length} seed${seeds.length !== 1 ? 's' : ''}): ${seedSummary}${seeds.length > 5 ? '...' : ''}`;

    const { data: playlist, error: createError } = await supabase
      .from('playlists')
      .insert({
        player_id,
        name: playlistName,
        description,
      })
      .select()
      .maybeSingle();

    if (createError) throw createError;
    if (!playlist) throw new Error('Playlist creation failed');

    // 7. Add tracks as playlist items
    const playlistItems = finalTracks.map((t, i) => ({
      playlist_id: playlist.id,
      media_item_id: t.mediaId,
      position: i,
    }));
    const { error: insertError } = await supabase.from('playlist_items').insert(playlistItems);
    if (insertError) throw insertError;

    // 8. Load playlist to queue (atomically replaces current queue)
    const { error: loadError } = await supabase.rpc('load_playlist', {
      p_player_id: player_id,
      p_playlist_id: playlist.id,
      p_start_index: 0,
    });
    if (loadError) throw loadError;

    console.log(`[Radio] Created playlist "${playlistName}" with ${finalTracks.length} tracks, loaded to queue`);

    return new Response(JSON.stringify({
      playlist_id: playlist.id,
      playlist_name: playlistName,
      track_count: finalTracks.length,
      tracks: finalTracks.map(t => ({ title: t.title, artist: t.artist, source: t.source })),
      sources: { r2: r2Matches, youtube: ytMatches },
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('[Radio] Error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
