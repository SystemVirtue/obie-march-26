/**
 * Obie Player — Refactored App.tsx
 *
 * Before: 1,637 lines, 17 useRef guards, 13 useEffect, 3 advance paths.
 * After:  ~350 lines. Single useReducer state machine. One advance path.
 *
 * Architecture:
 *   useReducer(playbackMachine) — single source of truth for player phase
 *   useQueueAdvance             — only queue_next caller
 *   usePlayerRealtime           — Supabase subscriptions + 30s poll fallback
 *   useLoadingGuard             — auto-skip for stuck/failed videos
 *   useFade                     — audio/opacity fade in/out
 *   YouTubePlayer (ref)         — iframe mode
 *   LocalVideoPlayer (ref)      — Cloudflare R2 / yt-dlp mode
 *   YTMDesktopPlayer            — YTM Desktop companion mode
 */

import { useEffect, useRef, useState, useCallback, useReducer } from 'react';
import {
  supabase,
  callPlaylistManager,
  callQueueManager,
  callRadioGenerator,
  initializePlayerPlaylist,
  callPlayerControl,
  type MediaItem,
  type PlayerStatus,
  type PlayerSettings,
} from '@shared/supabase-client';

import { ResolvingScreen, JukeboxNamePrompt, StatusOverlays } from './components/IdentityScreens';
import { YouTubePlayer, type YouTubePlayerHandle  } from './players/YouTubePlayer';
import { LocalVideoPlayer, type LocalVideoPlayerHandle } from './players/LocalVideoPlayer';
import { YTMDesktopPlayer } from './players/YTMDesktopPlayer';
import { usePlayerIdentity }  from './hooks/usePlayerIdentity';
import { usePlayerHeartbeat } from './hooks/usePlayerHeartbeat';
import { useKaraokeLyrics }   from './hooks/useKaraokeLyrics';
import { usePlayerRealtime }  from './hooks/usePlayerRealtime';
import { useQueueAdvance }    from './hooks/useQueueAdvance';
import { useLoadingGuard }    from './hooks/useLoadingGuard';
import { useFade }            from './hooks/useFade';
import {
  playbackReducer,
  isAfterSkip as isAfterSkipPhase,
  type PlaybackPhase,
} from './state/playbackMachine';

const DEFAULT_PLAYER_ID          = import.meta.env.VITE_PLAYER_ID || '00000000-0000-0000-0000-000000000001';
const PLAYER_JUKEBOX_STORAGE_KEY = 'obie_player_jukebox_slug';

