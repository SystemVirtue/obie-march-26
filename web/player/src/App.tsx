/**
 * Obie Player — Server-Authority Refactor
 *
 * Queue progression is now entirely server-controlled via complete_and_advance RPC.
 * No master/slave system - all players can report completion safely.
 * Database enforces atomic transitions and prevents race conditions.
 *
 * Architecture:
 *   useReducer(playbackMachine) — single source of truth for player phase
 *   Direct RPC call              — complete_and_advance for queue progression
 *   usePlayerRealtime           — Supabase subscriptions for queue/player status
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
} from '../../shared/supabase-client';

import { ResolvingScreen, JukeboxNamePrompt, StatusOverlays } from './components/IdentityScreens';
import { YouTubePlayer, type YouTubePlayerHandle } from './players/YouTubePlayer';
import { LocalVideoPlayer, type LocalVideoPlayerHandle } from './players/LocalVideoPlayer';
import { YTMDesktopPlayer } from './players/YTMDesktopPlayer';
import { usePlayerIdentity } from './hooks/usePlayerIdentity';
import { useKaraokeLyrics } from './hooks/useKaraokeLyrics';
import { usePlayerRealtime } from './hooks/usePlayerRealtime';
import { useLoadingGuard } from './hooks/useLoadingGuard';
import { useFade } from './hooks/useFade';
import {
  playbackReducer,
  isAfterSkip as isAfterSkipPhase,
  type PlaybackPhase,
} from './state/playbackMachine';

const DEFAULT_PLAYER_ID = import.meta.env.VITE_PLAYER_ID || '00000000-0000-0000-0000-000000000001';
const PLAYER_JUKEBOX_STORAGE_KEY = 'obie_player_jukebox_slug';

function App() {
  // ── Identity ───────────────────────────────────────────────────────────────
  const { activePlayerId, identityReady, playerId: PLAYER_ID } = usePlayerIdentity({
    defaultPlayerId: DEFAULT_PLAYER_ID,
    storageKey: PLAYER_JUKEBOX_STORAGE_KEY,
  });

  // ── Core state ─────────────────────────────────────────────────────────────
  const [playback, dispatch] = useReducer(playbackReducer, { phase: 'idle' } as PlaybackPhase);
  const [currentMedia, setCurrentMedia] = useState<MediaItem | null>(null);
  const [status, setStatus] = useState<PlayerStatus | null>(null);
  const [settings, setSettings] = useState<PlayerSettings | null>(null);
  const [localVideoUrl, setLocalVideoUrl] = useState<string | null>(null);

  // ── Derived ────────────────────────────────────────────────────────────────
  const playerMode = settings?.player_mode ?? 'iframe';
  const isYTMMode = playerMode === 'ytm_desktop';
  const isLocalMode = !!localVideoUrl;

  // ── Refs ───────────────────────────────────────────────────────────────────
  const ytPlayerRef = useRef<YouTubePlayerHandle | null>(null);
  const localPlayerRef = useRef<LocalVideoPlayerHandle | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hasInitRef = useRef(false);
  const autoRadioRef = useRef(false);

  // ── Fade ───────────────────────────────────────────────────────────────────
  const { fadeOut, fadeIn, snapSilent } = useFade({
    ytPlayerRef: { current: ytPlayerRef.current } as any,
    containerRef,
  });

  // ── Status reporting ────────────────────────────────────────────────────────
  const reportStatus = useCallback(async (state: PlayerStatus['state'], progress?: number) => {
    console.log('[Player] Reporting status:', { state, progress });
    try {
      await callPlayerControl({
        player_id: PLAYER_ID,
        state,
        progress,
        action: 'update',
      });
    } catch (error) {
      console.error('[Player] Failed to report status:', error);
    }
  }, [PLAYER_ID]);

  // ── Heartbeat ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!PLAYER_ID) return;

    const sendHeartbeat = async () => {
      try {
        await callPlayerControl({ player_id: PLAYER_ID, action: 'heartbeat' });
      } catch (e) {
        console.warn('[Player] Heartbeat failed:', e);
      }
    };

    sendHeartbeat(); // immediate on mount
    const id = setInterval(sendHeartbeat, 30000); // 30s interval
    return () => clearInterval(id);
  }, [PLAYER_ID]);

  // ── Karaoke ────────────────────────────────────────────────────────────────
  useKaraokeLyrics({
    enabled: !!settings?.karaoke_mode,
    currentMedia,
    playerRef: { current: ytPlayerRef.current } as any,
    currentMediaIdRef: { current: currentMedia?.id ?? null },
  });

  // ── Queue advance — direct RPC call to complete_and_advance ───────────────
  const advanceQueue = useCallback(async () => {
    if (!currentMedia?.id) {
      console.warn('[Player] No current media ID to advance');
      return;
    }

    console.log('[Player] Calling complete_and_advance for media:', currentMedia.id);
    try {
      const { data, error } = await supabase.rpc('complete_and_advance', {
        p_media_id: currentMedia.id,
      } as any);
      if (error) throw error;
      const result = (data?.[0] as any);
      if (result) {
        console.log('[Player] Queue advanced to next media:', result.title);
      } else {
        console.log('[Player] Queue exhausted');
        dispatch({ type: 'QUEUE_EXHAUSTED' });
      }
    } catch (error) {
      console.error('[Player] Failed to advance queue:', error);
    }
  }, [PLAYER_ID, currentMedia?.id, dispatch]);

  // Trigger advance when machine enters 'ending'
  useEffect(() => {
    if (playback.phase === 'ending' && !playback.inFlight) {
      dispatch({ type: 'ADVANCE_IN_FLIGHT' });
      advanceQueue().then(() => {
        dispatch({ type: 'ADVANCE_COMPLETE' });
      }).catch(() => {
        dispatch({ type: 'ADVANCE_COMPLETE' });
      });
    }
  }, [playback, advanceQueue, dispatch]);

  // ── Auto-radio: refill queue when empty ───────────────────────────────────
  useEffect(() => {
    if (playback.phase !== 'idle' || autoRadioRef.current) return;
    autoRadioRef.current = true;
    callRadioGenerator({ player_id: PLAYER_ID, action: 'generate', source: 'history' })
      .catch((e) => console.error('[App] Auto-radio failed:', e))
      .finally(() => { autoRadioRef.current = false; });
  }, [playback.phase, PLAYER_ID]);

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
  }, [currentMedia?.id, dispatch]);

  // ── Queue subscription for server-controlled progression ───────────────────
  useEffect(() => {
    if (!PLAYER_ID) return;

    const channel = supabase
      .channel('queue_updates')
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'queue',
          filter: `player_id=eq.${PLAYER_ID}`,
        },
        (payload) => {
          const newRecord = payload.new as any;
          console.log('[Player] Queue update:', newRecord);

          // If an item transitions to 'playing', load it
          if (newRecord.status === 'playing' && newRecord.media_item_id) {
            // Fetch the full media item
            supabase
              .from('media_items')
              .select('*')
              .eq('id', newRecord.media_item_id)
              .single()
              .then(({ data }) => {
                if (data) {
                  const media: MediaItem = {
                    id: (data as any).id,
                    title: (data as any).title ?? 'Unknown',
                    artist: (data as any).artist ?? 'Unknown',
                    url: (data as any).url,
                    duration: (data as any).duration ?? 0,
                    source_id: (data as any).source_id ?? '',
                    source_type: (data as any).source_type as any,
                    thumbnail: (data as any).thumbnail,
                    fetched_at: (data as any).fetched_at,
                    metadata: (data as any).metadata ?? {},
                  };
                  setCurrentMedia(media);
                  dispatch({ type: 'QUEUE_NEXT_STARTED', mediaId: media.id, isAfterSkip: false });
                }
              });
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [PLAYER_ID, dispatch]);

  const handleSettingsUpdate = useCallback((s: PlayerSettings) => setSettings(s), []);

  usePlayerRealtime({
    playerId: PLAYER_ID,
    identityReady,
    activePlayerId,
    dispatch,
    onStatusUpdate: handleStatusUpdate,
    onSettingsUpdate: handleSettingsUpdate,
  });

  // ── Loading guard: auto-skip stuck videos ─────────────────────────────────
  useLoadingGuard({
    playback,
    dispatch,
    getYTPlayerState: useCallback(() => ytPlayerRef.current?.getPlayerState() ?? null, []),
    reportPlaying: useCallback(() => reportStatus('playing'), [reportStatus]),
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

  // ── Auto-resume from 'user' pauses (transient YouTube pauses) ───────────────
  // YouTube fires PAUSED events transiently during load and sometimes at end of video.
  // We only persist 'admin' pauses (explicit user action). 'user' pauses auto-resume
  // after 2 seconds unless the video has actually ended.
  useEffect(() => {
    if (playback.phase === 'paused' && playback.pausedBy === 'user') {
      const timer = setTimeout(() => {
        // Only resume if still in 'user' paused state (not ended, not admin paused)
        if (playback.phase === 'paused' && playback.pausedBy === 'user') {
          console.log('[App] Auto-resuming from transient user pause');
          dispatch({ type: 'ADMIN_RESUME' });
          ytPlayerRef.current?.resume();
        }
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [playback.phase, dispatch]);

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
        console.log('[App] Player initialized');
      } catch (err) {
        console.error('[App] Initialization failed:', err);
      }
    })();
  }, [identityReady, activePlayerId, PLAYER_ID]);

  // ── Early returns ──────────────────────────────────────────────────────────
  if (!identityReady) return <ResolvingScreen />;
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
          onAdminPause={() => { }}
          onAdminResume={() => { }}
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
        isSlavePlayer={false}
        isMasterOffline={false}
      />
    </div>
  );
}

export default App;
