// YouTube Scraper Edge Function
// Fetches metadata from YouTube videos and playlists using YouTube Data API v3
/// <reference lib="deno.window" />
import { corsHeaders } from '../_shared/cors.ts';

// Type definitions
interface ApiKey {
  key: string;
  name: string;
}

interface Video {
  id: string;
  title: string;
  artist: string;
  duration: number;
  thumbnail: string;
  url: string;
  embeddable?: boolean;
}

// API Key rotation — reads from YOUTUBE_API_KEY_1..8 Supabase secrets
// These must be configured in your Supabase project settings
const API_KEYS: ApiKey[] = Array.from({ length: 8 }, (_, i) => {
  const key = Deno.env.get(`YOUTUBE_API_KEY_${i + 1}`);
  if (key) {
    return {
      key,
      name: `Key ${i + 1}`,
    };
  }
  return null;
}).filter((k): k is ApiKey => k !== null);
let currentKeyIndex = 0;
const failedKeys = new Set();

// Validate that at least one API key is configured
if (API_KEYS.length === 0) {
  console.error('ERROR: No YouTube API keys configured. Set YOUTUBE_API_KEY_1 through YOUTUBE_API_KEY_8 in Supabase secrets.');
}

function getNextApiKey(): string {
  // Find next valid key (not in failed list) from the rotation pool
  const startIndex = currentKeyIndex;
  do {
    if (!failedKeys.has(currentKeyIndex)) {
      const key = API_KEYS[currentKeyIndex].key;
      const keyName = API_KEYS[currentKeyIndex].name;
      currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length;
      console.log(`Using ${keyName}`);
      return key;
    }
    currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length;
  }while (currentKeyIndex !== startIndex)
  // All keys failed - reset and try again
  console.log('All keys exhausted, resetting failed keys list');
  failedKeys.clear();
  const key = API_KEYS[currentKeyIndex].key;
  currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length;
  return key;
}

