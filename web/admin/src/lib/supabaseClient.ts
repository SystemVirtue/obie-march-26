// Shared Supabase Client and Types
// Used by all three frontend apps

import { createClient, SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';

// =============================================================================
// TYPES
// =============================================================================

export interface Player {
  id: string;
  name: string;
  status: 'offline' | 'online' | 'error';
  last_heartbeat: string;
  active_playlist_id: string | null;
  created_at: string;
  updated_at: string;
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
  media_item_id: string;
  position: number;
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
  local_media_enabled?: boolean;
  local_media_path?: string | null;
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

export interface Database {
  public: {
    Tables: {
      players: { Row: Player };
      playlists: { Row: Playlist };
      playlist_items: { Row: PlaylistItem };
      media_items: { Row: MediaItem };
      queue: { Row: QueueItem };
      player_status: { Row: PlayerStatus };
      player_settings: { Row: PlayerSettings; Update: Partial<PlayerSettings> };
      kiosk_sessions: { Row: KioskSession };
      system_logs: { Row: SystemLog };
    };
  };
}

// =============================================================================
// CLIENT INITIALIZATION
// =============================================================================

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export const supabase: SupabaseClient<Database> = createClient(supabaseUrl, supabaseAnonKey);

// =============================================================================
// REALTIME HELPERS
// =============================================================================

// @ts-ignore - T is used in interface definition
export interface RealtimeSubscription<T = any> {
  channel: RealtimeChannel;
  unsubscribe: () => void;
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
 * Subscribe to player status updates
 */
export function subscribeToPlayerStatus(
  playerId: string,
  callback: (status: PlayerStatus) => void
): RealtimeSubscription<PlayerStatus> {
  // Fetch initial status with media_item join
  supabase
    .from('player_status')
    .select('*, current_media:media_items(*)')
    .eq('player_id', playerId)
    .single()
    .then(({ data }) => {
      if (data) callback(data as any);
    });

  return subscribeToTable<PlayerStatus>(
    'player_status',
    { column: 'player_id', value: playerId },
    (payload) => {
      if (payload.eventType === 'UPDATE' || payload.eventType === 'INSERT') {
        // Fetch with media_item join
        supabase
          .from('player_status')
          .select('*, current_media:media_items(*)')
          .eq('player_id', playerId)
          .single()
          .then(({ data }) => {
            if (data) callback(data as any);
          });
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
  const fetchQueue = () => {
    console.log('[subscribeToQueue] Fetching queue from database...');
    supabase
      .from('queue')
      .select('id, player_id, type, media_item_id, position, requested_by, requested_at, played_at, expires_at, media_item:media_items(*)')
      .eq('player_id', playerId)
      .is('played_at', null)
      .order('type', { ascending: false })
      .order('position', { ascending: true })
      .then(({ data }) => {
        if (data) {
          console.log('[subscribeToQueue] Fetched', data.length, 'items');
          callback(data as QueueItem[]);
        }
      });
  };
  
  // Fetch initial queue
  fetchQueue();

  // Subscribe to changes
  let refetchTimeout: ReturnType<typeof setTimeout> | null = null;
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
  supabase
    .from('player_settings')
    .select('*')
    .eq('player_id', playerId)
    .single()
    .then(({ data }) => {
      if (data) callback(data);
    });

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
  supabase
    .from('kiosk_sessions')
    .select('*')
    .eq('session_id', sessionId)
    .single()
    .then(({ data }) => {
      if (data) callback(data);
    });

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
  // For very large reorders, call RPC directly to avoid sending a huge
  // payload through Edge Function and to allow client to use
  // database RPC which accepts uuid[] more directly. This matches the
  // optimized behavior used in compiled app bundle.
  try {
    if (params.action === 'reorder' && Array.isArray(params.queue_ids) && params.queue_ids.length > 50) {
      // Call unambiguous wrapper RPC to avoid overload resolution issues
      const { error } = await supabase.rpc('queue_reorder_wrapper', {
        p_player_id: params.player_id,
        p_queue_ids: params.queue_ids,
        p_type: params.type || 'normal'
      } as any);
      if (error) throw error;
      return { success: true } as any;
    }

    const { data, error } = await supabase.functions.invoke('queue-manager', {
      body: params
    });

    if (error) {
      // Normalize error to a real Error so callers receive a message string
      throw new Error(error.message || JSON.stringify(error));
    }

    return data;
  } catch (err: any) {
    // If caught error is a Postgres error object, normalize it so UI logs
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
}) {
  const { data, error } = await supabase.functions.invoke('player-control', {
    body: params
  });

  if (error) {
    // Normalize error to a real Error so callers receive a message string
    throw new Error(error.message || JSON.stringify(error));
  }

  return data;
}

/**
 * Call kiosk handler edge function
 */
export async function callKioskHandler(params: {
  session_id?: string;
  player_id?: string;
  action: 'init' | 'search' | 'credit' | 'request';
  query?: string;
  media_item_id?: string;
  amount?: number;
  url?: string;
}) {
  try {
    // Call Edge Function directly to bypass authentication requirements for public kiosk
    const response = await fetch(`${supabaseUrl}/functions/v1/kiosk-handler`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
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
  action: 'create' | 'update' | 'delete' | 'add_item' | 'remove_item' | 'reorder' | 'scrape' | 'set_active' | 'clear_queue' | 'import_queue' | 'load_playlist' | 'remove_media_globally';
  player_id?: string;
  playlist_id?: string;
  name?: string;
  description?: string;
  media_item_id?: string;
  item_ids?: string[];
  url?: string;
  current_index?: number;
}) {
  const { data, error } = await supabase.functions.invoke('playlist-manager', {
    body: params
  });

  if (error) throw error;
  return data;
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
 * Load a specific playlist into player queue
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
 * Get all playlists for a player
 */
export async function getPlaylists(playerId: string): Promise<Playlist[]> {
  // Prefer aggregated view that includes item counts when available.
  // Fallback to raw playlists table if view does not exist.
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
      // item_count is available on row if callers want it
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
    // If error indicates a missing foreign key relationship, fall back to two-step approach
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
    // Set credits to 0 for all sessions belonging to this player
    const { error } = await (supabase as any)
      .from('kiosk_sessions')
      .update({ credits: 0 })
      .eq('player_id', playerId);

    if (error) throw error;
  } else if (action === 'add' && amount) {
    // Add credits to most-recently-active kiosk session for this player.
    // Admin +1/+3 buttons are expected to increment visible total by a small amount,
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
  if (error) throw error;
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
