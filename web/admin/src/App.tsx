// Obie Admin Console v2 — Obsidian Stage Design
// All data flows through real Supabase subscriptions and Edge Function calls.

import { useEffect, useState, useRef } from 'react';
import {
  subscribeToQueue,
  subscribeToPlayerStatus,
  subscribeToPlayerSettings,
  subscribeToTable,
  callQueueManager,
  callPlayerControl,
  callRadioGenerator,
  signOut,
  getCurrentUser,
  getUserPlayerId,
  getMyJukeboxes,
  createJukebox,
  resolveJukeboxSlug,
  subscribeToAuth,
  getPlayersByIds,
  getKioskSessions,
  subscribeToPlayer,
  getPlaylistById,
  type Player,
  type PlayerStatus,
  type PlayerSettings,
  type QueueItem,
  type AuthUser,
  type JukeboxSummary,
  type KioskSession,
} from '@shared/supabase-client';
import { arrayMove } from '@dnd-kit/sortable';
import type { DragEndEvent } from '@dnd-kit/core';
import { normalizeJukeboxSlug, getPathJukeboxSlug } from '@shared/jukebox-utils';

import type { ViewId } from './types';
import { PLAYER_ID, navigateClient } from './types';
import { useAdminPrefs } from './hooks/useAdminPrefs';
import { Spinner } from './components/ui';
import { LoginForm } from './components/LoginForm';
import { NowPlayingStage } from './components/NowPlayingStage';
import { Sidebar } from './components/Sidebar';
import { QueuePanel } from './components/QueuePanel';
import { PlaylistsPanel } from './components/PlaylistsPanel';
import { SearchPanel } from './components/SearchPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { ScriptsPanel } from './components/ScriptsPanel';
import { LogsPanel } from './components/LogsPanel';
import { ServerPanel } from './components/ServerPanel';

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
  const [isGeneratingRadio, setIsGeneratingRadio] = useState(false);
  const [isSkipping,  setIsSkipping]  = useState(false);
  const isSkippingRef = useRef(false);
  useEffect(() => { isSkippingRef.current = isSkipping; }, [isSkipping]);
  // Debounce guard: prevents two admin consoles (or a double-click) from
  // sending conflicting play/pause writes within the same 400ms window.
  const playPauseInFlightRef = useRef(false);

  const [players, setPlayers] = useState<Player[]>([]);
  const [kioskSessions, setKioskSessions] = useState<KioskSession[]>([]);
  const [activePlaylistName, setActivePlaylistName] = useState<string | null>(null);

  const prefs = useAdminPrefs();

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

  // Subscriptions — deps intentionally omit isSkipping; use ref to avoid subscription churn
  useEffect(() => {
    if (!user || !activePlayerId) return;
    const q  = subscribeToQueue(activePlayerId, setQueue);
    // Realtime subscription — payload-direct for state/progress, JOIN refetch only on media change.
    const s = subscribeToPlayerStatus(activePlayerId, (ns) => {
      setStatus(ns);
      if (isSkippingRef.current && (ns.state === 'playing' || ns.state === 'loading')) setIsSkipping(false);
    });
    const ps = subscribeToPlayerSettings(activePlayerId, setSettings);
    return () => {
      q.unsubscribe();
      s.unsubscribe();
      ps.unsubscribe();
    };
  }, [user, activePlayerId]);

  // Subscribe to ALL of the admin's player records so Connected Devices shows every
  // device (priority + slaves). Re-subscribes whenever the available jukebox list changes.
  useEffect(() => {
    if (!user || !availableJukeboxes.length) return;
    const playerIds = availableJukeboxes.map(j => j.player_id);
    getPlayersByIds(playerIds).then(setPlayers).catch(console.error);
    const subs = playerIds.map(pid =>
      subscribeToPlayer(pid, updated =>
        setPlayers(prev => {
          const idx = prev.findIndex(p => p.id === updated.id);
          if (idx === -1) return [...prev, updated];
          const next = [...prev]; next[idx] = updated; return next;
        })
      )
    );
    return () => subs.forEach(s => s.unsubscribe());
  }, [user, availableJukeboxes]);

  // Kiosk sessions — scoped to the currently-viewed jukebox.
  // Realtime fires on any row change; 60 s interval is a fallback in case
  // the realtime event is missed (e.g. first heartbeat after page load).
  useEffect(() => {
    if (!user || !activePlayerId) return;
    const fetch = () => getKioskSessions(activePlayerId).then(setKioskSessions).catch(console.error);
    fetch();
    const kSub = subscribeToTable<KioskSession>(
      'kiosk_sessions',
      { column: 'player_id', value: activePlayerId },
      fetch
    );
    const poll = setInterval(fetch, 60_000);
    return () => { kSub.unsubscribe(); clearInterval(poll); };
  }, [user, activePlayerId]);

  // Derive active playlist name from the current jukebox's active_playlist_id
  const activePlayer = players.find(p => p.id === activePlayerId) ?? null;
  useEffect(() => {
    if (!activePlayer?.active_playlist_id) { setActivePlaylistName(null); return; }
    getPlaylistById(activePlayer.active_playlist_id)
      .then(pl => setActivePlaylistName(pl?.name ?? null))
      .catch(() => setActivePlaylistName(null));
  }, [activePlayer?.active_playlist_id]);

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

  const handleStartRadio = async (source: 'now_playing' | 'history' | 'playlist') => {
    setIsGeneratingRadio(true);
    try {
      const result = await callRadioGenerator({
        player_id: activePlayerId ?? PLAYER_ID,
        action: 'generate',
        source,
      });
      console.log('[Radio] Generated:', result);
    } catch (e) { console.error('[Radio] Failed:', e); }
    finally { setIsGeneratingRadio(false); }
  };

  const handlePlayPause = async () => {
    // Guard 1: don't allow during a skip
    if (isSkipping) return;
    // Guard 2: debounce — block if a play/pause call is already in-flight.
    // This absorbs double-clicks and near-simultaneous clicks from two open
    // admin consoles. 400ms covers the Supabase Realtime round-trip so the
    // second console's UI updates before it can fire a conflicting write.
    if (playPauseInFlightRef.current) return;
    // Guard 3: only valid from playing, paused, or idle — ignore clicks during
    // loading/error where toggling makes no sense. Allow idle to force-play.
    const currentState = status?.state;
    if (currentState !== 'playing' && currentState !== 'paused' && currentState !== 'idle') return;

    playPauseInFlightRef.current = true;
    try {
      // If idle, force-play by setting to 'playing'
      // Otherwise toggle between playing and paused
      const newState = currentState === 'idle' ? 'playing' : currentState === 'playing' ? 'paused' : 'playing';
      await callPlayerControl({
        player_id: activePlayerId ?? PLAYER_ID,
        state: newState,
        action: 'update',
        // Compare-and-swap: server rejects the write if DB state has already
        // changed (i.e. the other admin console got there first).
        expected_state: currentState,
      } as any);
    } catch (e) {
      console.error('[Admin] Play/pause failed:', e);
    } finally {
      // Hold the lock for 400ms — long enough for Realtime to deliver the
      // state change to both consoles, preventing a toggle-loop.
      setTimeout(() => { playPauseInFlightRef.current = false; }, 400);
    }
  };

  const handleSkip = async () => {
    if (isSkipping) return;
    setIsSkipping(true);
    // Optimistic: remove current item locally so it disappears immediately
    const currentMediaId = status?.current_media_id;
    const currentQueueItem = queue.find(q => q.media_item_id === currentMediaId);
    if (currentMediaId) {
      setQueue(prev => prev.filter(q => q.media_item_id !== currentMediaId));
    }
    try { await callPlayerControl({ player_id: activePlayerId ?? PLAYER_ID, state: 'idle', action: 'skip', queue_id: currentQueueItem?.id }); }
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
        players={players} activePlayerId={activePlayerId ?? undefined}
        kioskSessions={kioskSessions} activePlaylistName={activePlaylistName}
        onPlayPause={handlePlayPause} onSkip={handleSkip} isSkipping={isSkipping} onRemove={handleRemove} />

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <Sidebar view={view} setView={setView} queue={queue} user={user}
          onSignOut={() => signOut().catch(console.error)}
          jukeboxes={availableJukeboxes} activeJukeboxSlug={resolvedJukeboxSlug}
          onSwitchJukebox={handleSwitchJukebox} onCreateJukebox={handleCreateJukebox} />

        <main style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
          {view === 'search' && <SearchPanel playerId={activePlayerId} />}
          {isQueueView && (
            <QueuePanel queue={queue} status={status}
              onRemove={handleRemove} onReorder={handleReorder}
              onShuffle={handleShuffle} isShuffling={isShuffling}
              onStartRadio={handleStartRadio} isGeneratingRadio={isGeneratingRadio}
              hasNowPlaying={!!status?.current_media_id}
              hasActivePlaylist={!!activePlayer?.active_playlist_id} />
          )}
          {isPlaylistView && <PlaylistsPanel view={view} playerId={activePlayerId} activePlaylistId={activePlayer?.active_playlist_id ?? undefined} />}
          {isScriptsView  && <ScriptsPanel playerId={activePlayerId} />}
          {isSettingsView && !isScriptsView && <SettingsPanel view={view} settings={settings} prefs={prefs} playerId={activePlayerId} />}
          {view === 'logs' && <LogsPanel />}
          {view === 'server' && <ServerPanel />}
        </main>
      </div>
    </div>
  );
}

export default App;
