import { useState, useEffect, useCallback, useRef } from 'react';
import { cleanDisplayText } from '../../../shared/media-utils';
import {
  getPlaylists,
  getPlaylistItems,
  callPlaylistManager,
  type Playlist,
  type PlaylistItem,
  type MediaItem,
} from '@shared/supabase-client';
import type { ViewId } from '../types';
import { Spinner, PanelHeader, Btn } from './ui';

export function PlaylistsPanel({ view, playerId }: { view: ViewId; playerId: string }) {
  const [playlists, setPlaylists] = useState<(Playlist & { item_count?: number })[]>([]);
  const [playlistItems, setPlaylistItems] = useState<(PlaylistItem & { media_item?: MediaItem })[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loadingId, setLoadingId]   = useState<string | null>(null);
  const isLoadingPlaylistRef        = useRef(false);
  const [msg, setMsg]               = useState<{ text: string; ok: boolean } | null>(null);
  const [importYtId, setImportYtId] = useState('');
  const [importName, setImportName] = useState('');
  const [importing, setImporting]   = useState(false);
  const [importResult, setImportResult] = useState<{ text: string; ok: boolean } | null>(null);

  const loadPlaylists = useCallback(async () => {
    try { const data = await getPlaylists(playerId); setPlaylists(data as typeof playlists); }
    catch (e) { console.error(e); }
  }, [playerId]);

  useEffect(() => { loadPlaylists(); }, [loadPlaylists]);
  useEffect(() => {
    if (expandedId) getPlaylistItems(expandedId).then(setPlaylistItems).catch(console.error);
  }, [expandedId]);

  const handleLoad = async (e: React.MouseEvent, playlist: Playlist) => {
    if (isLoadingPlaylistRef.current) return;
    e.stopPropagation();
    setLoadingId(playlist.id);
    isLoadingPlaylistRef.current = true;
    try {
      await callPlaylistManager({ action: 'load_playlist', player_id: playerId, playlist_id: playlist.id });
      setMsg({ text: `✓ Loaded "${playlist.name}" into queue`, ok: true });
      await loadPlaylists();
    } catch (e) { console.error(e); setMsg({ text: '❌ Failed to load playlist', ok: false }); }
    finally { setLoadingId(null); isLoadingPlaylistRef.current = false; }
  };

  const handleDelete = async (playlist: Playlist) => {
    if (!window.confirm(`Delete "${playlist.name}"? This cannot be undone.`)) return;
    try { await callPlaylistManager({ action: 'delete', player_id: playerId, playlist_id: playlist.id }); await loadPlaylists(); }
    catch (e) { console.error(e); }
  };

  const handleCreate = async () => {
    const name = window.prompt('New playlist name:');
    if (!name) return;
    try { await callPlaylistManager({ action: 'create', player_id: playerId, name }); await loadPlaylists(); }
    catch (e) { console.error(e); }
  };

  const handleImport = async () => {
    if (!importYtId.trim()) return;
    setImporting(true); setImportResult(null);
    try {
      const name = importName.trim() || `Imported ${importYtId.trim().slice(0, 12)}`;
      const created = await callPlaylistManager({ action: 'create', player_id: playerId, name }) as { playlist?: { id: string } };
      const playlistId = created?.playlist?.id;
      if (!playlistId) throw new Error('Failed to create playlist record');
      const ytUrl = `https://www.youtube.com/playlist?list=${importYtId.trim()}`;
      const result = await callPlaylistManager({ action: 'scrape', playlist_id: playlistId, url: ytUrl }) as { count?: number };
      setImportResult({ text: `✓ Imported ${result?.count ?? 0} videos into "${name}"`, ok: true });
      setImportYtId(''); setImportName('');
      await loadPlaylists();
    } catch (e: unknown) {
      setImportResult({ text: `❌ ${e instanceof Error ? e.message : 'Import failed'}`, ok: false });
    } finally { setImporting(false); }
  };

  if (view === 'playlists-import') return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <PanelHeader title="Import Playlist" subtitle="Scrape a YouTube playlist into Obie via Edge Function" />
      <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
        <div style={{ maxWidth: 480, background: 'rgba(255,255,255,0.025)', border: '1px solid var(--border)', borderRadius: 16, padding: 24 }}>
          {[{ label: 'YouTube Playlist ID *', value: importYtId, set: setImportYtId, ph: 'PLN9QqCogPsXJCgeL_iEgYnW6Rl_8nIUUH', mono: true },
            { label: 'Playlist Name (optional)', value: importName, set: setImportName, ph: 'My Custom Playlist', mono: false }].map(f => (
            <div key={f.label} style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontFamily: 'var(--font-display)', fontSize: 13, color: 'var(--muted)', marginBottom: 6 }}>{f.label}</label>
              <input value={f.value} onChange={e => f.set(e.target.value)} placeholder={f.ph}
                style={{ width: '100%', padding: '10px 14px', borderRadius: 10, background: '#0d0d0d', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', fontFamily: f.mono ? 'var(--font-mono)' : 'var(--font-display)', fontSize: 13, outline: 'none' }} />
            </div>
          ))}
          <button onClick={handleImport} disabled={importing || !importYtId.trim()}
            style={{ width: '100%', padding: '12px', borderRadius: 12, border: 'none', cursor: importing || !importYtId.trim() ? 'default' : 'pointer',
              background: 'var(--accent)', color: '#000', fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 700,
              opacity: importing || !importYtId.trim() ? 0.5 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            {importing ? <><Spinner size={16} /> Importing…</> : '📥 Import Playlist'}
          </button>
          {importResult && <div style={{ marginTop: 14, padding: '10px 14px', borderRadius: 9,
            background: importResult.ok ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
            border: `1px solid ${importResult.ok ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)'}`,
            color: importResult.ok ? '#4ade80' : '#f87171', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{importResult.text}</div>}
        </div>
      </div>
    </div>
  );

  // playlists-all
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const active = playlists.find(p => (p as any).is_active);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sorted = [...playlists].sort((a, b) => ((b as any).is_active ? 1 : 0) - ((a as any).is_active ? 1 : 0));
  const totalSongs = playlists.reduce((a, p) => a + (p.item_count ?? 0), 0);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <PanelHeader title="Playlists" subtitle={`${playlists.length} playlists · ${totalSongs.toLocaleString()} total songs`}
        actions={<Btn variant="accent" onClick={handleCreate}>＋ New Playlist</Btn>}
      />
      {msg && <div style={{ margin: '8px 24px 0', padding: '8px 12px', borderRadius: 8,
        background: msg.ok ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
        color: msg.ok ? '#4ade80' : '#f87171', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{msg.text}</div>}
      {active && (
        <div style={{ margin: '8px 24px 0', padding: '8px 14px', borderRadius: 8, background: 'var(--accent-dim)', border: '1px solid var(--accent-border)', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--accent)' }}>
          ▶ Currently Active: {active.name}
        </div>
      )}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 24px' }}>
        {sorted.map(playlist => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const isActive   = (playlist as any).is_active;
          const isExpanded = expandedId === playlist.id;
          return (
            <div key={playlist.id} style={{ marginBottom: 6, borderRadius: 13,
              background: isActive ? 'var(--accent-dim)' : 'rgba(255,255,255,0.025)',
              border: `1px solid ${isActive ? 'var(--accent-border)' : 'rgba(255,255,255,0.06)'}` }}>
              <div onClick={() => setExpandedId(isExpanded ? null : playlist.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px', cursor: 'pointer' }}>
                <div style={{ width: 40, height: 40, borderRadius: 10, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, background: isActive ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.06)' }}>🎵</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <span style={{ fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 600, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{playlist.name}</span>
                    {isActive && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, padding: '1px 6px', borderRadius: 99, background: 'rgba(34,197,94,0.18)', color: '#4ade80', textTransform: 'uppercase', letterSpacing: '0.05em', flexShrink: 0 }}>ACTIVE</span>}
                  </div>
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', marginTop: 2 }}>{(playlist.item_count ?? 0).toLocaleString()} songs</div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }} onClick={e => e.stopPropagation()}>
                  <Btn variant="accent" onClick={e => handleLoad(e, playlist)} disabled={loadingId !== null}>
                    {loadingId === playlist.id ? <Spinner size={12} /> : '▶ Load Queue'}
                  </Btn>
                  <Btn variant="danger" onClick={() => handleDelete(playlist)}>🗑</Btn>
                </div>
              </div>
              {isExpanded && (
                <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', maxHeight: 240, overflowY: 'auto', padding: '8px 14px 10px' }}>
                  {playlistItems.length === 0
                    ? <div style={{ color: 'rgba(255,255,255,0.25)', fontFamily: 'var(--font-mono)', fontSize: 11, padding: '8px 0' }}>No items loaded yet</div>
                    : playlistItems.slice(0, 50).map((item, i) => (
                        <div key={item.id} style={{ display: 'flex', gap: 9, padding: '5px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', alignItems: 'center' }}>
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'rgba(255,255,255,0.2)', width: 28 }}>{i + 1}</span>
                          <div style={{ fontFamily: 'var(--font-display)', fontSize: 12, color: 'rgba(255,255,255,0.7)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                            {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                            {cleanDisplayText((item.media_item as any)?.title) || 'Unknown'}
                            {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                            {(item.media_item as any)?.artist ? ` · ${cleanDisplayText((item.media_item as any).artist)}` : ''}
                          </div>
                        </div>
                      ))
                  }
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
