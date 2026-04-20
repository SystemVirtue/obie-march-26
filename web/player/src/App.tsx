/**
 * Obie Player — App.tsx (XState v5 refactor)
 *
 * Before: useReducer + 8 useRef guards + 13 useEffect + 3 advance paths
 * After : useActor(obiePlayerMachine) + 4 focused useEffects
 *
 * The machine owns all state transitions and actors. React owns:
 *   • Imperative YouTube/Local/YTM player refs (non-serialisable)
 *   • Volume/opacity fade (browser API)
 *   • Queue-advance orchestration (1 effect, the only advance path)
 *   • Phase-sync to DB + player commands (1 effect per concern)
 */

import { useEffect, useRef, useCallback } from 'react';
import { useActor } from '@xstate/react';
import {
  supabase,
  callPlaylistManager,
  callQueueManager,
  callRadioGenerator,
  callPlayerControl,
  type MediaItem,
} from '@shared/supabase-client';

import { ResolvingScreen, JukeboxNamePrompt, StatusOverlays } from './components/IdentityScreens';
import { PriorityClaimModal } from './components/PriorityClaimModal';
import { YouTubePlayer, type YouTubePlayerHandle  } from './players/YouTubePlayer';
import { LocalVideoPlayer, type LocalVideoPlayerHandle } from './players/LocalVideoPlayer';
import { YTMDesktopPlayer } from './players/YTMDesktopPlayer';
import { usePlayerIdentity } from './hooks/usePlayerIdentity';
import { useKaraokeLyrics }  from './hooks/useKaraokeLyrics';
import { useFade }           from './hooks/useFade';

import {
  obiePlayerMachine,
  selectCanAdvance,
  selectNeedsFadeBeforeAdvance,
} from './state/obiePlayerMachine';

const DEFAULT_PLAYER_ID          = import.meta.env.VITE_PLAYER_ID || '00000000-0000-0000-0000-000000000001';
const PLAYER_JUKEBOX_STORAGE_KEY = 'obie_player_jukebox_slug';

