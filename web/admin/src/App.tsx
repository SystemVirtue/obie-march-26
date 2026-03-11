// Obie Admin Console v2 — Obsidian Stage Design
// All data flows through real Supabase subscriptions and Edge Function calls.

import { useEffect, useState, useCallback, useRef } from 'react';
import {
  subscribeToQueue,
  subscribeToPlayerStatus,
  subscribeToPlayerSettings,
  callQueueManager,
  callPlayerControl,
  signOut,
  getCurrentUser,
  getUserPlayerId,
  getMyJukeboxes,
  createJukebox,
  resolveJukeboxSlug,
  subscribeToAuth,
  type PlayerStatus,
  type PlayerSettings,
  type QueueItem,
  type AuthUser,
  type JukeboxSummary,
} from '@shared/supabase-client';
import { arrayMove } from '@dnd-kit/sortable';
import type { DragEndEvent } from '@dnd-kit/core';
import { normalizeJukeboxSlug, getPathJukeboxSlug } from '@shared/jukebox-utils';

import type { ViewId } from './types';
import { PLAYER_ID, FS_SCALES, hexToRgb, darkenHex, navigateClient } from './types';
import { Spinner } from './components/ui';
import { LoginForm } from './components/LoginForm';
import { NowPlayingStage } from './components/NowPlayingStage';
import { Sidebar } from './components/Sidebar';
import { QueuePanel } from './components/QueuePanel';
import { PlaylistsPanel } from './components/PlaylistsPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { ScriptsPanel } from './components/ScriptsPanel';
import { LogsPanel } from './components/LogsPanel';

// ─── Accent CSS helpers (DOM side-effects, not exported) ─────────────────────
function applyAccentCSS(hex: string) {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return;
  const [r, g, b] = hexToRgb(hex);
  const root = document.documentElement;
  root.style.setProperty('--accent',        hex);
  root.style.setProperty('--accent-dark',   darkenHex(hex, 0.12));
  root.style.setProperty('--accent-dim',    `rgba(${r},${g},${b},0.15)`);
  root.style.setProperty('--accent-border', `rgba(${r},${g},${b},0.30)`);
  root.style.setProperty('--accent-glow',   `rgba(${r},${g},${b},0.38)`);
  root.style.setProperty('--accent-rgb',    `${r},${g},${b}`);
}
function applyZoom(zoom: number) {
  const el = document.getElementById('root');
  if (el) (el.style as unknown as Record<string,string>).zoom = String(zoom);
}

// ─── Prefs hook ──────────────────────────────────────────────────────────────
function usePrefs() {
  const [accent, setAccentState] = useState(() => {
    try { return localStorage.getItem('obie_accent') || '#f59e0b'; } catch { return '#f59e0b'; }
  });
  const [fsIdx, setFsIdxState] = useState(() => {
    try { const v = localStorage.getItem('obie_fontsize'); return v !== null ? parseInt(v, 10) : 2; }
    catch { return 2; }
  });
  useEffect(() => { applyAccentCSS(accent); }, [accent]);
  useEffect(() => { applyZoom(FS_SCALES[fsIdx].zoom); }, [fsIdx]);

  const setAccent = useCallback((hex: string) => {
    setAccentState(hex); applyAccentCSS(hex);
    try { localStorage.setItem('obie_accent', hex); } catch { /* noop */ }
  }, []);
  const setFsIdx = useCallback((idx: number) => {
    const c = Math.max(0, Math.min(FS_SCALES.length - 1, idx));
    setFsIdxState(c); applyZoom(FS_SCALES[c].zoom);
    try { localStorage.setItem('obie_fontsize', String(c)); } catch { /* noop */ }
  }, []);

  return { accent, setAccent, fsIdx, setFsIdx, fsScale: FS_SCALES[fsIdx] };
}

// ─────────────────────────────────────────────────────────────────────────────
// ROOT APP
// ─────────────────────────────────────────────────────────────────────────────

