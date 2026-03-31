import { useState, useEffect, useRef } from 'react';
import {
  callKioskHandler,
  callPlaylistManager,
  getPlaylists,
  type Playlist,
} from '@shared/supabase-client';
import { cleanDisplayText } from '../../../shared/media-utils';
import { PanelHeader, Btn, Spinner } from './ui';

interface SearchResult {
  id: string;
  title: string;
  artist?: string | null;
  thumbnail?: string;
  thumbnailUrl?: string;
  url: string;
  source?: string;
}

export function SearchPanel({ playerId }: { playerId: string }) {
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [playlistPickerFor, setPlaylistPickerFor] = useState<SearchResult | null>(null);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string>('');
  const [addingToQueue, setAddingToQueue] = useState<string | null>(null);
  const [addingToPlaylist, setAddingToPlaylist] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load playlists on mount
  useEffect(() => {
    getPlaylists(playerId)
      .then((data) => {
        setPlaylists(data);
        // Default selection: active playlist, else first
        const active = data.find((p) => p.is_active);
        setSelectedPlaylistId(active?.id ?? data[0]?.id ?? '');
      })
      .catch(console.error);
  }, [playerId]);

  const showStatus = (text: string, ok: boolean) => {
    setStatusMsg({ text, ok });
    setTimeout(() => setStatusMsg(null), 3500);
  };

  const performSearch = async () => {
    const q = query.trim();
    if (!q) return;
    setIsSearching(true);
    setSearchResults([]);
    setPlaylistPickerFor(null);
    try {
      const [ytSettled, r2Settled] = await Promise.allSettled([
        callKioskHandler({ action: 'search', query: q }) as Promise<{ videos?: SearchResult[] }>,
        callKioskHandler({ action: 'search_r2', query: q }) as Promise<{ videos?: SearchResult[] }>,
      ]);
      const ytVideos = ytSettled.status === 'fulfilled' ? (ytSettled.value?.videos ?? []) : [];
      const r2Videos = r2Settled.status === 'fulfilled' ? (r2Settled.value?.videos ?? []) : [];
      // Library results first, then YouTube
      setSearchResults([...r2Videos, ...ytVideos]);
    } catch (err) {
      console.error('Search failed:', err);
    } finally {
      setIsSearching(false);
    }
  };

  const handleClear = () => {
    setQuery('');
    setSearchResults([]);
    setPlaylistPickerFor(null);
    inputRef.current?.focus();
  };

  const handleAddToQueue = async (result: SearchResult) => {
    setAddingToQueue(result.id);
    try {
      const params: Parameters<typeof callKioskHandler>[0] = {
        action: 'admin_request',
        player_id: playerId,
        add_to_queue: true,
      };
      if (result.source === 'cloudflare') {
        params.r2_file_id = result.id;
      } else {
        params.url = result.url;
        params.title = result.title;
        if (result.artist) params.artist = result.artist;
        params.thumbnail = result.thumbnailUrl || result.thumbnail;
      }
      const res = await callKioskHandler(params) as { queue_id?: string; error?: string };
      if ((res as any)?.error) throw new Error((res as any).error);
      showStatus(`✓ Added "${cleanDisplayText(result.title)}" to Priority Queue`, true);
    } catch (err) {
      showStatus(`❌ Failed: ${err instanceof Error ? err.message : 'Unknown error'}`, false);
    } finally {
      setAddingToQueue(null);
    }
  };

  const handleAddToPlaylist = async () => {
    if (!playlistPickerFor || !selectedPlaylistId) return;
    const result = playlistPickerFor;
    setAddingToPlaylist(result.id);
    try {
      // Step 1: create/get media item via admin_request (no queue)
      const reqParams: Parameters<typeof callKioskHandler>[0] = {
        action: 'admin_request',
        player_id: playerId,
        add_to_queue: false,
      };
      if (result.source === 'cloudflare') {
        reqParams.r2_file_id = result.id;
      } else {
        reqParams.url = result.url;
        reqParams.title = result.title;
        if (result.artist) reqParams.artist = result.artist;
        reqParams.thumbnail = result.thumbnailUrl || result.thumbnail;
      }
      const res = await callKioskHandler(reqParams) as { media_item_id?: string; error?: string };
      if ((res as any)?.error) throw new Error((res as any).error);
      const mediaItemId = res?.media_item_id;
      if (!mediaItemId) throw new Error('No media_item_id returned');

      // Step 2: add to selected playlist
      await callPlaylistManager({
        action: 'add_item',
        playlist_id: selectedPlaylistId,
        media_item_id: mediaItemId,
      });

      const playlist = playlists.find((p) => p.id === selectedPlaylistId);
      showStatus(`✓ Added to "${playlist?.name ?? 'playlist'}"`, true);
    } catch (err) {
      showStatus(`❌ Failed: ${err instanceof Error ? err.message : 'Unknown error'}`, false);
    } finally {
      setAddingToPlaylist(null);
      setPlaylistPickerFor(null);
    }
  };

  // Sorted playlists: active first, then alphabetically
  const activePlaylist = playlists.find((p) => p.is_active);
  const sortedPlaylists = [
    ...(activePlaylist ? [activePlaylist] : []),
    ...[...playlists].filter((p) => !p.is_active).sort((a, b) => a.name.localeCompare(b.name)),
  ];

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <PanelHeader
        title="Search"
        subtitle="Search library and YouTube — actions bypass credit system"
      />

      {/* Search bar */}
      <div style={{ padding: '14px 24px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, flexShrink: 0 }}>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && performSearch()}
          placeholder="Artist, song title…"
          autoFocus
          style={{
            flex: 1, padding: '9px 14px', borderRadius: 10,
            background: '#0d0d0d', border: '1px solid rgba(255,255,255,0.12)',
            color: '#fff', fontFamily: 'var(--font-display)', fontSize: 14, outline: 'none',
          }}
        />
        <Btn variant="accent" onClick={performSearch} disabled={isSearching || !query.trim()}>
          {isSearching ? <><Spinner size={13} /> Searching…</> : '🔍 Search'}
        </Btn>
        <Btn variant="ghost" onClick={handleClear} disabled={isSearching}>
          Clear
        </Btn>
      </div>

      {/* Status message */}
      {statusMsg && (
        <div style={{
          margin: '8px 24px 0', padding: '8px 12px', borderRadius: 8,
          background: statusMsg.ok ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
          color: statusMsg.ok ? '#4ade80' : '#f87171',
          fontFamily: 'var(--font-mono)', fontSize: 11,
        }}>
          {statusMsg.text}
        </div>
      )}

      {/* Results list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 24px 24px' }}>
        {isSearching && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '24px 0', color: 'var(--muted)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
            <Spinner size={16} /> Searching…
          </div>
        )}

        {!isSearching && searchResults.length === 0 && query.trim() && (
          <div style={{ padding: '24px 0', color: 'rgba(255,255,255,0.25)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
            No results found.
          </div>
        )}

        {searchResults.map((result) => {
          const thumb = result.thumbnailUrl || result.thumbnail || '';
          const title = cleanDisplayText(result.title) || 'Unknown Title';
          const artist = result.artist ? cleanDisplayText(result.artist) : null;
          const displayLabel = artist ? `${artist} – ${title}` : title;
          const isHovered = hoveredId === result.id;
          const isR2 = result.source === 'cloudflare';

          return (
            <div
              key={`${result.source ?? 'yt'}-${result.id}`}
              onMouseEnter={() => setHoveredId(result.id)}
              onMouseLeave={() => { setHoveredId(null); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '7px 10px', borderRadius: 10,
                borderBottom: '1px solid rgba(255,255,255,0.04)',
                background: isHovered ? 'rgba(255,255,255,0.04)' : 'transparent',
                transition: 'background 0.12s', cursor: 'default', position: 'relative',
              }}
            >
              {/* Thumbnail */}
              <div style={{ width: 48, height: 36, flexShrink: 0, borderRadius: 6, overflow: 'hidden', background: 'rgba(255,255,255,0.06)' }}>
                {thumb ? (
                  <img src={thumb} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 }}>
                    {isR2 ? '💾' : '▶'}
                  </div>
                )}
              </div>

              {/* Label */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontFamily: 'var(--font-display)', fontSize: 13, color: '#e5e7eb',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {displayLabel}
                </div>
                {isR2 && (
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--accent)', marginTop: 1 }}>LIBRARY</div>
                )}
              </div>

              {/* Action buttons — visible on hover */}
              {isHovered && (
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <Btn
                    variant="accent"
                    disabled={addingToQueue === result.id}
                    onClick={() => handleAddToQueue(result)}
                  >
                    {addingToQueue === result.id ? <Spinner size={12} /> : '＋ Priority Queue'}
                  </Btn>
                  <Btn
                    variant="ghost"
                    disabled={addingToPlaylist === result.id}
                    onClick={() => {
                      setPlaylistPickerFor(result);
                      setHoveredId(null);
                    }}
                  >
                    ＋ Playlist
                  </Btn>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Playlist picker modal */}
      {playlistPickerFor && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
          }}
          onClick={() => setPlaylistPickerFor(null)}
        >
          <div
            style={{
              background: '#1a1a1a', border: '1px solid var(--border)', borderRadius: 16,
              padding: 24, width: 380, maxWidth: '90vw',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 700, color: '#fff', marginBottom: 4 }}>
              Add to Playlist
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--muted)', marginBottom: 16, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {cleanDisplayText(playlistPickerFor.title)}
            </div>

            <label style={{ display: 'block', fontFamily: 'var(--font-display)', fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>
              Select Playlist
            </label>
            <select
              value={selectedPlaylistId}
              onChange={(e) => setSelectedPlaylistId(e.target.value)}
              style={{
                width: '100%', padding: '9px 12px', borderRadius: 10,
                background: '#0d0d0d', border: '1px solid rgba(255,255,255,0.12)',
                color: '#fff', fontFamily: 'var(--font-display)', fontSize: 13,
                outline: 'none', marginBottom: 18, cursor: 'pointer',
              }}
            >
              {sortedPlaylists.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.is_active ? `Current Playlist (${p.name})` : p.name}
                </option>
              ))}
              {sortedPlaylists.length === 0 && (
                <option value="" disabled>No playlists available</option>
              )}
            </select>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setPlaylistPickerFor(null)}
                disabled={addingToPlaylist !== null}
                style={{
                  padding: '9px 18px', borderRadius: 10, border: '1px solid rgba(239,68,68,0.35)',
                  background: 'rgba(239,68,68,0.1)', color: '#f87171',
                  fontFamily: 'var(--font-display)', fontSize: 13, fontWeight: 500,
                  cursor: 'pointer', opacity: addingToPlaylist !== null ? 0.45 : 1,
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleAddToPlaylist}
                disabled={!selectedPlaylistId || addingToPlaylist !== null}
                style={{
                  padding: '9px 18px', borderRadius: 10, border: 'none',
                  background: addingToPlaylist !== null ? 'rgba(34,197,94,0.4)' : 'rgba(34,197,94,0.85)',
                  color: '#000',
                  fontFamily: 'var(--font-display)', fontSize: 13, fontWeight: 700,
                  cursor: !selectedPlaylistId || addingToPlaylist !== null ? 'default' : 'pointer',
                  opacity: !selectedPlaylistId ? 0.45 : 1,
                  display: 'flex', alignItems: 'center', gap: 7,
                }}
              >
                {addingToPlaylist !== null ? <><Spinner size={13} /> Adding…</> : 'Add to Selected Playlist'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