function App() {
  // ── Identity (unchanged hook) ──────────────────────────────────────────────
  const { activePlayerId, identityReady, playerId: PLAYER_ID } = usePlayerIdentity({
    defaultPlayerId: DEFAULT_PLAYER_ID,
    storageKey: PLAYER_JUKEBOX_STORAGE_KEY,
  });

  // ── Stable session ID for this tab ────────────────────────────────────────
  const sessionIdRef = useRef<string>(crypto.randomUUID());

  // ── XState machine ────────────────────────────────────────────────────────
  const [snapshot, send] = useActor(obiePlayerMachine, {
    input: {
      playerId:  PLAYER_ID,
      sessionId: sessionIdRef.current,
    },
  });

  const ctx = snapshot.context;
  const isEnding    = snapshot.matches({ playback: 'ending' });
  const isPlaying   = snapshot.matches({ playback: 'playing' });
  const isPaused    = snapshot.matches({ playback: 'paused' });
  const isReady     = snapshot.matches({ coordination: 'ready' }) ||
                      snapshot.matches({ coordination: 'claiming' });

  // ── Derived ────────────────────────────────────────────────────────────────
  const playerMode  = ctx.settings?.player_mode ?? 'iframe';
  const isYTMMode   = playerMode === 'ytm_desktop';
  const isLocalMode = !!ctx.localVideoUrl;

  // ── Player refs ────────────────────────────────────────────────────────────
  const ytPlayerRef    = useRef<YouTubePlayerHandle | null>(null);
  const localPlayerRef = useRef<LocalVideoPlayerHandle | null>(null);
  const containerRef   = useRef<HTMLDivElement>(null);
  const autoRadioRef   = useRef(false);

  // ── Fade (stays in React — needs ytPlayerRef + containerRef) ──────────────
  const { fadeOut, fadeIn, snapSilent } = useFade({
    ytPlayerRef: { current: ytPlayerRef.current } as any,
    containerRef,
  });

  // ── Karaoke (unchanged hook) ───────────────────────────────────────────────
  useKaraokeLyrics({
    enabled: !!ctx.settings?.karaoke_mode,
    currentMedia: ctx.currentMedia,
    playerRef: { current: ytPlayerRef.current } as any,
    currentMediaIdRef: { current: ctx.currentMediaId },
  });

  // ── Report status callback (needed by advance + phase effects) ────────────
  const prevReportedStateRef = useRef<string | null>(null);

  const reportStatus = useCallback(async (
    state: 'playing' | 'paused' | 'idle' | 'loading' | 'error',
    progress?: number,
  ) => {
    if (!ctx.isMaster) return;

    const isProgressOnly = state === prevReportedStateRef.current && progress !== undefined;
    if (isProgressOnly) return; // Broadcast path handled by heartbeatActor for progress

    prevReportedStateRef.current = state;
    try {
      await callPlayerControl({ player_id: PLAYER_ID, state, action: 'update' });
    } catch (e) {
      console.error('[reportStatus] failed:', e);
    }
  }, [ctx.isMaster, PLAYER_ID]);

  // ── Effect 1: Queue advance ────────────────────────────────────────────────
  // Single consolidated advance path. Only fires when machine is in 'ending'
  // and no advance is in-flight. Guards are delegated to the machine.
  useEffect(() => {
    if (!isEnding || !selectCanAdvance(ctx) || !ctx.isMaster) return;

    send({ type: 'ADVANCE_IN_FLIGHT' });

    const doAdvance = async () => {
      const needsFade = selectNeedsFadeBeforeAdvance(ctx);
      if (needsFade) {
        try { await fadeOut(); } catch {}
      }

      try {
        const { data: freshStatus } = await supabase
          .from('player_status')
          .select('current_media_id')
          .eq('player_id', PLAYER_ID)
          .single();

        const result = await callPlayerControl({
          player_id:        PLAYER_ID,
          state:            'idle',
          progress:         1,
          action:           'ended',
          current_media_id: freshStatus?.current_media_id ?? ctx.currentMediaId ?? undefined,
        });

        if (result?.next_item) {
          const next = result.next_item;
          const media: MediaItem = {
            id:          next.media_item_id ?? next.id,
            title:       next.title ?? 'Unknown',
            artist:      next.artist ?? 'Unknown',
            url:         next.url,
            duration:    next.duration ?? 0,
            source_id:   next.source_id ?? '',
            source_type: next.source_type ?? 'youtube',
            thumbnail:   next.thumbnail ?? null,
            fetched_at:  new Date().toISOString(),
            metadata:    next.metadata ?? {},
          };
          send({
            type:        'QUEUE_NEXT_STARTED',
            mediaId:     media.id,
            media,
            isAfterSkip: ctx.endReason === 'skip',
          });
        } else {
          send({ type: 'QUEUE_EXHAUSTED' });
        }
      } catch {
        send({ type: 'QUEUE_EXHAUSTED' });
      }
    };

    doAdvance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEnding, ctx.inFlight, ctx.isMaster]);

  // ── Effect 2: Auto-radio when queue empties ────────────────────────────────
  useEffect(() => {
    const isIdle = snapshot.matches({ playback: 'idle' });
    if (!isIdle || autoRadioRef.current || !ctx.isMaster) return;
    autoRadioRef.current = true;
    callRadioGenerator({ player_id: PLAYER_ID, action: 'generate', source: 'history' })
      .catch((e) => console.error('[App] Auto-radio failed:', e))
      .finally(() => { autoRadioRef.current = false; });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.value, ctx.isMaster]);

  // ── Effect 3: Load video when media changes ────────────────────────────────
  // Intentionally dep-array on media ID only — same as original hook convention.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!ctx.currentMedia || isYTMMode || isLocalMode) return;
    if (ctx.isAfterSkip) snapSilent();
    ytPlayerRef.current?.loadVideo(ctx.currentMedia.url, ctx.isAfterSkip);
  }, [ctx.currentMediaId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Effect 4: Sync DB state + issue player commands on phase transitions ───
  useEffect(() => {
    if (isPlaying) {
      reportStatus('playing');
      if (ytPlayerRef.current?.getVolume() === 0) fadeIn();
    } else if (isPaused) {
      reportStatus('paused');
      if (!isYTMMode && !isLocalMode) {
        fadeOut().then(() => ytPlayerRef.current?.pause());
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, isPaused]);

  // ── Unplayable video handler ───────────────────────────────────────────────
  const handleUnplayableVideo = useCallback(async (mediaId: string) => {
    try {
      const { data: queueItem } = await supabase
        .from('queue')
        .select('id')
        .eq('media_item_id', mediaId)
        .eq('player_id', PLAYER_ID)
        .maybeSingle();

      if (queueItem) {
        await callQueueManager({ player_id: PLAYER_ID, action: 'remove', queue_id: (queueItem as any).id });
      }
      await callPlaylistManager({ action: 'remove_media_globally', player_id: PLAYER_ID, media_item_id: mediaId });
    } catch (err) {
      console.error('[App] Failed to remove unplayable video:', err);
    }
  }, [PLAYER_ID]);

  // ── Early returns ──────────────────────────────────────────────────────────
  if (!identityReady)  return <ResolvingScreen />;
  if (!activePlayerId) return <JukeboxNamePrompt />;
  if (!isReady)        return <ResolvingScreen />;

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
          dispatch={(action) => send(action as any)}
          onPlaying={() => { if (ytPlayerRef.current?.getVolume() === 0) fadeIn(); }}
          onUnplayableVideo={handleUnplayableVideo}
          currentMediaId={ctx.currentMediaId}
          visible={!isYTMMode && !isLocalMode}
        />
      </div>

      {/* Local / Cloudflare R2 */}
      {isLocalMode && ctx.localVideoUrl && (
        <LocalVideoPlayer
          ref={localPlayerRef}
          src={ctx.localVideoUrl}
          dispatch={(action) => send(action as any)}
          onProgress={(progress) => reportStatus('playing', progress)}
        />
      )}

      {/* YTM Desktop overlay */}
      {isYTMMode && (
        <YTMDesktopPlayer
          currentMedia={ctx.currentMedia}
          dispatch={(action) => send(action as any)}
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

      {/* Click blocker — click-to-play when paused */}
      <div
        className="absolute inset-0 w-full h-full cursor-default"
        style={{ pointerEvents: isYTMMode ? 'none' : 'auto' }}
        onClick={(e) => {
          e.preventDefault();
          if (isPaused) {
            send({ type: 'ADMIN_RESUME' });
            ytPlayerRef.current?.resume();
          }
        }}
      />

      {/* Status overlays */}
      <StatusOverlays
        state={ctx.status?.state}
        playerReady={!snapshot.matches({ playback: 'idle' })}
        currentMedia={ctx.currentMedia}
        isSlavePlayer={!ctx.isMaster}
        isMasterOffline={ctx.isMasterOffline}
      />

      {/* Priority claim modal */}
      {ctx.showPriorityModal && (
        <PriorityClaimModal
          onClaim={async () => { send({ type: 'CLAIM_PRIORITY' }); }}
          onDecline={() => { send({ type: 'DECLINE_PRIORITY' }); }}
        />
      )}
    </div>
  );
}

export default App;