function App() {
  // ── Identity ───────────────────────────────────────────────────────────────
  const { activePlayerId, identityReady, playerId: PLAYER_ID } = usePlayerIdentity({
    defaultPlayerId: DEFAULT_PLAYER_ID,
    storageKey: PLAYER_JUKEBOX_STORAGE_KEY,
  });

  // ── Core state ─────────────────────────────────────────────────────────────
  const [playback, dispatch]      = useReducer(playbackReducer, { phase: 'idle' } as PlaybackPhase);
  const [currentMedia, setCurrentMedia] = useState<MediaItem | null>(null);
  const [status, setStatus]             = useState<PlayerStatus | null>(null);
  const [settings, setSettings]         = useState<PlayerSettings | null>(null);
  const [isSlavePlayer, setIsSlavePlayer] = useState(false);
  const [localVideoUrl, setLocalVideoUrl]  = useState<string | null>(null);

  // ── Derived ────────────────────────────────────────────────────────────────
  const playerMode  = settings?.player_mode ?? 'iframe';
  const isYTMMode   = playerMode === 'ytm_desktop';
  const isLocalMode = !!localVideoUrl;

  // ── Refs ───────────────────────────────────────────────────────────────────
  const ytPlayerRef    = useRef<YouTubePlayerHandle | null>(null);
  const localPlayerRef = useRef<LocalVideoPlayerHandle | null>(null);
  const containerRef   = useRef<HTMLDivElement>(null);
  const hasInitRef     = useRef(false);
  const autoRadioRef   = useRef(false);

  // ── Fade ───────────────────────────────────────────────────────────────────
  const { fadeOut, fadeIn, snapSilent } = useFade({
    ytPlayerRef: { current: ytPlayerRef.current } as any,
    containerRef,
  });

  // ── Heartbeat / status reporting ───────────────────────────────────────────
  const { reportStatus } = usePlayerHeartbeat({ isSlavePlayer, playerId: PLAYER_ID });

  // ── Karaoke ────────────────────────────────────────────────────────────────
  useKaraokeLyrics({
    enabled: !!settings?.karaoke_mode,
    currentMedia,
    playerRef: { current: ytPlayerRef.current } as any,
    currentMediaIdRef: { current: currentMedia?.id ?? null },
  });

  // ── Queue advance — single consolidated path ───────────────────────────────
  const { advance } = useQueueAdvance({
    playerId: PLAYER_ID,
    isSlavePlayer,
    dispatch,
    fadeOut,
    onNextMedia:   (media) => setCurrentMedia(media),
    onQueueEmpty:  () => setCurrentMedia(null),
  });

  // Trigger advance when machine enters 'ending' and no call is in-flight
  useEffect(() => {
    if (playback.phase === 'ending' && !playback.inFlight) {
      advance(playback);
    }
  }, [playback, advance]);

  // ── Auto-radio: refill queue when empty ───────────────────────────────────
  useEffect(() => {
    if (playback.phase !== 'idle' || autoRadioRef.current || isSlavePlayer) return;
    autoRadioRef.current = true;
    callRadioGenerator({ player_id: PLAYER_ID, action: 'generate', source: 'history' })
      .catch((e) => console.error('[App] Auto-radio failed:', e))
      .finally(() => { autoRadioRef.current = false; });
  }, [playback.phase, PLAYER_ID, isSlavePlayer]);

  // ── Realtime subscriptions ─────────────────────────────────────────────────
  const handleStatusUpdate = useCallback((newStatus: PlayerStatus) => {
    setStatus(newStatus);

    // Media changed externally (admin load, etc.)
    if (newStatus.current_media_id && newStatus.current_media_id !== currentMedia?.id) {
      if (newStatus.current_media) {
        setCurrentMedia(newStatus.current_media);
        dispatch({ type: 'QUEUE_NEXT_STARTED', mediaId: newStatus.current_media_id, isAfterSkip: false });
      }
    }

    // Source mode switching
    if ((newStatus.source === 'local' || newStatus.source === 'cloudflare') && newStatus.local_url) {
      setLocalVideoUrl(newStatus.local_url);
    } else if (newStatus.source === 'youtube') {
      setLocalVideoUrl(null);
    }
  }, [currentMedia?.id]);

  const handleSettingsUpdate = useCallback((s: PlayerSettings) => setSettings(s), []);

  usePlayerRealtime({
    playerId: PLAYER_ID,
    identityReady,
    activePlayerId,
    dispatch,
    onStatusUpdate:   handleStatusUpdate,
    onSettingsUpdate: handleSettingsUpdate,
  });

  // ── Loading guard: auto-skip stuck videos ─────────────────────────────────
  useLoadingGuard({
    playback,
    dispatch,
    getYTPlayerState: useCallback(() => ytPlayerRef.current?.getPlayerState() ?? null, []),
    reportPlaying:    useCallback(() => reportStatus('playing'), [reportStatus]),
  });

  // ── Load video when media changes ─────────────────────────────────────────
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!currentMedia || isYTMMode || isLocalMode) return;
    const isSkip = isAfterSkipPhase(playback);
    if (isSkip) snapSilent();
    ytPlayerRef.current?.loadVideo(currentMedia.url, isSkip);
  }, [currentMedia?.id]); // Intentionally only on media ID change

  // ── Sync DB + issue player commands on phase transitions ──────────────────
  useEffect(() => {
    if (playback.phase === 'playing') {
      reportStatus('playing');
      if (ytPlayerRef.current?.getVolume() === 0) fadeIn();
    } else if (playback.phase === 'paused') {
      reportStatus('paused');
      if (!isYTMMode && !isLocalMode) {
        fadeOut().then(() => ytPlayerRef.current?.pause());
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playback.phase]);

  // ── Unplayable video removal ───────────────────────────────────────────────
  const handleUnplayableVideo = useCallback(async (mediaId: string) => {
    try {
      const { data: queueItem } = await supabase
        .from('queue')
        .select('id')
        .eq('media_item_id', mediaId)
        .eq('player_id', PLAYER_ID)
        .maybeSingle();

      if (queueItem) {
        await callQueueManager({
          player_id: PLAYER_ID,
          action: 'remove',
          queue_id: (queueItem as { id: string }).id,
        });
      }

      await callPlaylistManager({
        action: 'remove_media_globally',
        player_id: PLAYER_ID,
        media_item_id: mediaId,
      });
    } catch (err) {
      console.error('[App] Failed to remove unplayable video:', err);
    }
  }, [PLAYER_ID]);

  // ── Initialization ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!identityReady || !activePlayerId || hasInitRef.current) return;
    hasInitRef.current = true;

    (async () => {
      try {
        await initializePlayerPlaylist(PLAYER_ID);

        const sessionId      = crypto.randomUUID();
        const storedPlayerId = localStorage.getItem('obie_priority_player_id');

        const result = await callPlayerControl({
          player_id:        PLAYER_ID,
          action:           'register_session',
          session_id:       sessionId,
          stored_player_id: storedPlayerId ?? undefined,
        });

        setIsSlavePlayer(!result.is_priority);

        if (result.is_priority) {
          localStorage.setItem('obie_priority_player_id', PLAYER_ID);
        } else if (storedPlayerId === PLAYER_ID) {
          localStorage.removeItem('obie_priority_player_id');
        }
      } catch (err) {
        console.error('[App] Initialization failed:', err);
      }
    })();
  }, [identityReady, activePlayerId, PLAYER_ID]);

  // ── Early returns ──────────────────────────────────────────────────────────
  if (!identityReady)  return <ResolvingScreen />;
  if (!activePlayerId) return <JukeboxNamePrompt />;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="relative w-screen h-screen bg-black">

      {/* YouTube iframe (hidden in YTM / local modes) */}
      <div
        ref={containerRef}
        className="w-full h-full"
        style={{ display: (!isYTMMode && !isLocalMode) ? 'block' : 'none' }}
      >
        <YouTubePlayer
          ref={ytPlayerRef}
          dispatch={dispatch}
          onPlaying={() => { if (ytPlayerRef.current?.getVolume() === 0) fadeIn(); }}
          onUnplayableVideo={handleUnplayableVideo}
          currentMediaId={currentMedia?.id ?? null}
          visible={!isYTMMode && !isLocalMode}
        />
      </div>

      {/* Local / Cloudflare R2 */}
      {isLocalMode && localVideoUrl && (
        <LocalVideoPlayer
          ref={localPlayerRef}
          src={localVideoUrl}
          dispatch={dispatch}
          onProgress={(progress) => reportStatus('playing', progress)}
        />
      )}

      {/* YTM Desktop overlay */}
      {isYTMMode && (
        <YTMDesktopPlayer
          currentMedia={currentMedia}
          dispatch={dispatch}
          onAdminPause={() => {}}
          onAdminResume={() => {}}
        />
      )}

      {/* Logo */}
      <img
        src="/Obie_neon_no_BG.png"
        alt="Obie"
        className="absolute bottom-[40px] left-[20px] w-[8vw] h-auto pointer-events-none z-10"
        style={{ maxWidth: '160px', minWidth: '60px' }}
      />

      {/* Click blocker — allow click-to-play when paused, block otherwise */}
      <div
        className="absolute inset-0 w-full h-full cursor-default"
        style={{ pointerEvents: isYTMMode ? 'none' : 'auto' }}
        onClick={(e) => {
          e.preventDefault();
          if (playback.phase === 'paused') {
            dispatch({ type: 'ADMIN_RESUME' });
            ytPlayerRef.current?.resume();
          }
        }}
      />

      {/* Status overlays */}
      <StatusOverlays
        state={status?.state}
        playerReady={playback.phase !== 'idle'}
        currentMedia={currentMedia}
        isSlavePlayer={isSlavePlayer}
      />
    </div>
  );
}

export default App;