function markKeyAsFailed(apiKey: string): void {
  const index = API_KEYS.findIndex((k) => k.key === apiKey);
  if (index !== -1) {
    failedKeys.add(index);
    console.log(`Marked ${API_KEYS[index].name} as failed/quota exceeded`);
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders
    });
  }
  try {
    // Check if API keys are configured
    if (API_KEYS.length === 0) {
      return new Response(JSON.stringify({
        error: 'YouTube API keys not configured. Contact administrator.'
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }

    let videos: Video[] = [];
    let lastError: Error | null = null;
    const maxRetries = API_KEYS.length; // Try all keys if needed
    const body = await req.json();
    const { url, query, type = 'auto' } = body;
    if (type !== 'search' && !url) {
      return new Response(JSON.stringify({
        error: 'url is required'
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    if (type === 'search' && !query) {
      return new Response(JSON.stringify({
        error: 'query is required for search'
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Extract video or playlist ID from URL (only for non-search requests)
    let videoId = null;
    let playlistId = null;
    if (type !== 'search') {
      videoId = extractVideoId(url);
      playlistId = extractPlaylistId(url);
    }
    // Retry with different keys if quota exceeded
    for(let attempt = 0; attempt < maxRetries; attempt++){
      try {
        const apiKey = getNextApiKey();
        // Determine what to fetch
        if (type === 'search') {
          videos = await fetchSearch(query, apiKey);
        } else if (type === 'auto' && playlistId || type === 'playlist') {
          if (!playlistId) {
            return new Response(JSON.stringify({
              error: 'Invalid playlist URL'
            }), {
              status: 400,
              headers: {
                ...corsHeaders,
                'Content-Type': 'application/json'
              }
            });
          }
          videos = await fetchPlaylist(playlistId, apiKey);
        } else if (type === 'auto' && videoId || type === 'video') {
          if (!videoId) {
            return new Response(JSON.stringify({
              error: 'Invalid video URL'
            }), {
              status: 400,
              headers: {
                ...corsHeaders,
                'Content-Type': 'application/json'
              }
            });
          }
          const video = await fetchVideo(videoId, apiKey);
          videos = video ? [
            video
          ] : [];
        } else {
          return new Response(JSON.stringify({
            error: 'Could not detect video or playlist ID from URL'
          }), {
            status: 400,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json'
            }
          });
        }
        break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        // If quota exceeded, try next key
        if (lastError.message.includes('Quota exceeded')) {
          console.log(`Quota exceeded on attempt ${attempt + 1}, trying next key...`);
          continue;
        }
        // Other errors - don't retry
        throw lastError;
      }
    }
    // If we exhausted all retries
    if (videos.length === 0 && lastError) {
      throw new Error(`All API keys exhausted: ${lastError.message}`);
    }

    return new Response(JSON.stringify({
      videos,
      count: videos.length
    }), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('YouTube scraper error:', error);
    return new Response(JSON.stringify({
      error: errorMessage
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
});
// Extract YouTube video ID from various URL formats
function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/
  ];
  for (const pattern of patterns){
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

// Extract YouTube playlist ID from URL
function extractPlaylistId(url: string): string | null {
  const patterns = [
    /[?&]list=([a-zA-Z0-9_-]+)/,
    /^PL[a-zA-Z0-9_-]+$/
  ];
  for (const pattern of patterns){
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

// Fetch single video metadata
async function fetchVideo(videoId: string, apiKey: string): Promise<Video | null> {
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,status&id=${videoId}&key=${apiKey}`;
  const response = await fetch(url);
  // Handle quota exceeded - mark key as failed and throw
  if (response.status === 403) {
    const errorData = await response.json();
    if (errorData.error?.errors?.[0]?.reason === 'quotaExceeded') {
      markKeyAsFailed(apiKey);
      throw new Error('Quota exceeded - key marked as failed');
    }
  }
  if (!response.ok) {
    throw new Error(`YouTube API error: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  if (!data.items || data.items.length === 0) {
    return null;
  }
  const item = data.items[0];
  return parseVideoItem(item);
}
// Fetch search results with embeddability filtering
async function fetchSearch(query: string, apiKey: string): Promise<Video[]> {
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&videoCategoryId=10&maxResults=10&key=${apiKey}`;
  const response = await fetch(url);
  // Handle quota exceeded - mark key as failed and throw
  if (response.status === 403) {
    const errorData = await response.json();
    if (errorData.error?.errors?.[0]?.reason === 'quotaExceeded') {
      markKeyAsFailed(apiKey);
      throw new Error('Quota exceeded - key marked as failed');
    }
  }
  if (!response.ok) {
    throw new Error(`YouTube API error: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();

  // Extract video IDs from search results
  const videoIds = data.items.map((item: any) => item.id.videoId).join(',');

  if (!videoIds) {
    return [];
  }

  // Fetch embeddability status for all videos at once
  const videosWithStatus = await fetchVideosBatch(videoIds, apiKey);

  // Build a map of video ID to embeddable status for quick lookup
  const embeddableMap = new Map<string, boolean>();
  videosWithStatus.forEach((video) => {
    embeddableMap.set(video.id, video.embeddable !== false);
  });

  // Map search results and filter out non-embeddable videos
  const videos = data.items
    .map((item: any) => {
      const snippet = item.snippet;
      const videoId = item.id.videoId;
      const isEmbeddable = embeddableMap.get(videoId) ?? true;

      // Extract artist from title (common format: "Artist - Title")
      const titleParts = snippet.title.split(' - ');
      const artist = titleParts.length > 1 ? titleParts[0].trim() : snippet.channelTitle;
      const title = titleParts.length > 1 ? titleParts.slice(1).join(' - ').trim() : snippet.title;

      return {
        id: videoId,
        title,
        artist,
        duration: 0, // Duration not available in search results (but will be in batch call)
        thumbnail: snippet.thumbnails?.high?.url || snippet.thumbnails?.default?.url || '',
        thumbnailUrl: snippet.thumbnails?.high?.url || snippet.thumbnails?.default?.url || '',
        url: `https://www.youtube.com/watch?v=${videoId}`,
        embeddable: isEmbeddable
      };
    })
    .filter((video: Video) => video.embeddable !== false);

  return videos;
}
// Fetch playlist metadata (all videos)
async function fetchPlaylist(playlistId: string, apiKey: string): Promise<Video[]> {
  const videos: Video[] = [];
  let pageToken: string | null = null;
  const maxResults = 50; // Max per request
  do {
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId=${playlistId}&maxResults=${maxResults}${pageToken ? `&pageToken=${pageToken}` : ''}&key=${apiKey}`;
    const response = await fetch(url);
    // Handle quota exceeded - mark key as failed and throw
    if (response.status === 403) {
      const errorData = await response.json();
      if (errorData.error?.errors?.[0]?.reason === 'quotaExceeded') {
        markKeyAsFailed(apiKey);
        throw new Error('Quota exceeded - key marked as failed');
      }
    }
    if (!response.ok) {
      throw new Error(`YouTube API error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    // Fetch full video details for durations (playlistItems doesn't include duration)
    const videoIds = data.items.map((item)=>item.contentDetails.videoId).join(',');
    const videosData = await fetchVideosBatch(videoIds, apiKey);
    videos.push(...videosData);
    pageToken = data.nextPageToken || null;
  }while (pageToken)
  return videos;
}
// Fetch multiple videos in batch
async function fetchVideosBatch(videoIds: string, apiKey: string): Promise<Video[]> {
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,status&id=${videoIds}&key=${apiKey}`;
  const response = await fetch(url);
  // Handle quota exceeded - mark key as failed and throw
  if (response.status === 403) {
    const errorData = await response.json();
    if (errorData.error?.errors?.[0]?.reason === 'quotaExceeded') {
      markKeyAsFailed(apiKey);
      throw new Error('Quota exceeded - key marked as failed');
    }
  }
  if (!response.ok) {
    throw new Error(`YouTube API error: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  return data.items.map((item: unknown) => parseVideoItem(item));
}

// Parse YouTube API video item into our format
function parseVideoItem(item: unknown): Video {
  const typedItem = item as {
    id: string;
    snippet: { title: string; channelTitle: string; thumbnails?: Record<string, { url: string }> };
    contentDetails?: { duration: string };
    status?: { embeddable?: boolean };
  };
  const snippet = typedItem.snippet;
  const contentDetails = typedItem.contentDetails;
  const status = typedItem.status;
  // Parse ISO 8601 duration (PT4M13S -> 253 seconds)
  const duration = contentDetails?.duration ? parseDuration(contentDetails.duration) : 0;
  // Extract artist from title (common format: "Artist - Title")
  const titleParts = snippet.title.split(' - ');
  const artist = titleParts.length > 1 ? titleParts[0].trim() : snippet.channelTitle;
  const title = titleParts.length > 1 ? titleParts.slice(1).join(' - ').trim() : snippet.title;
  return {
    id: typedItem.id,
    title,
    artist,
    duration,
    thumbnail: snippet.thumbnails?.high?.url || snippet.thumbnails?.default?.url || '',
    url: `https://www.youtube.com/watch?v=${typedItem.id}`,
    embeddable: status?.embeddable ?? true  // Default to true if not specified
  };
}
// Parse ISO 8601 duration to seconds
function parseDuration(duration: string): number {
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const hours = parseInt(match[1] || '0', 10);
  const minutes = parseInt(match[2] || '0', 10);
  const seconds = parseInt(match[3] || '0', 10);
  return hours * 3600 + minutes * 60 + seconds;
}