function App() {
  const [user, setUser]         = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [routeSlug, setRouteSlug] = useState<string>(() => getPathJukeboxSlug());
  const [resolvedPlayerId, setResolvedPlayerId] = useState<string | null>(null);
  const [resolvedJukeboxSlug, setResolvedJukeboxSlug] = useState<string | null>(null);
  const [availableJukeboxes, setAvailableJukeboxes] = useState<JukeboxSummary[]>([]);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [view, setView]         = useState<ViewId>('queue');
  const [queue, setQueue]       = useState<QueueItem[]>([]);
  const [status, setStatus]     = useState<PlayerStatus | null>(null);
  const [settings, setSettings] = useState<PlayerSettings | null>(null);
  const [isShuffling, setIsShuffling] = useState(false);
  const [isSkipping,  setIsSkipping]  = useState(false);
  const isSkippingRef = useRef(false);
  useEffect(() => { isSkippingRef.current = isSkipping; }, [isSkipping]);

  const prefs = usePrefs();

  // Auth
  useEffect(() => {
    getCurrentUser()
      .then(setUser)
      .catch((err) => {
        console.error('[Auth] Failed to fetch current user:', err);
        setUser(null);
      })
      .finally(() => setAuthLoading(false));
    const sub = subscribeToAuth(setUser);
    return () => sub.unsubscribe();
  }, []);

  useEffect(() => {
    const handlePopState = () => setRouteSlug(getPathJukeboxSlug());
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Resolve player_id for the authenticated user using URL slug when present.
  useEffect(() => {
    if (!user) {
      setResolvedPlayerId(null);
      setResolvedJukeboxSlug(null);
      setAvailableJukeboxes([]);
      setResolveError(null);
      return;
    }

    let cancelled = false;
    const resolve = async () => {
      try {
        const pathSlug = routeSlug;
        const myJukeboxes = await getMyJukeboxes();
        if (!cancelled) setAvailableJukeboxes(myJukeboxes);

        if (pathSlug) {
          const resolved = await resolveJukeboxSlug(pathSlug);
          if (!resolved) throw new Error(`Jukebox "${pathSlug}" was not found.`);
          const hasAccess = myJukeboxes.some((j) => j.player_id === resolved.player_id);
          if (!hasAccess) throw new Error(`You do not have access to jukebox "${resolved.jukebox_slug}".`);
          if (!cancelled) {
            setResolvedPlayerId(resolved.player_id);
            setResolvedJukeboxSlug(resolved.jukebox_slug);
            setResolveError(null);
          }
          if (pathSlug !== resolved.jukebox_slug) navigateClient(`/${resolved.jukebox_slug}`, true);
          return;
        }

        if (myJukeboxes.length > 0) {
          const first = myJukeboxes[0];
          if (!cancelled) {
            setResolvedPlayerId(first.player_id);
            setResolvedJukeboxSlug(first.jukebox_slug);
            setResolveError(null);
          }
          navigateClient(`/${first.jukebox_slug}`, true);
          return;
        }

        for (let attempt = 0; attempt < 5; attempt++) {
          const id = await getUserPlayerId();
          if (id) {
            if (!cancelled) {
              setResolvedPlayerId(id);
              setResolvedJukeboxSlug(null);
              setResolveError(null);
            }
            return;
          }
          await new Promise((res) => setTimeout(res, 200 * (attempt + 1)));
        }

        if (!cancelled) {
          setResolvedPlayerId(PLAYER_ID);
          setResolvedJukeboxSlug(null);
          setResolveError('No jukebox mapping found for your account; using legacy default player.');
        }
      } catch (err) {
        console.error('[Auth] Failed to resolve player id:', err);
        if (!cancelled) {
          setResolvedPlayerId(null);
          setResolvedJukeboxSlug(null);
          setResolveError(err instanceof Error ? err.message : 'Failed to resolve jukebox.');
        }
      }
    };

    resolve();
    return () => { cancelled = true; };
  }, [user, routeSlug]);

  const activePlayerId = resolvedPlayerId;

  const handleSwitchJukebox = (slug: string) => {
    const normalized = normalizeJukeboxSlug(slug);
    if (!normalized) return;
    navigateClient(`/${normalized}`);
  };

  const handleCreateJukebox = async () => {
    const entered = window.prompt('Enter new jukebox name (A-Z, 0-9, underscore, dash):');
    const slug = normalizeJukeboxSlug(entered);
    if (!slug) return;
    try {
      const created = await createJukebox(slug, slug);
      const refreshed = await getMyJukeboxes();
      setAvailableJukeboxes(refreshed);
      navigateClient(`/${created.jukebox_slug}`);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to create jukebox');
    }
  };

  // Realtime subscriptions — deps intentionally omit isSkipping; use ref to avoid subscription churn
  useEffect(() => {
    if (!user || !activePlayerId) return;
    const q  = subscribeToQueue(activePlayerId, setQueue);
    const s  = subscribeToPlayerStatus(activePlayerId, (ns) => {
      setStatus(ns);
      if (isSkippingRef.current && (ns.state === 'playing' || ns.state === 'loading')) setIsSkipping(false);
    });
    const ps = subscribeToPlayerSettings(activePlayerId, setSettings);
    return () => { q.unsubscribe(); s.unsubscribe(); ps.unsubscribe(); };
  }, [user, activePlayerId]);

  // ── Queue handlers ────────────────────────────────────────────────────────
  const handleRemove = async (queueId: string) => {
    setQueue(prev => prev.filter(item => item.id !== queueId));
    try { await callQueueManager({ player_id: activePlayerId ?? PLAYER_ID, action: 'remove', queue_id: queueId }); }
    catch (e) { console.error(e); }
  };

  const handleReorder = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const normalQ = queue.filter(i => i.type === 'normal' && i.media_item_id !== status?.current_media_id && i.id);
    const oldIdx  = normalQ.findIndex(i => i.id === active.id);
    const newIdx  = normalQ.findIndex(i => i.id === over.id);
    const reordered = arrayMove(normalQ, oldIdx, newIdx);
    const priority  = queue.filter(i => i.type === 'priority');
    const current   = queue.filter(i => i.media_item_id === status?.current_media_id);
    setQueue([...current, ...priority, ...reordered]);
    try {
      const ids = Array.from(new Set(reordered.map((i) => i.id).filter(Boolean))) as string[];
      await callQueueManager({ player_id: activePlayerId ?? PLAYER_ID, action: 'reorder', queue_ids: ids, type: 'normal' });
    } catch (e) { console.error(e); setQueue(queue); }
  };

  const handleShuffle = async () => {
    setIsShuffling(true);
    try {
      const normalQ = queue.filter(i => i.type === 'normal' && i.media_item_id !== status?.current_media_id && i.id);
      if (normalQ.length <= 1) return;
      await callQueueManager({ player_id: activePlayerId ?? PLAYER_ID, action: 'shuffle', type: 'normal' });
    } catch (e) { console.error('[Shuffle] Failed:', e); }
    finally { setIsShuffling(false); }
  };

  const handlePlayPause = async () => {
    try {
      const newState = status?.state === 'playing' ? 'paused' : 'playing';
      await callPlayerControl({ player_id: activePlayerId ?? PLAYER_ID, state: newState, action: 'update' });
    } catch (e) { console.error(e); }
  };

  const handleSkip = async () => {
    if (isSkipping) return;
    setIsSkipping(true);
    try { await callPlayerControl({ player_id: activePlayerId ?? PLAYER_ID, state: 'idle', action: 'skip' }); }
    catch (e) { console.error(e); setIsSkipping(false); }
    setTimeout(() => setIsSkipping(false), 3000);
  };

  // ── Render ────────────────────────────────────────────────────────────────
  if (authLoading) return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14 }}>
      <Spinner size={36} />
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted)' }}>Loading…</span>
    </div>
  );

  if (!user) return <LoginForm onSignIn={setUser} />;

  if (resolveError) return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, padding: 24 }}>
      <div style={{ maxWidth: 560, textAlign: 'center', color: '#fca5a5', fontFamily: 'var(--font-display)', fontSize: 18 }}>{resolveError}</div>
      <button onClick={() => { navigateClient('/'); }}
        style={{ padding: '10px 16px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.06)', color: '#fff', cursor: 'pointer' }}>
        Choose Another Jukebox
      </button>
    </div>
  );

  if (!activePlayerId) return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14 }}>
      <Spinner size={36} />
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted)' }}>Resolving player…</span>
    </div>
  );

  const isQueueView     = view.startsWith('queue');
  const isPlaylistView  = view.startsWith('playlists');
  const isSettingsView  = view.startsWith('settings');
  const isScriptsView   = view === 'settings-scripts';

  return (
    <div style={{ width: '100%', height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg)' }}>
      <NowPlayingStage status={status} queue={queue} settings={settings}
        onPlayPause={handlePlayPause} onSkip={handleSkip} isSkipping={isSkipping} onRemove={handleRemove} />

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <Sidebar view={view} setView={setView} queue={queue} user={user}
          onSignOut={() => signOut().catch(console.error)}
          jukeboxes={availableJukeboxes} activeJukeboxSlug={resolvedJukeboxSlug}
          onSwitchJukebox={handleSwitchJukebox} onCreateJukebox={handleCreateJukebox} />

        <main style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
          {isQueueView && (
            <QueuePanel queue={queue} status={status}
              onRemove={handleRemove} onReorder={handleReorder}
              onShuffle={handleShuffle} isShuffling={isShuffling} />
          )}
          {isPlaylistView && <PlaylistsPanel view={view} playerId={activePlayerId} />}
          {isScriptsView  && <ScriptsPanel playerId={activePlayerId} />}
          {isSettingsView && !isScriptsView && <SettingsPanel view={view} settings={settings} prefs={prefs} playerId={activePlayerId} />}
          {view === 'logs' && <LogsPanel />}
        </main>
      </div>
    </div>
  );
}

export default App;
