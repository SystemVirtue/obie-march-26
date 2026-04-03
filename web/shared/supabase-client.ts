// Shared Supabase Client and Types
// Used by all three frontend apps

import { createClient, SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';

// =============================================================================
// TYPES
// =============================================================================

export interface Player {
  id: string;
  name: string;
  display_name?: string | null;
  jukebox_slug?: string | null;
  status: 'offline' | 'online' | 'error';
  last_heartbeat: string;
  active_playlist_id: string | null;
  priority_player_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface JukeboxSummary {
  player_id: string;
  jukebox_slug: string;
  display_name: string;
  role: 'owner' | 'admin' | 'operator' | 'viewer';
  is_owner: boolean;
}

export interface Playlist {
  id: string;
  player_id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface PlaylistItem {
  id: string;
  playlist_id: string;
  position: number;
  media_item_id: string;
  added_at: string;
}

export interface MediaItem {
  id: string;
  source_id: string;
  source_type: string;
  title: string;
  artist: string | null;
  url: string;
  duration: number | null;
  thumbnail: string | null;
  fetched_at: string;
  metadata: Record<string, any>;
}

export interface QueueItem {
  id: string;
  player_id: string;
  type: 'normal' | 'priority';
  media_item_id: string;
  position: number;
  requested_by: string | null;
  requested_at: string;
  played_at: string | null;
  expires_at: string;
  media_item?: MediaItem; // Joined data
}

export interface PlayerStatus {
  player_id: string;
  state: 'idle' | 'playing' | 'paused' | 'error' | 'loading';
  progress: number;
  current_media_id: string | null;
  now_playing_index: number;
  queue_head_position: number;
  last_updated: string;
  current_media?: MediaItem; // Joined data
  /** 'youtube' = normal iframe mode (default); 'local' = yt-dlp download; 'cloudflare' = R2 bucket */
  source?: 'youtube' | 'local' | 'cloudflare';
  /** Public URL for non-YouTube playback (yt-dlp download or Cloudflare R2 video) */
  local_url?: string | null;
}

export interface PlayerSettings {
  player_id: string;
  loop: boolean;
  shuffle: boolean;
  volume: number;
  freeplay: boolean;
  karaoke_mode?: boolean;
  coin_per_song: number;
  branding: {
    name: string;
    logo: string;
    theme: string;
  };
  search_enabled: boolean;
  max_queue_size: number;
  priority_queue_limit: number;
  kiosk_coin_acceptor_enabled?: boolean;
  kiosk_coin_acceptor_connected?: boolean;
  kiosk_coin_acceptor_device_id?: string | null;
  kiosk_show_virtual_coin_button?: boolean;
  coin_credits_dollar1?: number;
  coin_credits_dollar2?: number;
  player_mode?: 'iframe' | 'ytm_desktop';
  cloudflare_enabled?: boolean;
  cloudflare_r2_public_url?: string | null;
}

export interface KioskSession {
  session_id: string;
  player_id: string;
  credits: number;
  last_active: string;
  created_at: string;
  ip_address: string | null;
  user_agent: string | null;
}

export interface SystemLog {
  id: number;
  player_id: string | null;
  event: string;
  severity: 'debug' | 'info' | 'warn' | 'error';
  payload: Record<string, any>;
  timestamp: string;
}

export interface R2File {
  id: string;
  bucket_name: string;
  object_key: string;
  file_name: string;
  content_type: string | null;
  size_bytes: number | null;
  etag: string | null;
  last_modified: string | null;
  public_url: string;
  title: string | null;
  artist: string | null;
  duration: number | null;
  thumbnail: string | null;
  tags: string[] | null;
  synced_at: string;
  created_at: string;
}

export interface Database {
  public: {
    Tables: {
      players: { Row: Player };
      player_memberships: {
        Row: {
          player_id: string;
          user_id: string;
          role: 'owner' | 'admin' | 'operator' | 'viewer';
          created_at: string;
          updated_at: string;
        };
      };
      playlists: { Row: Playlist };
      playlist_items: { Row: PlaylistItem };
      media_items: { Row: MediaItem };
      queue: { Row: QueueItem };
      player_status: { Row: PlayerStatus };
      player_settings: { Row: PlayerSettings; Update: Partial<PlayerSettings> };
      kiosk_sessions: { Row: KioskSession };
      system_logs: { Row: SystemLog };
      r2_files: { Row: R2File };
    };
  };
}

// =============================================================================
// CLIENT INITIALIZATION
// =============================================================================

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export const supabase: SupabaseClient<Database> = createClient(supabaseUrl, supabaseAnonKey);

// supabase-js v2 only calls setAuth() on the internal functions/realtime clients
// for SIGNED_IN and TOKEN_REFRESHED events — NOT for INITIAL_SESSION (the event
// that fires when the session is restored from localStorage on page load).
// This patch closes that gap so functions.invoke() always sends the user JWT
// rather than falling back to the anon key until the first token refresh.
supabase.auth.onAuthStateChange((event, session) => {
  const token = session?.access_token;
  if (
    (event === 'INITIAL_SESSION' ||
      event === 'SIGNED_IN' ||
      event === 'TOKEN_REFRESHED' ||
      event === 'USER_UPDATED') &&
    token
  ) {
    supabase.functions.setAuth(token);
  } else if (event === 'SIGNED_OUT') {
    supabase.functions.setAuth(supabaseAnonKey);
  }
});

// =============================================================================
// REALTIME HELPERS
// =============================================================================

// @ts-ignore - T is used in the interface definition
export interface RealtimeSubscription<T = any> {
  channel: RealtimeChannel;
  unsubscribe: () => void;
}

async function getEdgeFunctionAuthToken(preferSession = true): Promise<string> {
  if (preferSession) {
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (token) return token;
    } catch {
      // Fall back to the anon key when there is no session yet.
    }
  }

  return supabaseAnonKey;
}

async function invokeEdgeFunction<TResponse = any>(
  functionName: string,
  body: unknown,
  options?: { preferSession?: boolean }
): Promise<TResponse> {
  const preferSession = options?.preferSession ?? true;

  const callWithToken = async (token: string) => {
    const response = await fetch(`${supabaseUrl}/functions/v1/${functionName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseAnonKey,
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    const responseText = await response.text();
    let payload: any = null;

    if (responseText) {
      try {
        payload = JSON.parse(responseText);
      } catch {
        payload = responseText;
      }
    }

    return { response, responseText, payload };
  };

  const firstToken = await getEdgeFunctionAuthToken(preferSession);
  let { response, responseText, payload } = await callWithToken(firstToken);

  const firstMessage = typeof payload === 'object' && payload
    ? payload.error || payload.message || JSON.stringify(payload)
    : responseText || `HTTP ${response.status}: ${response.statusText}`;

  // Some deployed functions reject user session JWTs (e.g. ES256 tokens)
  // but still accept project anon JWTs. Retry once with anon to avoid false failures.
  if (
    preferSession &&
    !response.ok &&
    (response.status === 401 || /invalid jwt/i.test(String(firstMessage))) &&
    firstToken !== supabaseAnonKey
  ) {
    ({ response, responseText, payload } = await callWithToken(supabaseAnonKey));
  }

  if (!response.ok) {
    const message = typeof payload === 'object' && payload
      ? payload.error || payload.message || JSON.stringify(payload)
      : responseText || `HTTP ${response.status}: ${response.statusText}`;
    throw new Error(message);
  }

  return payload as TResponse;
}

/**
 * Subscribe to real-time changes on a table
 */
export function subscribeToTable<T = any>(
  table: string,
  filter: { column?: string; value?: any } | null,
  callback: (payload: { eventType: 'INSERT' | 'UPDATE' | 'DELETE'; new: T; old: T }) => void
): RealtimeSubscription<T> {
  const channelName = filter?.column && filter?.value
    ? `${table}:${filter.column}=eq.${filter.value}`
    : `${table}:*`;

  const channel = supabase.channel(channelName);

  channel
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table,
        ...(filter?.column && filter?.value ? { filter: `${filter.column}=eq.${filter.value}` } : {})
      },
      (payload: any) => {
        callback({
          eventType: payload.eventType,
          new: payload.new as T,
          old: payload.old as T
        });
      }
    )
    .subscribe();

  return {
    channel,
    unsubscribe: () => {
      supabase.removeChannel(channel);
    }
  };
}

/**
 * Subscribe to player status updates.
 * Uses the Realtime payload directly for progress/state updates,
 * only refetching with media_items join when current_media_id changes.
 * Debounces media refetches to coalesce rapid skip bursts.
 */
export function subscribeToPlayerStatus(
  playerId: string,
  callback: (status: PlayerStatus) => void
): RealtimeSubscription<PlayerStatus> {
  let lastStatus: PlayerStatus | null = null;
  let lastMediaId: string | null = null;
  let mediaRefetchTimeout: ReturnType<typeof setTimeout> | null = null;

  const fetchFullStatus = async () => {
    try {
      const { data, error } = await supabase
        .from('player_status')
        .select('*, current_media:media_items(*)')
        .eq('player_id', playerId)
        .single();
      if (error) {
        console.error('[subscribeToPlayerStatus] Fetch error:', error);
        return;
      }
      if (data) {
        lastStatus = data as PlayerStatus;
        lastMediaId = lastStatus.current_media_id;
        callback(lastStatus);
      }
    } catch (err) {
      console.error('[subscribeToPlayerStatus] Fetch failed:', err);
    }
  };

  // Fetch initial status with media_item join
  fetchFullStatus();

  return subscribeToTable<PlayerStatus>(
    'player_status',
    { column: 'player_id', value: playerId },
    (payload) => {
      if (payload.eventType === 'UPDATE' || payload.eventType === 'INSERT') {
        const newRow = payload.new;
        const mediaChanged = newRow.current_media_id !== lastMediaId;

        if (mediaChanged) {
          // Media changed — need to fetch the joined media_items row.
          // Debounce to coalesce rapid media changes (e.g. skip bursts).
          lastMediaId = newRow.current_media_id;
          if (mediaRefetchTimeout) clearTimeout(mediaRefetchTimeout);
          mediaRefetchTimeout = setTimeout(() => {
            fetchFullStatus();
          }, 500);
        } else if (lastStatus) {
          // Progress/state only — merge Realtime payload, skip refetch
          lastStatus = { ...lastStatus, ...newRow };
          callback(lastStatus);
        } else {
          // No cached status yet — do a full fetch
          fetchFullStatus();
        }
      }
    }
  );
}

/**
 * Subscribe to queue updates
 */
export function subscribeToQueue(
  playerId: string,
  callback: (items: QueueItem[]) => void
): RealtimeSubscription<QueueItem> {
  let refetchTimeout: ReturnType<typeof setTimeout> | null = null;
  
  const fetchQueue = async () => {
    try {
      console.log('[subscribeToQueue] 🔄 Fetching queue from database...');
      const { data, error } = await supabase
        .from('queue')
        .select('id, player_id, type, media_item_id, position, requested_by, requested_at, played_at, expires_at, media_item:media_items(*)')
        .eq('player_id', playerId)
        .is('played_at', null)
        .order('type', { ascending: false })
        .order('position', { ascending: true });
      if (error) {
        console.error('[subscribeToQueue] ❌ Database error:', error);
        return;
      }
      console.log('[subscribeToQueue] 📊 Fetched', data?.length || 0, 'items from database');
      if (data) {
        callback(data as QueueItem[]);
      }
    } catch (err) {
      console.error('[subscribeToQueue] ❌ Fetch failed:', err);
    }
  };

  // Fetch initial queue
  fetchQueue();

  // Subscribe to changes
  return subscribeToTable<QueueItem>(
    'queue',
    { column: 'player_id', value: playerId },
    () => {
      // Debounce refetch to allow database updates to complete
      console.log('[subscribeToQueue] Change detected, scheduling refetch in 800ms...');
      if (refetchTimeout) clearTimeout(refetchTimeout);
      refetchTimeout = setTimeout(() => {
        fetchQueue();
      }, 800); // Increased to 800ms to ensure all position updates complete
    }
  );
}

/**
 * Subscribe to player settings
 */
export function subscribeToPlayerSettings(
  playerId: string,
  callback: (settings: PlayerSettings) => void
): RealtimeSubscription<PlayerSettings> {
  // Fetch initial settings
  (async () => {
    try {
      const { data } = await supabase
        .from('player_settings')
        .select('*')
        .eq('player_id', playerId)
        .single();
      if (data) callback(data);
    } catch (err) {
      console.error('[subscribeToPlayerSettings] ❌ Initial fetch failed:', err);
    }
  })();

  return subscribeToTable<PlayerSettings>(
    'player_settings',
    { column: 'player_id', value: playerId },
    (payload) => {
      if (payload.eventType === 'UPDATE' || payload.eventType === 'INSERT') {
        callback(payload.new);
      }
    }
  );
}

/**
 * Subscribe to kiosk session
 */
export function subscribeToKioskSession(
  sessionId: string,
  callback: (session: KioskSession) => void
): RealtimeSubscription<KioskSession> {
  // Fetch initial session
  (async () => {
    try {
      const { data } = await supabase
        .from('kiosk_sessions')
        .select('*')
        .eq('session_id', sessionId)
        .single();
      if (data) callback(data);
    } catch (err) {
      console.error('[subscribeToKioskSession] ❌ Initial fetch failed:', err);
    }
  })();

  return subscribeToTable<KioskSession>(
    'kiosk_sessions',
    { column: 'session_id', value: sessionId },
    (payload) => {
      if (payload.eventType === 'UPDATE' || payload.eventType === 'INSERT') {
        callback(payload.new);
      }
    }
  );
}

/**
 * Subscribe to system logs
 */
export function subscribeToSystemLogs(
  playerId: string,
  callback: (log: SystemLog) => void
): RealtimeSubscription<SystemLog> {
  return subscribeToTable<SystemLog>(
    'system_logs',
    { column: 'player_id', value: playerId },
    (payload) => {
      if (payload.eventType === 'INSERT') {
        callback(payload.new);
      }
    }
  );
}

// =============================================================================
// POLLING + BROADCAST (replaces high-churn Realtime DB subscriptions)
// =============================================================================

/**
 * Poll player_status at a regular interval instead of using a Realtime
 * postgres_changes subscription.  Eliminates the subscription row churn in
 * realtime.subscription and reduces WAL decoder load.
 */
export function pollPlayerStatus(
  playerId: string,
  callback: (status: PlayerStatus) => void,
  intervalMs = 3000
): { unsubscribe: () => void } {
  const fetchStatus = async () => {
    const { data, error } = await supabase
      .from('player_status')
      .select('*, current_media:media_items(*)')
      .eq('player_id', playerId)
      .single();
    if (!error && data) callback(data as any);
  };

  fetchStatus();
  const id = setInterval(fetchStatus, intervalMs);
  return { unsubscribe: () => clearInterval(id) };
}

/**
 * Subscribe to a player's broadcast channel for real-time progress events.
 * Use alongside pollPlayerStatus — broadcast carries frequent progress updates
 * without touching the database or WAL.
 */
export function subscribeToPlayerBroadcast(
  playerId: string,
  onProgress: (data: { progress: number; state: PlayerStatus['state'] }) => void
): RealtimeChannel {
  const channel = supabase
    .channel(`player-broadcast:${playerId}`)
    .on('broadcast', { event: 'progress' }, ({ payload }) => {
      onProgress(payload as { progress: number; state: PlayerStatus['state'] });
    })
    .subscribe();
  return channel;
}

// =============================================================================
// API HELPERS
// =============================================================================

/**
 * Call queue manager edge function
 */
export async function callQueueManager(params: {
  player_id: string;
  action: 'add' | 'remove' | 'reorder' | 'next' | 'skip' | 'clear' | 'shuffle';
  media_item_id?: string;
  queue_id?: string;
  queue_ids?: string[];
  type?: 'normal' | 'priority';
  requested_by?: string;
}) {
  // For very large reorders, call the RPC directly to avoid sending a huge
  // payload through the Edge Function and to allow the client to use the
  // database RPC which accepts uuid[] more directly. This matches the
  // optimized behavior used in the compiled app bundle.
  try {
    if (params.action === 'reorder' && Array.isArray(params.queue_ids) && params.queue_ids.length > 50) {
      // Call the unambiguous wrapper RPC to avoid overload resolution issues
      const { error } = await supabase.rpc('queue_reorder_wrapper', {
        p_player_id: params.player_id,
        p_queue_ids: params.queue_ids,
        p_type: params.type || 'normal'
      } as any);
      if (error) throw error;
      return { success: true } as any;
    }

    return await invokeEdgeFunction('queue-manager', params, { preferSession: false });
  } catch (err: any) {
    // If the caught error is a Postgres error object, normalize it so UI logs
    // show readable information (code/message/detail).
    if (err && typeof err === 'object' && (err.message || err.code)) {
      throw new Error(err.message || `db_error:${err.code || JSON.stringify(err)}`);
    }
    throw err;
  }
}

/**
 * Call player control edge function
 */
export async function callPlayerControl(params: {
  player_id: string;
  state?: 'idle' | 'playing' | 'paused' | 'error' | 'loading';
  progress?: number;
  action?: 'heartbeat' | 'update' | 'ended' | 'skip' | 'register_session' | 'reset_priority';
  session_id?: string;
  stored_player_id?: string;
  current_media_id?: string;
}) {
  return await invokeEdgeFunction('player-control', params, { preferSession: false });
}

/**
 * Trigger a yt-dlp download via the local companion service.
 *
 * Calls the download-service.mjs Node.js process running on localhost:3742
 * (hosted Supabase Edge Functions cannot shell out to yt-dlp).
 * The service downloads the video, uploads to Storage, and flips
 * player_status to source='local'.  The Player's Realtime subscription
 * then switches from the iframe to a native <video> element.
 *
 * Start the service:  node scripts/download-service.mjs
 */
export async function callDownloadVideo(params: {
  videoId: string;
  player_id?: string;
}): Promise<{ success: boolean; publicUrl?: string }> {
  const res = await fetch('http://127.0.0.1:3742/download', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(params),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(err.error ?? `Download service returned HTTP ${res.status}`);
  }

  return res.json() as Promise<{ success: boolean; publicUrl?: string }>;
}

/**
 * Call kiosk handler edge function
 */
export async function callKioskHandler(params: {
  session_id?: string;
  player_id?: string;
  action: 'init' | 'heartbeat' | 'search' | 'credit' | 'request' | 'check' | 'search_r2' | 'request_r2' | 'admin_request';
  query?: string;
  media_item_id?: string;
  amount?: number;
  url?: string;
  r2_file_id?: string;
  add_to_queue?: boolean;
  // Pre-scraped metadata for admin_request (skips youtube-scraper call)
  title?: string;
  artist?: string;
  thumbnail?: string;
  duration?: number;
}) {
  try {
    if (!supabaseAnonKey) {
      throw new Error('Missing VITE_SUPABASE_ANON_KEY for kiosk-handler call');
    }
    // Call Edge Function directly to bypass authentication requirements for public kiosk
    const response = await fetch(`${supabaseUrl}/functions/v1/kiosk-handler`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseAnonKey,
        'Authorization': `Bearer ${supabaseAnonKey}`,
      },
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
      try {
        const errorData = JSON.parse(errorText);
        errorMessage = errorData.error || errorData.message || errorMessage;
      } catch {
        errorMessage = errorText || errorMessage;
      }
      throw new Error(errorMessage);
    }

    const data = await response.json();
    return data;
  } catch (err: any) {
    throw err;
  }
}

/**
 * Call playlist-manager Edge Function
 */
export async function callPlaylistManager(params: {
  action: 'create' | 'update' | 'delete' | 'add_item' | 'remove_item' | 'reorder' | 'scrape' | 'set_active' | 'clear_queue' | 'import_queue' | 'load_playlist' | 'remove_media_globally' | 'sync_channel';
  player_id?: string;
  playlist_id?: string;
  name?: string;
  description?: string;
  media_item_id?: string;
  item_ids?: string[];
  url?: string;
  current_index?: number;
  channel_id?: string;
  replace_existing?: boolean;
}) {
  // Playlist manager deployment currently rejects user session JWTs and accepts
  // project anon JWTs. Use anon auth directly to avoid a noisy 401->retry cycle.
  return await invokeEdgeFunction('playlist-manager', params, { preferSession: false });
}

export async function callYouTubeScraper(params: { url: string }) {
  return await invokeEdgeFunction('youtube-scraper', params, { preferSession: false });
}

export async function callRadioGenerator(params: {
  player_id: string;
  action: 'generate';
  source: 'now_playing' | 'history' | 'playlist';
}) {
  return await invokeEdgeFunction('radio-generator', params, { preferSession: false });
}

/**
 * Initialize player with default playlist and start auto-play
 */
export async function initializePlayerPlaylist(playerId: string) {
  const { data, error } = await supabase.rpc('initialize_player_playlist', {
    p_player_id: playerId
  } as any);

  if (error) throw error;
  return data?.[0] || null;
}

/**
 * Load a specific playlist into the player queue
 */
export async function loadPlaylist(playerId: string, playlistId: string, startIndex: number = 0) {
  const { data, error } = await supabase.rpc('load_playlist', {
    p_player_id: playerId,
    p_playlist_id: playlistId,
    p_start_index: startIndex
  } as any);

  if (error) throw error;
  return data?.[0] || null;
}

/**
 * Get default playlist for a player
 */
export async function getDefaultPlaylist(playerId: string) {
  const { data, error } = await supabase.rpc('get_default_playlist', {
    p_player_id: playerId
  } as any);

  if (error) throw error;
  return data?.[0] || null;
}

// =============================================================================
// DIRECT DATABASE QUERIES (for read-heavy operations)
// =============================================================================

/**
 * Get player by ID
 */
export async function getPlayer(playerId: string): Promise<Player | null> {
  const { data, error } = await supabase
    .from('players')
    .select('*')
    .eq('id', playerId)
    .single();

  if (error) throw error;
  return data;
}

/**
 * Batch-fetch multiple player records by ID (for multi-player Connected Devices view)
 */
export async function getPlayersByIds(playerIds: string[]): Promise<Player[]> {
  if (!playerIds.length) return [];
  const { data, error } = await supabase
    .from('players')
    .select('*')
    .in('id', playerIds);
  if (error) throw error;
  return (data ?? []) as Player[];
}

/**
 * Subscribe to real-time changes on a player record
 */
export function subscribeToPlayer(
  playerId: string,
  callback: (player: Player) => void
): RealtimeSubscription<Player> {
  supabase
    .from('players')
    .select('*')
    .eq('id', playerId)
    .single()
    .then(({ data }) => { if (data) callback(data as Player); });

  return subscribeToTable<Player>(
    'players',
    { column: 'id', value: playerId },
    (payload) => {
      if (payload.eventType === 'UPDATE' || payload.eventType === 'INSERT') {
        callback(payload.new);
      }
    }
  );
}

/**
 * Get kiosk sessions for a player (last 24 hours)
 */
export async function getKioskSessions(playerId: string): Promise<KioskSession[]> {
  // 5-minute window: with a 30-second heartbeat, a closed kiosk goes stale within ~90 s
  // (Offline threshold) and drops off this list within 5 min.
  const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('kiosk_sessions')
    .select('*')
    .eq('player_id', playerId)
    .gte('last_active', since)
    .order('last_active', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

/**
 * Get a single playlist by ID
 */
export async function getPlaylistById(playlistId: string): Promise<Playlist | null> {
  const { data, error } = await supabase
    .from('playlists')
    .select('*')
    .eq('id', playlistId)
    .single();
  if (error) return null;
  return data as Playlist;
}

/**
 * Get all playlists for a player
 */
export async function getPlaylists(playerId: string): Promise<Playlist[]> {
  // Prefer the aggregated view that includes item counts when available.
  // Fallback to the raw playlists table if the view does not exist.
  const viewSelect = '*, item_count';
  const { data, error } = await supabase
    .from('playlists_with_counts')
    .select(viewSelect)
    .eq('player_id', playerId)
    .order('created_at', { ascending: false });

  if (!error && data) {
    // Map view rows to Playlist shape while exposing item_count via casting below where needed
    return (data as any).map((row: any) => ({
      id: row.id,
      player_id: row.player_id,
      name: row.name,
      description: row.description,
      is_active: row.is_active,
      created_at: row.created_at,
      updated_at: row.updated_at,
      // item_count is available on the row if callers want it
      item_count: row.item_count,
    })) as any;
  }

  // Fallback: query playlists and return without counts
  const { data: rawData, error: rawErr } = await supabase
    .from('playlists')
    .select('*')
    .eq('player_id', playerId)
    .order('created_at', { ascending: false });

  if (rawErr) throw rawErr;
  return rawData || [];
}

/**
 * Get playlist items with media details
 */
export type PlaylistManagerAction = 'create' | 'update' | 'delete' | 'add_item' | 'remove_item' | 'reorder' | 'scrape' | 'set_active';

export async function getPlaylistItems(playlistId: string): Promise<(PlaylistItem & { media_item?: MediaItem })[]> {
  // Use a two-step fetch to avoid runtime PostgREST relationship cache issues
  const { data: items, error: itemsError } = await supabase
    .from('playlist_items')
    .select('*')
    .eq('playlist_id', playlistId)
    .order('position', { ascending: true });

  if (itemsError) {
    // If the error indicates a missing foreign key relationship, fall back to the two-step approach
    console.error('[getPlaylistItems] Initial fetch failed, error:', itemsError);
    throw itemsError;
  }

  const itemRows = (items || []) as PlaylistItem[];
  const mediaIds = Array.from(new Set(itemRows.map((i) => i.media_item_id).filter(Boolean)));

  if (mediaIds.length === 0) return itemRows as any;

  const { data: mediaRows, error: mediaError } = await supabase
    .from('media_items')
    .select('*')
    .in('id', mediaIds);

  if (mediaError) {
    console.error('[getPlaylistItems] Failed to fetch media_items:', mediaError);
    throw mediaError;
  }

  const mediaMap = new Map<string, MediaItem>();
  (mediaRows || []).forEach((m: any) => mediaMap.set(m.id, m));

  return itemRows.map((it) => ({
    ...it,
    media_item: mediaMap.get(it.media_item_id) as any,
  })) as any;
}

/**
 * Get queue items with media details
 */
export async function getQueue(playerId: string): Promise<QueueItem[]> {
  const { data, error } = await supabase
    .from('queue')
    .select('*, media_item:media_items(*)')
    .eq('player_id', playerId)
    .is('played_at', null)
    .order('type', { ascending: false })
    .order('position', { ascending: true });

  if (error) throw error;
  return data as any || [];
}

/**
 * Get total credits across all kiosk sessions for a player
 */
export async function getTotalCredits(playerId: string): Promise<number> {
  const { data, error } = await supabase
    .from('kiosk_sessions')
    .select('credits')
    .eq('player_id', playerId);

  if (error) throw error;
  return (data as { credits: number }[])?.reduce((sum, session) => sum + session.credits, 0) || 0;
}

/**
 * Update credits across all kiosk sessions for a player
 */
export async function updateAllCredits(playerId: string, action: 'clear' | 'add', amount?: number): Promise<void> {
  if (action === 'clear') {
    // Fetch previous total for logging
    const prevTotal = await getTotalCredits(playerId).catch(() => 0);

    // Set credits to 0 for all sessions belonging to this player
    const { error } = await (supabase as any)
      .from('kiosk_sessions')
      .update({ credits: 0 })
      .eq('player_id', playerId);

    if (error) throw error;

    // Log the clear action
    await supabase.from('system_logs' as any).insert({
      player_id: playerId,
      event: 'credit_clear',
      severity: 'info',
      payload: { source: 'admin', action: 'clear', previous_balance: prevTotal },
    } as any).then(() => {}, console.error);
  } else if (action === 'add' && amount) {
    // Add credits to the most-recently-active kiosk session for this player.
    // Admin +1/+3 buttons are expected to increment the visible total by a small amount,
    // so updating a single recent session prevents accidentally adding N times (one per session).
    const { data: sessions, error: fetchError } = await (supabase as any)
      .from('kiosk_sessions')
      .select('session_id, credits')
      .eq('player_id', playerId)
      .order('last_active', { ascending: false })
      .limit(1);

    if (fetchError) throw fetchError;

    if (sessions && sessions.length > 0) {
      const s = sessions[0];
      const newCredits = (s.credits || 0) + amount;
      const { error } = await (supabase as any)
        .from('kiosk_sessions')
        .update({ credits: newCredits })
        .eq('session_id', s.session_id);

      if (error) throw error;

      // Log the admin credit add
      await supabase.from('system_logs' as any).insert({
        player_id: playerId,
        event: 'credit_deposit',
        severity: 'info',
        payload: { source: 'admin', amount, action: 'add', new_balance: newCredits },
      } as any).then(() => {}, console.error);
    } else {
      // If there are no sessions, nothing to update
      return;
    }
  }
}

// =============================================================================
// AUTHENTICATION HELPERS
// =============================================================================

export interface AuthUser {
  id: string;
  email: string;
  role?: string;
}

/**
 * Sign up with email and password.
 * Supabase will send a confirmation email automatically.
 * The on_auth_user_created trigger provisions a player instance on first sign-in.
 */
export async function signUp(email: string, password: string) {
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
  return data;
}

/**
 * Send a one-time-code (OTP / magic link) to the given email.
 * Call verifyOtp() with the 6-digit code the user receives.
 */
export async function sendOtp(email: string) {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: true }, // auto-creates account if new
  });
  if (error) throw error;
}

/**
 * Verify a 6-digit OTP sent via sendOtp().
 */
export async function verifyOtp(email: string, token: string) {
  const { data, error } = await supabase.auth.verifyOtp({
    email,
    token,
    type: 'email',
  });
  if (error) throw error;
  return data;
}

/**
 * Sign in with email and password
 */
export async function signIn(email: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) throw error;
  return data;
}

/**
 * Resolve the current user's player_id via the get_my_player_id() RPC.
 * Returns null if the user has no player yet (race between trigger and first request).
 */
export async function getUserPlayerId(): Promise<string | null> {
  const { data, error } = await supabase.rpc('get_my_player_id' as any);
  if (error) {
    console.warn('[getUserPlayerId] RPC error, falling back to get_my_jukeboxes:', error);
    const jukeboxes = await getMyJukeboxes();
    return jukeboxes[0]?.player_id ?? null;
  }
  return (data as string) ?? null;
}

/**
 * Return all jukeboxes the signed-in user can access.
 */
export async function getMyJukeboxes(): Promise<JukeboxSummary[]> {
  const { data, error } = await supabase.rpc('get_my_jukeboxes' as any);
  if (error) throw error;
  return ((data as JukeboxSummary[] | null) ?? []).map((row) => ({
    ...row,
    jukebox_slug: String(row.jukebox_slug || '').toUpperCase(),
    display_name: row.display_name || row.jukebox_slug,
  }));
}

/**
 * Create a new jukebox owned by the current user.
 */
export async function createJukebox(slug: string, displayName?: string): Promise<JukeboxSummary> {
  const normalizedSlug = slug.trim().toUpperCase();
  const { data, error } = await supabase.rpc('create_jukebox' as any, {
    p_slug: normalizedSlug,
    p_display_name: displayName?.trim() || null,
  } as any);
  if (error) throw error;

  const row = (Array.isArray(data) ? data[0] : data) as {
    player_id: string;
    jukebox_slug: string;
    display_name: string | null;
  } | null;
  if (!row?.player_id) {
    throw new Error('create_jukebox returned no player_id');
  }

  return {
    player_id: row.player_id,
    jukebox_slug: row.jukebox_slug,
    display_name: row.display_name || row.jukebox_slug,
    role: 'owner',
    is_owner: true,
  };
}

/**
 * Resolve a public jukebox slug to internal player_id.
 * Available to anon/authenticated callers.
 */
export async function resolveJukeboxSlug(slug: string): Promise<{ player_id: string; jukebox_slug: string; display_name: string } | null> {
  const normalizedSlug = slug.trim().toUpperCase();
  if (!normalizedSlug) return null;

  const { data, error } = await supabase.rpc('resolve_jukebox_slug' as any, {
    p_slug: normalizedSlug,
  } as any);
  if (error) throw error;

  const row = (Array.isArray(data) ? data[0] : data) as {
    player_id: string;
    jukebox_slug: string;
    display_name: string | null;
  } | null;
  if (!row?.player_id) return null;

  return {
    player_id: row.player_id,
    jukebox_slug: row.jukebox_slug,
    display_name: row.display_name || row.jukebox_slug,
  };
}

/**
 * Sign out
 */
export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

/**
 * Get current user
 */
export async function getCurrentUser(): Promise<AuthUser | null> {
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error) {
    // Expected on first load before sign-in; treat as logged out state.
    if (error.name === 'AuthSessionMissingError' || /auth session missing/i.test(error.message || '')) {
      return null;
    }
    throw error;
  }
  if (!user) return null;

  return {
    id: user.id,
    email: user.email || '',
    role: user.user_metadata?.role || user.app_metadata?.role,
  };
}

/**
 * Subscribe to auth state changes
 */
export function subscribeToAuth(callback: (user: AuthUser | null) => void): { unsubscribe: () => void } {
  const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
    if (session?.user) {
      const user: AuthUser = {
        id: session.user.id,
        email: session.user.email || '',
        role: session.user.user_metadata?.role || session.user.app_metadata?.role,
      };
      callback(user);
    } else {
      callback(null);
    }
  });

  return {
    unsubscribe: () => subscription.unsubscribe(),
  };
}

// ─── App Version Auto-Reload ──────────────────────────────────────────────────

/**
 * Subscribe to app_config version changes via Realtime.
 * On first connect, reads the current version from the DB.
 * When a newer version is detected, calls `onVersionChange` with the new version.
 * Typical usage: call window.location.reload() in the callback.
 */
export function subscribeToAppVersion(onVersionChange: (newVersion: string) => void): { unsubscribe: () => void } {
  let loadedVersion: string | null = null;

  // Read initial version
  (async () => {
    try {
      const { data } = await supabase
        .from('app_config')
        .select('value')
        .eq('key', 'app_version')
        .maybeSingle();
      if (data && (data as any).value) {
        loadedVersion = (data as any).value;
        console.log(`[AppVersion] Loaded version: ${loadedVersion}`);
      }
    } catch (err) {
      console.error('[AppVersion] ❌ Initial fetch failed:', err);
    }
  })();

  // Subscribe to changes
  const channel = supabase.channel('app_config:app_version');
  channel
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'app_config',
        filter: 'key=eq.app_version',
      },
      (payload: any) => {
        const newVersion = payload.new?.value;
        if (newVersion && loadedVersion && newVersion !== loadedVersion) {
          console.log(`[AppVersion] Version changed: ${loadedVersion} → ${newVersion}`);
          onVersionChange(newVersion);
        }
      }
    )
    .subscribe();

  return {
    unsubscribe: () => supabase.removeChannel(channel),
  };
}
