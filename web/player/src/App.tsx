/**
 * Obie Player — Server-First Queue Advancement
 *
 * Queue progression is server-controlled via the complete_and_advance RPC.
 * The player calls the RPC directly and immediately loads the next item from
 * the result — it does NOT wait for Realtime subscriptions. The RPC is the
 * single source of truth for queue state transitions.
 *
 * Architecture:
 *   complete_and_advance RPC   — atomic queue completion + next-item selection
 *   useReducer(playbackMachine) — single source of truth for player phase
 *   usePlayerRealtime           — Supabase subscriptions for admin commands + status
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

import { ResolvingScreen, StatusOverlays } from './components/IdentityScreens';
import { JukeboxDashboard } from './components/JukeboxDashboard';
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
const DIRECT_VIDEO_EXT_RE = /\.(mp4|webm|ogg|m3u8)(\?.*)?$/i;

function App() {
  // ── Identity ───────────────────────────────────────────────────────────────
  const { activePlayerId, identityReady, playerId: PLAYER_ID, navigateToJukebox } = usePlayerIdentity({
    defaultPlayerId: DEFAULT_PLAYER_ID,
  });

  // ── Core state ─────────────────────────────────────────────────────────────
  const [playback, dispatch] = useReducer(playbackReducer, { phase: 'idle' } as PlaybackPhase);
  const [currentMedia, setCurrentMedia] = useState<MediaItem | null>(null);
  const [status, setStatus] = useState<PlayerStatus | null>(null);
  const [settings, setSettings] = useState<PlayerSettings | null>(null);
  const [localVideoUrl, setLocalVideoUrl] = useState<string | null>(null);
  const [currentQueueId, setCurrentQueueId] = useState<string | null>(null);
  const [identifyOverlay, setIdentifyOverlay] = useState<{ displayName: string } | null>(null);

  // Debug logging for player state
  useEffect(() => {
    console.log('[PLAYER STATE]', {
      playbackPhase: playback.phase,
      currentQueueId,
      currentMediaId: currentMedia?.id,
      playerId: PLAYER_ID,
    });
  }, [playback.phase, currentQueueId, currentMedia?.id, PLAYER_ID]);

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
  const [initialSyncInProgress, setInitialSyncInProgress] = useState(false);

  // ── Fade ───────────────────────────────────────────────────────────────────
  const { fadeOut, fadeIn, snapSilent } = useFade({
    ytPlayerRef: { current: ytPlayerRef.current } as any,
    containerRef,
  });

  // ── Status reporting ────────────────────────────────────────────────────────
  const reportStatus = useCallback(async (state: PlayerStatus['state'], progress?: number) => {
    if (!PLAYER_ID) return;
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
    if (!PLAYER_ID || !currentQueueId) return;

    const sendHeartbeat = async () => {
      try {
        // Determine playback state
        let state = 'idle';
        if (playback.phase === 'playing') state = 'playing';
        else if (playback.phase === 'paused') state = 'paused';
        else if (playback.phase === 'ending') state = 'ended';
        else if (playback.phase === 'loading') state = 'buffering';

        await supabase.rpc('player_heartbeat', {
          p_queue_id: currentQueueId,
          p_state: state,
        } as any);
      } catch (e) {
        console.warn('[Player] Heartbeat failed:', e);
      }
    };

    sendHeartbeat(); // immediate on mount
    const id = setInterval(sendHeartbeat, 10000); // 10s interval as per spec
    return () => clearInterval(id);
  }, [PLAYER_ID, currentQueueId, playback.phase]);

  // ── Playback position tracking ─────────────────────────────────────────────
  useEffect(() => {
    if (!PLAYER_ID || !currentQueueId || playback.phase !== 'playing') return;

    const updatePlaybackPosition = async () => {
      try {
        const currentTime = (ytPlayerRef.current as any)?.getCurrentTime ? (ytPlayerRef.current as any).getCurrentTime() : 0;
        const duration = currentMedia?.duration || 0;

        if (duration > 0) {
          const position = Math.min(Math.max(currentTime / duration, 0), 1);

          await supabase.rpc('update_playback_position', {
            p_queue_id: currentQueueId,
            p_position: position
          } as any);
        }
      } catch (error) {
        console.error('[Player] Failed to update playback position:', error);
      }
    };

    // Update position every 5 seconds
    const id = setInterval(updatePlaybackPosition, 5000);
    return () => clearInterval(id);
  }, [PLAYER_ID, currentQueueId, playback.phase, currentMedia?.duration]);

  // ── Karaoke ────────────────────────────────────────────────────────────────
  useKaraokeLyrics({
    enabled: !!settings?.karaoke_mode,
    currentMedia,
    playerRef: { current: ytPlayerRef.current } as any,
    currentMediaIdRef: { current: currentMedia?.id ?? null },
  });

  // ── Queue advance — server-first via complete_and_advance RPC ────────────
  // Calls the RPC directly and immediately loads the next item from the result.
  // Does NOT wait for Realtime — the RPC result IS the source of truth.
  const advanceQueue = useCallback(async () => {
    if (!PLAYER_ID || !currentQueueId) {
      console.warn('[PLAYER] No current queue ID to advance');
      return;
    }

    console.log('[PLAYER] Advancing queue, completing:', currentQueueId);
    try {
      // Guard against stale queue IDs (can happen after recovery/race updates).
      const { data: existingQueueRow } = await supabase
        .from('queue')
        .select('id')
        .eq('id', currentQueueId)
        .maybeSingle();

      if (!existingQueueRow) {
        console.warn('[PLAYER] Stale queue_id detected, re-syncing currently playing row');
        const { data: playingRow } = await supabase
          .from('queue')
          .select('id')
          .eq('player_id', PLAYER_ID)
          .eq('status', 'playing')
          .maybeSingle();
        const playingRowAny = playingRow as any;
        if (playingRowAny?.id) {
          setCurrentQueueId(playingRowAny.id);
        } else {
          dispatch({ type: 'QUEUE_EXHAUSTED' });
        }
        return;
      }

      const { data, error } = await supabase.rpc('complete_and_advance', {
        p_queue_id: currentQueueId,
      } as any);
      if (error) throw error;

      const result = data as any;

      if (result?.status === 'success' && result?.next_id) {
        // Queue advanced — immediately load next item
        console.log('[PLAYER] Queue advanced to:', result.next_id);
        setCurrentQueueId(result.next_id);

        const { data: mediaData } = await supabase
          .from('media_items')
          .select('*')
          .eq('id', result.next_media_item_id)
          .single();

        if (mediaData) {
          const media: MediaItem = {
            id: (mediaData as any).id,
            title: (mediaData as any).title ?? 'Unknown',
            artist: (mediaData as any).artist ?? 'Unknown',
            url: (mediaData as any).url,
            duration: (mediaData as any).duration ?? 0,
            source_id: (mediaData as any).source_id ?? '',
            source_type: (mediaData as any).source_type as any,
            thumbnail: (mediaData as any).thumbnail,
            fetched_at: (mediaData as any).fetched_at,
            metadata: (mediaData as any).metadata ?? {},
          };
          setCurrentMedia(media);
          dispatch({ type: 'QUEUE_NEXT_STARTED', mediaId: media.id, isAfterSkip: false });
        }
      } else if (result?.status === 'ignored') {
        // Duplicate call — item already completed. Sync with DB to find what's playing.
        console.log('[PLAYER] Item already completed, syncing with DB');
        const { data: playingItem } = await supabase
          .from('queue')
          .select('id, media_item_id')
          .eq('player_id', PLAYER_ID)
          .eq('status', 'playing')
          .maybeSingle();

        if (playingItem) {
          setCurrentQueueId((playingItem as any).id);
          const { data: mediaData } = await supabase
            .from('media_items')
            .select('*')
            .eq('id', (playingItem as any).media_item_id)
            .single();
          if (mediaData) {
            const media: MediaItem = {
              id: (mediaData as any).id,
              title: (mediaData as any).title ?? 'Unknown',
              artist: (mediaData as any).artist ?? 'Unknown',
              url: (mediaData as any).url,
              duration: (mediaData as any).duration ?? 0,
              source_id: (mediaData as any).source_id ?? '',
              source_type: (mediaData as any).source_type as any,
              thumbnail: (mediaData as any).thumbnail,
              fetched_at: (mediaData as any).fetched_at,
              metadata: (mediaData as any).metadata ?? {},
            };
            setCurrentMedia(media);
            dispatch({ type: 'QUEUE_NEXT_STARTED', mediaId: media.id, isAfterSkip: false });
          }
        } else {
          dispatch({ type: 'QUEUE_EXHAUSTED' });
        }
      } else {
        // Queue genuinely exhausted
        console.log('[PLAYER] Queue exhausted');
        dispatch({ type: 'QUEUE_EXHAUSTED' });
      }
    } catch (error) {
      console.error('[PLAYER] Failed to advance queue:', error);
    }
  }, [currentQueueId, dispatch, PLAYER_ID]);

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
    if (!PLAYER_ID || playback.phase !== 'idle' || autoRadioRef.current) return;
    autoRadioRef.current = true;
    callRadioGenerator({ player_id: PLAYER_ID, action: 'generate', source: 'history' })
      .catch(async (e) => {
        // First-run jukeboxes may have no play history yet.
        // Fallback to playlist-based radio generation before giving up.
        const message = e instanceof Error ? e.message : String(e);
        if (/no play history/i.test(message)) {
          try {
            await callRadioGenerator({ player_id: PLAYER_ID, action: 'generate', source: 'playlist' });
            return;
          } catch (fallbackError) {
            console.error('[App] Auto-radio playlist fallback failed:', fallbackError);
          }
        }
        console.error('[App] Auto-radio failed:', e);
      })
      .finally(() => { autoRadioRef.current = false; });
  }, [playback.phase, PLAYER_ID]);

  // ── Failsafe watchdog: detect and recover stuck playback ───────────────────
  useEffect(() => {
    if (!PLAYER_ID) return;

    const watchdogInterval = setInterval(async () => {
      const { data } = await supabase
        .from('queue')
        .select('*')
        .eq('player_id', PLAYER_ID)
        .eq('status', 'playing')
        .maybeSingle();

      if (!data) return;

      const started = new Date((data as any).started_at).getTime();
      const now = Date.now();
      const MAX_DURATION = 15 * 60 * 1000; // 15 min fallback

      if (now - started > MAX_DURATION) {
        console.warn('[WATCHDOG] Playback stuck → forcing advance:', (data as any).id);
        try {
          await supabase.rpc('complete_and_advance', {
            p_queue_id: (data as any).id,
          } as any);
        } catch (error) {
          console.error('[WATCHDOG] Failed to force advance:', error);
        }
      }
    }, 30000); // Check every 30 seconds

    return () => clearInterval(watchdogInterval);
  }, [PLAYER_ID]);

  // ── Offline recovery: periodically call recover_stalled_playback ───────────────
  useEffect(() => {
    if (!PLAYER_ID) return;

    const recoveryInterval = setInterval(async () => {
      try {
        await supabase.rpc('recover_stalled_playback', {
          p_player_id: PLAYER_ID,
        } as any);
      } catch (error) {
        console.error('[RECOVERY] Failed to recover stalled playback:', error);
      }
    }, 60000); // Check every 60 seconds

    return () => clearInterval(recoveryInterval);
  }, [PLAYER_ID]);

  // ── Realtime subscriptions ─────────────────────────────────────────────────
  const handleStatusUpdate = useCallback(async (newStatus: PlayerStatus) => {
    if (!PLAYER_ID) return;
    setStatus(newStatus);

    // Media changed externally (admin load, skip, etc.)
    if (newStatus.current_media_id && newStatus.current_media_id !== currentMedia?.id) {
      if (newStatus.current_media) {
        setCurrentMedia(newStatus.current_media);
        dispatch({ type: 'QUEUE_NEXT_STARTED', mediaId: newStatus.current_media_id, isAfterSkip: false });
      } else {
        // Media not included in payload - fetch it immediately to avoid delay
        console.log('[PLAYER] Fetching media item for:', newStatus.current_media_id);
        const { data: mediaData } = await supabase
          .from('media_items')
          .select('*')
          .eq('id', newStatus.current_media_id)
          .single();

        if (mediaData) {
          const media: MediaItem = {
            id: (mediaData as any).id,
            title: (mediaData as any).title ?? 'Unknown',
            artist: (mediaData as any).artist ?? 'Unknown',
            url: (mediaData as any).url,
            duration: (mediaData as any).duration ?? 0,
            source_id: (mediaData as any).source_id ?? '',
            source_type: (mediaData as any).source_type as any,
            thumbnail: (mediaData as any).thumbnail,
            fetched_at: (mediaData as any).fetched_at,
            metadata: (mediaData as any).metadata ?? {},
          };
          setCurrentMedia(media);
          dispatch({ type: 'QUEUE_NEXT_STARTED', mediaId: media.id, isAfterSkip: false });
        }
      }

      // Also fetch the queue item to get queue_id.
      // Use a bounded list query (not .single()) to avoid 406 noise when a
      // row temporarily doesn't exist in 'playing' state yet.
      console.log('[PLAYER] Fetching queue item for current media:', newStatus.current_media_id);
      const { data: queueRows } = await supabase
        .from('queue')
        .select('id,status,requested_at')
        .eq('player_id', PLAYER_ID)
        .eq('media_item_id', newStatus.current_media_id)
        .is('played_at', null)
        .order('requested_at', { ascending: false })
        .limit(1);

      if (queueRows && queueRows.length > 0) {
        console.log('[PLAYER] Setting currentQueueId:', (queueRows[0] as any).id);
        setCurrentQueueId((queueRows[0] as any).id);
      }
    }

    // Source mode switching
    if ((newStatus.source === 'local' || newStatus.source === 'cloudflare') && newStatus.local_url) {
      setLocalVideoUrl(newStatus.local_url);
    } else if (newStatus.source === 'youtube') {
      setLocalVideoUrl(null);
    }
  }, [currentMedia?.id, dispatch]);

  // ── Identify overlay subscription ───────────────────────────────────────────
  useEffect(() => {
    if (!PLAYER_ID) return;

    const channel = supabase
      .channel('identify_events')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'event_log',
          filter: `event_type=eq.identify_player AND player_id=eq.${PLAYER_ID}`,
        },
        (payload) => {
          const newRecord = payload.new as any;
          const displayName = newRecord.payload?.display_name || 'Player';
          console.log('[IDENTIFY] Display overlay:', displayName);
          setIdentifyOverlay({ displayName });

          // Auto-hide after 5 seconds
          setTimeout(() => {
            setIdentifyOverlay(null);
          }, 5000);
        }
      )
      .subscribe();

    console.log('[IDENTIFY] Subscription active for player:', PLAYER_ID);

    return () => {
      supabase.removeChannel(channel);
      console.log('[IDENTIFY] Subscription removed');
    };
  }, [PLAYER_ID]);

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
          const oldRecord = payload.old as any;
          console.log('[SYNC] Queue update received:', newRecord);

          // Ignore no-op updates where the row remained in playing state
          // (e.g. reorder position updates) to avoid restarting current media.
          if (newRecord.status === 'playing' && oldRecord?.status === 'playing') {
            return;
          }

          // If an item transitions to 'playing', load it
          if (newRecord.status === 'playing' && newRecord.media_item_id) {
            // Prevent duplicate loads: if we're already playing this item, ignore
            if (currentQueueId === newRecord.id) {
              console.log('[SYNC] Duplicate load prevented - already playing:', newRecord.id);
              return;
            }

            console.log('[SYNC] Switching to new video:', newRecord.id);
            setCurrentQueueId(newRecord.id);

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
                  console.log('[SYNC] Media loaded:', media.id);
                }
              });
          }
        }
      )
      .subscribe();

    console.log('[SYNC] Queue subscription active for player:', PLAYER_ID);

    return () => {
      supabase.removeChannel(channel);
      console.log('[SYNC] Queue subscription removed');
    };
  }, [PLAYER_ID, dispatch, currentQueueId]);

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
    initialSyncInProgress,
  });

  // ── Load video when media changes ─────────────────────────────────────────
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!currentMedia || isYTMMode || isLocalMode) return;
    if (DIRECT_VIDEO_EXT_RE.test(currentMedia.url)) {
      // Some queues provide direct mp4/webm URLs via media_items.url.
      // Route these through LocalVideoPlayer rather than YouTube iframe mode.
      setLocalVideoUrl(currentMedia.url);
      return;
    }
    const isSkip = isAfterSkipPhase(playback);
    if (isSkip) snapSilent();
    ytPlayerRef.current?.loadVideo(currentMedia.url, isSkip);
  }, [currentMedia?.id]); // Intentionally only on media ID change

  // ── Sync DB + issue player commands on phase transitions ──────────────────
  useEffect(() => {
    if (playback.phase === 'playing') {
      reportStatus('playing');
      if (!isYTMMode && !isLocalMode) {
        ytPlayerRef.current?.resume();
      }
      if (ytPlayerRef.current?.getVolume() === 0) fadeIn();
    } else if (playback.phase === 'paused') {
      reportStatus('paused');
      if (!isYTMMode && !isLocalMode) {
        fadeOut().then(() => ytPlayerRef.current?.pause());
      }
    } else if (playback.phase === 'ending' && playback.reason === 'skip') {
      // Fade out on skip before advancing to next video
      if (!isYTMMode && !isLocalMode) {
        fadeOut();
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
    if (!PLAYER_ID) return;
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

  // ── Initial sync: load current playing item on startup ─────────────────────
  const syncInitialState = useCallback(async () => {
    if (!PLAYER_ID) return;

    console.log('[PLAYER] Syncing initial state...');
    setInitialSyncInProgress(true);

    // Wait for YouTube API to be ready before attempting to load
    const maxWaitTime = 10000; // 10 seconds max wait
    const startTime = Date.now();
    while (!window.YT && Date.now() - startTime < maxWaitTime) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    if (!window.YT) {
      console.warn('[PLAYER] YouTube API not ready after 10s, skipping initial sync');
      setInitialSyncInProgress(false);
      return;
    }

    const { data, error } = await supabase
      .from('queue')
      .select('*')
      .eq('player_id', PLAYER_ID)
      .eq('status', 'playing')
      .maybeSingle();

    if (error) {
      console.error('[PLAYER] Initial sync failed', error);
      setInitialSyncInProgress(false);
      return;
    }

    if (data && (data as any).id) {
      console.log('[PLAYER] Found active playback item:', (data as any).id);
      setCurrentQueueId((data as any).id);

      // Fetch the full media item
      const { data: mediaData } = await supabase
        .from('media_items')
        .select('*')
        .eq('id', (data as any).media_item_id)
        .single();

      if (mediaData) {
        const media: MediaItem = {
          id: (mediaData as any).id,
          title: (mediaData as any).title ?? 'Unknown',
          artist: (mediaData as any).artist ?? 'Unknown',
          url: (mediaData as any).url,
          duration: (mediaData as any).duration ?? 0,
          source_id: (mediaData as any).source_id ?? '',
          source_type: (mediaData as any).source_type as any,
          thumbnail: (mediaData as any).thumbnail,
          fetched_at: (mediaData as any).fetched_at,
          metadata: (mediaData as any).metadata ?? {},
        };
        setCurrentMedia(media);
        dispatch({ type: 'QUEUE_NEXT_STARTED', mediaId: media.id, isAfterSkip: false });

        // Resume from saved position if available
        const savedPosition = (data as any).playback_position || 0;
        if (savedPosition > 0 && media.duration && media.duration > 0) {
          const startTime = savedPosition * media.duration;
          console.log('[PLAYER] Resuming from saved position:', startTime, 'seconds');
          // Seek to saved position after video loads
          setTimeout(() => {
            if (ytPlayerRef.current) {
              (ytPlayerRef.current as any).seekTo(startTime);
            }
          }, 2000); // Wait for video to load
        }
      }
    } else {
      console.log('[PLAYER] No active playback on startup');
    }

    // Clear the flag after sync completes
    setTimeout(() => {
      setInitialSyncInProgress(false);
    }, 2000); // Give 2s buffer for video to actually start
  }, [PLAYER_ID, dispatch]);

  // ── Initialization ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!identityReady || !activePlayerId || hasInitRef.current) return;
    hasInitRef.current = true;

    (async () => {
      try {
        await initializePlayerPlaylist(activePlayerId);
        await syncInitialState();
        console.log('[App] Player initialized');
      } catch (err) {
        console.error('[App] Initialization failed:', err);
      }
    })();
  }, [identityReady, activePlayerId, syncInitialState]);

  // ── Early returns ──────────────────────────────────────────────────────────
  if (!identityReady) return <ResolvingScreen />;
  if (!activePlayerId) return <JukeboxDashboard onSelectJukebox={navigateToJukebox} />;

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
      />

      {/* Identify overlay */}
      {identifyOverlay && (
        <div
          style={{
            position: 'absolute',
            bottom: '20%',
            left: '50%',
            transform: 'translateX(-50%)',
            color: 'white',
            fontSize: '48px',
            fontWeight: 'bold',
            textShadow: '2px 2px 4px black, -2px -2px 4px black, 2px -2px 4px black, -2px 2px 4px black',
            opacity: 0.5,
            pointerEvents: 'none',
            zIndex: 100,
            fontFamily: 'var(--font-display)',
          }}
        >
          {identifyOverlay.displayName}
        </div>
      )}
    </div>
  );
}

export default App;
