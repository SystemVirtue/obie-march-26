/**
 * Low-level Supabase helpers for test setup / teardown.
 * Uses the REST API directly (no SDK dependency needed at root level).
 *
 * NOTE: These run with the anon key, so they are limited to what RLS allows.
 * RPCs tagged SECURITY DEFINER will work; direct table writes may be restricted.
 */
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export const SUPABASE_URL   = process.env.VITE_SUPABASE_URL   || '';
export const SUPABASE_ANON  = process.env.VITE_SUPABASE_ANON_KEY || '';
export const PLAYER_ID      = '00000000-0000-0000-0000-000000000001';

// ── HTTP helpers ─────────────────────────────────────────────────────────────

async function sbFetch(
  path: string,
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH' = 'POST',
  body?: unknown,
  authToken?: string
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const token = authToken || SUPABASE_ANON;
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPABASE_ANON,
      'Authorization': `Bearer ${token}`,
      'Prefer':        'return=representation',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

// ── RPC wrapper ───────────────────────────────────────────────────────────────

export async function rpc(funcName: string, params: Record<string, unknown> = {}) {
  const r = await sbFetch(`/rest/v1/rpc/${funcName}`, 'POST', params);
  if (!r.ok) {
    console.error(`[db] rpc ${funcName} failed (${r.status}):`, r.data);
  }
  return r.data;
}

// ── Edge function wrapper ─────────────────────────────────────────────────────

export async function callEdge(funcName: string, body: Record<string, unknown> = {}) {
  const r = await sbFetch(`/functions/v1/${funcName}`, 'POST', body);
  return r.data;
}

// ── Queue helpers ─────────────────────────────────────────────────────────────

/**
 * Fetch existing media items from the production DB.
 * Used by seedQueue to avoid needing the create_or_get_media_item RPC
 * (which may not be deployed to the remote instance yet).
 */
let _cachedMediaItems: Array<{ id: string; title: string }> | null = null;

export async function getExistingMediaItems(limit = 10): Promise<Array<{ id: string; title: string }>> {
  if (_cachedMediaItems && _cachedMediaItems.length >= limit) return _cachedMediaItems.slice(0, limit);
  const r = await sbFetch(
    `/rest/v1/media_items?order=id.asc&limit=${limit}&select=id,title`,
    'GET'
  );
  _cachedMediaItems = (r.data as Array<{ id: string; title: string }>) || [];
  return _cachedMediaItems;
}

/** Add a media item to the queue. Returns queue_id. */
export async function addToQueue(mediaItemId: string, type: 'normal' | 'priority' = 'normal') {
  const r = await callEdge('queue-manager', {
    player_id:     PLAYER_ID,
    action:        'add',
    media_item_id: mediaItemId,
    type,
    requested_by:  'test',
  }) as { queue_id?: string };
  return r?.queue_id ?? null;
}

/**
 * Create a test media item using the create_or_get_media_item RPC.
 * Falls back to using an existing media item if the RPC is not available.
 */
export async function createTestMediaItem(suffix = ''): Promise<string | null> {
  // Try the RPC first (works if migration 0026 has been deployed)
  const rpcResult = await rpc('create_or_get_media_item', {
    p_source_id:    `test-source-${suffix || 'default'}`,
    p_source_type:  'youtube',
    p_title:        `Test Song ${suffix || 'Default'}`,
    p_artist:       'Test Artist',
    p_url:          `https://www.youtube.com/watch?v=test${suffix}`,
    p_duration:     180,
    p_thumbnail:    '',
    p_metadata:     {},
  });

  if (typeof rpcResult === 'string' && rpcResult.includes('-')) {
    return rpcResult; // UUID returned from RPC
  }

  // Fallback: use an existing media item from the DB
  const items = await getExistingMediaItems(10);
  if (items.length === 0) return null;

  // Pick a deterministic item based on suffix to get predictable "Test Song N" labels
  const index = parseInt(suffix.replace(/\D/g, '') || '0', 10) % items.length;
  return items[index].id;
}

/** Clear the queue (all types). */
export async function clearQueue() {
  await callEdge('queue-manager', { player_id: PLAYER_ID, action: 'clear', type: null });
}

/** Clear normal queue only. */
export async function clearNormalQueue() {
  await callEdge('queue-manager', { player_id: PLAYER_ID, action: 'clear', type: 'normal' });
}

/** Clear priority queue only. */
export async function clearPriorityQueue() {
  await callEdge('queue-manager', { player_id: PLAYER_ID, action: 'clear', type: 'priority' });
}

/** Send a heartbeat to bring the player online. */
export async function bringPlayerOnline() {
  await rpc('player_heartbeat', { p_player_id: PLAYER_ID });
}

/** Get current queue state. */
export async function getQueue() {
  const r = await sbFetch(
    `/rest/v1/queue?player_id=eq.${PLAYER_ID}&played_at=is.null&order=position.asc`,
    'GET'
  );
  return (r.data as unknown[]) || [];
}

/**
 * Seed N test songs into the normal queue and return their queue_ids.
 * Reuses a persistent test media item per index.
 */
export async function seedQueue(count = 3): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 1; i <= count; i++) {
    const mediaId = await createTestMediaItem(String(i));
    if (mediaId) {
      const qId = await addToQueue(mediaId as string, 'normal');
      if (qId) ids.push(qId);
    }
  }
  return ids;
}
