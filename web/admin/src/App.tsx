// Obie Admin Console v2 — XState v5 refactor
//
// Before: 8 useState, 3 useRef (isSkippingRef, playPauseInFlightRef, isSkipping sync),
//         5 subscribeToX calls creating 5+ separate Supabase channels, 5 useEffect
// After : useActor(adminMachine) — all state, guards, and subscriptions owned by machine.
//         One Supabase channel per active player (`admin:${playerId}`).

import { useEffect, useCallback } from 'react';
import { useActor } from '@xstate/react';
import { signOut, subscribeToAuth, createJukebox, getMyJukeboxes, getPlaylistById } from '@shared/supabase-client';
import type { AuthUser } from '@shared/supabase-client';
import { normalizeJukeboxSlug, getPathJukeboxSlug } from '@shared/jukebox-utils';
import type { DragEndEvent } from '@dnd-kit/core';

import type { ViewId } from './types';
import { useState } from 'react';
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

import { adminMachine } from './state/adminMachine';

function App() {
  const [view, setView] = useState<ViewId>('queue');
  const prefs = useAdminPrefs();

  // ── Machine ────────────────────────────────────────────────────────────────
  const [snapshot, send] = useActor(adminMachine, {
    input: { routeSlug: getPathJukeboxSlug() },
  });

  const ctx = snapshot.context;
  // snapshot.matches() with parallel states requires the full nested value;
  // reading snapshot.value directly is simpler and type-safe for parallel machines.
  const sv = snapshot.value as Record<string, unknown>;
  const isAuthLoading = sv.auth === 'loading';
  const isResolving   = sv.auth === 'resolving';
  const isError       = sv.auth === 'error';

  // ── Auth subscription (bridge Supabase auth → machine) ────────────────────
  useEffect(() => {
    const sub = subscribeToAuth((user) => send({ type: 'AUTH_CHANGE', user }));
    return () => sub.unsubscribe();
  }, [send]);

  // ── Route changes ──────────────────────────────────────────────────────────
  useEffect(() => {
    const handlePopState = () =>
      send({ type: 'ROUTE_CHANGE', slug: getPathJukeboxSlug() });
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [send]);

  // ── Navigate on resolution ─────────────────────────────────────────────────
  useEffect(() => {
    if (ctx.activeJukeboxSlug && ctx.activeJukeboxSlug !== getPathJukeboxSlug()) {
      window.history.replaceState(null, '', `/${ctx.activeJukeboxSlug}`);
    }
  }, [ctx.activeJukeboxSlug]);

  // ── Active playlist name (derived from players) ───────────────────────────
  const activePlayer = ctx.players.find(p => p.id === ctx.activePlayerId) ?? null;
  useEffect(() => {
    if (!activePlayer?.active_playlist_id) return;
    getPlaylistById(activePlayer.active_playlist_id)
      .then(pl => send({ type: 'PLAYLIST_NAME_LOADED' as any, name: pl?.name ?? null }))
      .catch(() => {});
  }, [activePlayer?.active_playlist_id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Create jukebox (imperative, side-effect only) ─────────────────────────
  const handleCreateJukebox = useCallback(async () => {
    const entered = window.prompt('Enter new jukebox name (A-Z, 0-9, underscore, dash):');
    const slug = normalizeJukeboxSlug(entered);
    if (!slug) return;
    try {
      await createJukebox(slug, slug);
      await getMyJukeboxes(); // Refresh is handled by SWITCH_JUKEBOX re-resolve
      send({ type: 'SWITCH_JUKEBOX', slug });
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to create jukebox');
    }
  }, [send]);

  // ── Early returns ──────────────────────────────────────────────────────────
  if (isAuthLoading) return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14 }}>
      <Spinner size={36} />
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted)' }}>Loading…</span>
    </div>
  );

  if (!ctx.user) return (
    <LoginForm onSignIn={(user: AuthUser) => send({ type: 'AUTH_CHANGE', user })} />
  );

  if (isError && ctx.resolveError) return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, padding: 24 }}>
      <div style={{ maxWidth: 560, textAlign: 'center', color: '#fca5a5', fontFamily: 'var(--font-display)', fontSize: 18 }}>
        {ctx.resolveError}
      </div>
      <button
        onClick={() => { window.history.pushState(null, '', '/'); send({ type: 'ROUTE_CHANGE', slug: '' }); }}
        style={{ padding: '10px 16px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.06)', color: '#fff', cursor: 'pointer' }}>
        Choose Another Jukebox
      </button>
    </div>
  );

  if (isResolving || !ctx.activePlayerId) return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14 }}>
      <Spinner size={36} />
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted)' }}>Resolving player…</span>
    </div>
  );

  const isQueueView    = view.startsWith('queue');
  const isPlaylistView = view.startsWith('playlists');
  const isSettingsView = view.startsWith('settings');
  const isScriptsView  = view === 'settings-scripts';

  return (
    <div style={{ width: '100%', height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg)' }}>
      <NowPlayingStage
        status={ctx.status}
        queue={ctx.queue}
        settings={ctx.settings}
        players={ctx.players}
        activePlayerId={ctx.activePlayerId ?? undefined}
        kioskSessions={ctx.kioskSessions}
        activePlaylistName={ctx.activePlaylistName}
        onPlayPause={() => send({ type: 'PLAY_PAUSE' })}
        onSkip={() => send({ type: 'SKIP' })}
        isSkipping={ctx.isSkipping}
        onRemove={(queueId) => send({ type: 'REMOVE_QUEUE_ITEM', queueId })}
      />

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <Sidebar
          view={view}
          setView={setView}
          queue={ctx.queue}
          user={ctx.user}
          onSignOut={() => signOut().then(() => send({ type: 'SIGN_OUT' })).catch(console.error)}
          jukeboxes={ctx.availableJukeboxes}
          activeJukeboxSlug={ctx.activeJukeboxSlug}
          onSwitchJukebox={(slug) => send({ type: 'SWITCH_JUKEBOX', slug })}
          onCreateJukebox={handleCreateJukebox}
        />

        <main style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
          {view === 'search' && <SearchPanel playerId={ctx.activePlayerId} />}
          {isQueueView && (
            <QueuePanel
              queue={ctx.queue}
              status={ctx.status}
              onRemove={(queueId) => send({ type: 'REMOVE_QUEUE_ITEM', queueId })}
              onReorder={(event: DragEndEvent) => send({ type: 'REORDER_QUEUE', event })}
              onShuffle={() => send({ type: 'SHUFFLE' })}
              isShuffling={ctx.isShuffling}
              onStartRadio={(source) => send({ type: 'START_RADIO', source })}
              isGeneratingRadio={ctx.isGeneratingRadio}
              hasNowPlaying={!!ctx.status?.current_media_id}
              hasActivePlaylist={!!activePlayer?.active_playlist_id}
            />
          )}
          {isPlaylistView && (
            <PlaylistsPanel
              view={view}
              playerId={ctx.activePlayerId}
              activePlaylistId={activePlayer?.active_playlist_id ?? undefined}
            />
          )}
          {isScriptsView  && <ScriptsPanel playerId={ctx.activePlayerId} />}
          {isSettingsView && !isScriptsView && (
            <SettingsPanel view={view} settings={ctx.settings} prefs={prefs} playerId={ctx.activePlayerId} />
          )}
          {view === 'logs'   && <LogsPanel />}
          {view === 'server' && <ServerPanel />}
        </main>
      </div>
    </div>
  );
}

export default App;
