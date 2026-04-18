// Obie Player - Thin Client for Media Playback
// Uses YouTube IFrame Player API for reliable event handling

import { useEffect, useRef, useState, useCallback } from 'react';
import { io } from 'socket.io-client';
import {
  supabase,
  subscribeToPlayerStatus,
  subscribeToPlayerSettings,
  callPlayerControl,
  callQueueManager,
  callPlaylistManager,
  callRadioGenerator,
  initializePlayerPlaylist,
  fetchMasterPlayerStatus,
  type PlayerStatus,
  type MediaItem,
  type PlayerSettings,
} from '@shared/supabase-client';
import { YTM_BASE, YTM_APP_ID, getYtmToken, saveYtmToken, ytmFetch } from './utils/ytm';
import { extractYouTubeId } from './utils/youtube';
import { ResolvingScreen, JukeboxNamePrompt, StatusOverlays } from './components/IdentityScreens';
import { usePlayerIdentity } from './hooks/usePlayerIdentity';
import { usePlayerHeartbeat } from './hooks/usePlayerHeartbeat';
import { useKaraokeLyrics } from './hooks/useKaraokeLyrics';
import {
  IS_ENDING_FALLBACK_MS,
  FADE_DURATION_MS
} from '../../shared/constants';

// Option B: Extended timeout to reduce false positives on slow YouTube API loads
const RECENTLY_LOADED_TIMEOUT_OPTION_B_MS = 8000; // Increased from ~3000 to handle slower networks

const DEFAULT_PLAYER_ID = import.meta.env.VITE_PLAYER_ID || '00000000-0000-0000-0000-000000000001';
const PLAYER_JUKEBOX_STORAGE_KEY = 'obie_player_jukebox_slug';

// YouTube Player API types
declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady: () => void;
  }
}

function App() {
  const { activePlayerId, identityReady, playerId: PLAYER_ID } = usePlayerIdentity({
    defaultPlayerId: DEFAULT_PLAYER_ID,
    storageKey: PLAYER_JUKEBOX_STORAGE_KEY,
  });
  const [status, setStatus] = useState<PlayerStatus | null>(null);
  const [currentMedia, setCurrentMedia] = useState<MediaItem | null>(null);
  const [settings, setSettings] = useState<PlayerSettings | null>(null);
  const [isSlavePlayer, setIsSlavePlayer] = useState(false); // Track if this is a slave player
  const [playerReady, setPlayerReady] = useState(false); // Track if YouTube player is ready
  const [ytApiReady, setYtApiReady] = useState(false); // Track if YouTube API is loaded
  // Slave sync state
  const [isSyncing, setIsSyncing] = useState(false); // True while seeking to master position
  const [targetSeekSeconds, setTargetSeekSeconds] = useState<number | null>(null); // Where to seek to
  const syncedMediaIdsRef = useRef<Set<string>>(new Set()); // Track which media IDs we've synced to prevent re-syncing
  const playerRef = useRef<any>(null);
  const playerDivRef = useRef<HTMLDivElement>(null);
  const hasInitialized = useRef(false);
  const currentMediaIdRef = useRef<string | null>(null);
  const fadeIntervalRef = useRef<number | null>(null);
  const isSkipLoadingRef = useRef(false); // Track if loading after skip
  const recentlyLoadedRef = useRef(false); // Track if video was recently loaded and should auto-play
  const isEndingRef = useRef(false); // In-flight guard: prevents double queue_next from concurrent calls
  const autoRadioInFlightRef = useRef(false); // Prevents duplicate auto-radio generation
  const checkAutoRadioRef = useRef<(() => void) | null>(null); // Stable ref for auto-radio check
  const loadingTimeoutRef = useRef<number | null>(null); // Timeout to skip if status stays in 'loading' for 6+ seconds
  const videoHasPlayedRef = useRef(false); // true once current video reaches YouTube state PLAYING; reset on new media
  const unexpectedPauseTimeoutRef = useRef<number | null>(null); // Timeout to auto-advance if paused before video ever played
  const adminPausedRef = useRef(false); // Track if pause was triggered by admin to prevent auto-resume
  // Stable session ID for this browser tab — generated once on mount, shared
  // between register_session (init) and usePlayerHeartbeat (priority checks).
  // Previously each generated its own UUID, causing heartbeat to demote master
  // to slave after first cycle (~30s). This ref ensures the same UUID is used.
  const sessionIdRef = useRef<string>(crypto.randomUUID());
  // ── Local video fallback (yt-dlp) ──────────────────────────────────────────
  const [localPlaybackUrl, setLocalPlaybackUrl] = useState<string | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  // Tracks the YouTube ID of the currently-loaded video (legacy reference, kept for potential future use)
  const currentYouTubeIdRef = useRef<string | null>(null);
  const lastVideoLoadTimeRef = useRef<number>(0); // Timestamp of last loadVideoById call, used to reject stale ENDED events
  const localVideoLastReportRef = useRef<number>(0); // Throttle local video progress reports
  const localPlaybackUrlRef = useRef<string | null>(null); // Mirror of localPlaybackUrl for use inside callbacks

  // YTM Desktop state
  const [ytmConnected, setYtmConnected] = useState(false);
  const [ytmError, setYtmError] = useState<string | null>(null);
  const [ytmNowPlaying, setYtmNowPlaying] = useState<{ title: string; artist: string; thumbnail: string } | null>(null);
  const [ytmAuthStep, setYtmAuthStep] = useState<'idle' | 'requesting' | 'waiting' | 'authorized'>('idle');
  const [ytmAuthCode, setYtmAuthCode] = useState<string | null>(null);
  const [ytmToken, setYtmToken] = useState<string | null>(() => localStorage.getItem('ytm_auth_token'));
  const ytmSocketRef = useRef<any>(null);
  const ytmCurrentVideoIdRef = useRef<string | null>(null);
  const ytmPlayingReportedRef = useRef(false);       // guard: report 'playing' once per video
  const ytmTrackStateRef = useRef<number | null>(null); // previous YTM trackState for transition detection
  const ytmAdminPausedRef = useRef(false);           // true while a Supabase-admin pause is in flight
  const playerModeRef = useRef<'iframe' | 'ytm_desktop'>('iframe');
  const [ytmTestResult, setYtmTestResult] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle');
  const [ytmTestMsg, setYtmTestMsg] = useState<string | null>(null);

  const { reportStatus } = usePlayerHeartbeat({
    isSlavePlayer,
    isSyncing,
    playerId: PLAYER_ID,
    sessionId: sessionIdRef.current,
    onPriorityReclaimed: useCallback(() => {
      // Dead master's priority_player_id was cleared by DB failover trigger,
      // and we've successfully reclaimed master. Flip slave flag so this player
      // resumes driving queue progression immediately — no page reload needed.
      console.log('[App] Reclaimed master — re-enabling queue progression');
      setIsSlavePlayer(false);
      localStorage.setItem('obie_priority_player_id', PLAYER_ID);
    }, [PLAYER_ID]),
    onPriorityLost: useCallback(() => {
      // Admin clicked "Reset Priority Player" (or another session claimed master).
      // Demote this player to slave immediately — stops queue progression and
      // shows the SLAVE watermark. The new master will take over within one
      // heartbeat cycle (≤ 30s) without requiring a page reload on either end.
      console.log('[App] Lost master — demoting to slave');
      setIsSlavePlayer(true);
      localStorage.removeItem('obie_priority_player_id');
    }, []),
  });

  useKaraokeLyrics({
    enabled: !!settings?.karaoke_mode,
    currentMedia,
    playerRef,
    currentMediaIdRef,
  });

  // Fade out audio and opacity over 2 seconds
  const fadeOut = useCallback((): Promise<void> => {
    return new Promise((resolve) => {
      // Only require a volume-controllable source — don't bail if playerDivRef is null
      // (YouTube IFrame API replaces the original div, so the ref can become stale).
      const ytPlayer = playerRef.current;
      const localVideo = localVideoRef.current;
      if (!ytPlayer && !localVideo) {
        resolve();
        return;
      }

      const startVolume = ((): number => {
        if (ytPlayer && typeof ytPlayer.getVolume === 'function') return ytPlayer.getVolume();
        if (ytPlayer && typeof (ytPlayer as any).volume === 'number') return (ytPlayer as any).volume * 100;
        if (localVideo) return localVideo.volume * 100;
        return 100;
      })();
      const startOpacity = 1;
      const steps = 60; // 60 fps
      const stepDuration = FADE_DURATION_MS / steps;
      let currentStep = 0;

      // Clear any existing fade
      if (fadeIntervalRef.current) {
        clearInterval(fadeIntervalRef.current);
      }

      fadeIntervalRef.current = window.setInterval(() => {
        currentStep++;
        const progress = currentStep / steps;
        const newVolume = startVolume * (1 - progress);
        const newOpacity = startOpacity * (1 - progress);

        // Fade volume on whichever source is active
        if (ytPlayer) {
          if (typeof ytPlayer.setVolume === 'function') {
            ytPlayer.setVolume(Math.max(0, newVolume));
          } else if (typeof (ytPlayer as any).volume === 'number') {
            (ytPlayer as any).volume = Math.max(0, Math.min(1, Math.max(0, newVolume) / 100));
          }
        }
        if (localVideo) {
          localVideo.volume = Math.max(0, Math.min(1, Math.max(0, newVolume) / 100));
        }
        // Opacity is cosmetic — only apply if the div ref is still valid
        if (playerDivRef.current) {
          playerDivRef.current.style.opacity = String(Math.max(0, newOpacity));
        }

        if (currentStep >= steps) {
          if (fadeIntervalRef.current) {
            clearInterval(fadeIntervalRef.current);
            fadeIntervalRef.current = null;
          }
          resolve();
        }
      }, stepDuration);
    });
  }, []);

  // YTM Desktop skip fade: step volume 100→0 over fade duration via setVolume commands
  const fadeOutYtm = useCallback((): Promise<void> => {
    return new Promise((resolve) => {
      const steps = 10;
      const stepDuration = FADE_DURATION_MS / steps;
      let currentStep = 0;
      const interval = window.setInterval(() => {
        currentStep++;
        const vol = Math.round(100 * (1 - currentStep / steps));
        ytmFetch('/api/v1/command', {
          method: 'POST',
          body: JSON.stringify({ command: 'setVolume', data: vol }),
        }).catch(() => {});
        if (currentStep >= steps) {
          clearInterval(interval);
          resolve();
        }
      }, stepDuration);
    });
  }, []);

  // Fade in audio and opacity over 2 seconds
  const fadeIn = useCallback((): Promise<void> => {
    return new Promise((resolve) => {
      const ytPlayer = playerRef.current;
      const localVideo = localVideoRef.current;
      if (!ytPlayer && !localVideo) {
        resolve();
        return;
      }

      const targetVolume = 100;
      const targetOpacity = 1;
      const steps = 60; // 60 fps
      const stepDuration = FADE_DURATION_MS / steps;
      let currentStep = 0;

      // Clear any existing fade
      if (fadeIntervalRef.current) {
        clearInterval(fadeIntervalRef.current);
      }

      fadeIntervalRef.current = window.setInterval(() => {
        currentStep++;
        const progress = currentStep / steps;
        const newVolume = targetVolume * progress;
        const newOpacity = targetOpacity * progress;

        if (ytPlayer) {
          if (typeof ytPlayer.setVolume === 'function') {
            ytPlayer.setVolume(Math.min(100, newVolume));
          } else if (typeof (ytPlayer as any).volume === 'number') {
            (ytPlayer as any).volume = Math.min(1, Math.max(0, Math.min(100, newVolume) / 100));
          }
        }
        if (localVideo) {
          localVideo.volume = Math.min(1, Math.max(0, newVolume / 100));
        }
        if (playerDivRef.current) {
          playerDivRef.current.style.opacity = String(Math.min(1, newOpacity));
        }

        if (currentStep >= steps) {
          if (fadeIntervalRef.current) {
            clearInterval(fadeIntervalRef.current);
            fadeIntervalRef.current = null;
          }
          resolve();
        }
      }, stepDuration);
    });
  }, []);

  // Auto-generate radio from history when queue has no remaining items
  const checkAndTriggerAutoRadio = useCallback(async () => {
    if (autoRadioInFlightRef.current || !activePlayerId) return;

    try {
      const { data: remaining, error } = await supabase
        .from('queue')
        .select('id')
        .eq('player_id', PLAYER_ID)
        .limit(1);

      if (!error && (!remaining || remaining.length === 0)) {
        autoRadioInFlightRef.current = true;
        try {
          await callRadioGenerator({
            player_id: PLAYER_ID,
            action: 'generate',
            source: 'history',
          });
        } catch (radioErr) {
          console.error('[Player] Auto-radio generation failed:', radioErr);
        } finally {
          autoRadioInFlightRef.current = false;
        }
      }
    } catch (err) {
      console.error('[Player] Failed to check remaining queue:', err);
    }
  }, [activePlayerId, PLAYER_ID]);
  checkAutoRadioRef.current = checkAndTriggerAutoRadio;

  // Report video ended and trigger queue_next (disabled for slave players)
  const reportEndedAndNext = useCallback(async (isSkip = false) => {
    // Slave players do not trigger queue operations
    if (isSlavePlayer) return;

    // Prevent concurrent calls: natural end + status subscription can both fire simultaneously.
    if (isEndingRef.current) return;
    isEndingRef.current = true;

    // Fade out if this is a skip
    if (isSkip) {
      if (playerModeRef.current === 'ytm_desktop') {
        // YTM Desktop: fade volume to 0, pause, then restore volume for next track
        await fadeOutYtm();
        await ytmFetch('/api/v1/command', { method: 'POST', body: JSON.stringify({ command: 'pause' }) }).catch(() => {});
        ytmFetch('/api/v1/command', { method: 'POST', body: JSON.stringify({ command: 'setVolume', data: 100 }) }).catch(() => {});
      } else if (localPlaybackUrlRef.current) {
        // Local/Cloudflare playback uses an HTMLVideoElement — fade audio then stop.
        const localVideo = localVideoRef.current;
        if (localVideo) {
          try {
            // Fade out audio over 1 second before stopping
            const steps = 20;
            const interval = 1000 / steps;
            const startVol = localVideo.volume;
            for (let i = 1; i <= steps; i++) {
              await new Promise(r => setTimeout(r, interval));
              localVideo.volume = Math.max(0, startVol * (1 - i / steps));
            }
            localVideo.pause();
            localVideo.currentTime = 0;
            localVideo.removeAttribute('src');
            localVideo.load();
          } catch (error) {
            console.warn('[Player] Failed to fade/stop local/Cloudflare video on skip:', error);
          }
        }
        setLocalPlaybackUrl(null);
      } else {
        await fadeOut();
      }
      // Set skip-loading flag NOW — before the async callPlayerControl — so that
      // the YouTube loading effect sees it even if the Supabase Realtime event for
      // state='loading' (fired by queue_next's DB write) arrives before the HTTP
      // response from callPlayerControl returns.  Without this, the race causes
      // the new video to load at setVolume(100) instead of 0, silently undoing
      // the fade-out that just completed.
      if (isSkip) {
        isSkipLoadingRef.current = true;
      }
    }

    try {
      const expectedMediaId = currentMediaIdRef.current || null;
      const applyNextItem = (candidate: { next_item?: { media_item_id: string; title: string; url: string; duration?: number } }): boolean => {
        if (!candidate?.next_item) return false;

        const nextMedia: MediaItem = {
          id: candidate.next_item.media_item_id,
          title: candidate.next_item.title || 'Unknown',
          artist: 'Unknown',
          url: candidate.next_item.url,
          duration: candidate.next_item.duration || 0,
          source_id: '',
          source_type: 'youtube',
          thumbnail: null,
          fetched_at: new Date().toISOString(),
          metadata: {},
        };
        setCurrentMedia(nextMedia);

        // Mark that video was recently loaded and should auto-play if it pauses unexpectedly
        recentlyLoadedRef.current = true;
        // Clear the flag after 5 seconds
        setTimeout(() => {
          recentlyLoadedRef.current = false;
        }, 5000);

        // For normal end: restore opacity immediately
        if (!isSkip && playerDivRef.current) {
          playerDivRef.current.style.opacity = '1';
        }

        return true;
      };

      const result = await callPlayerControl({
        player_id: PLAYER_ID,
        state: 'idle',
        progress: 1,
        action: 'ended', // Always use 'ended' after fade completes to trigger queue_next
        current_media_id: expectedMediaId || undefined, // Idempotency: server skips if already advanced
      });
      if (applyNextItem(result)) {
        return;
      }

      // If queue_next returned empty but DB is still stuck on the same media in idle,
      // perform one retry without expected_media_id to recover from stale-id races.
      const { data: latestStatusRaw, error: latestStatusError } = await supabase
        .from('player_status')
        .select('state,current_media_id')
        .eq('player_id', PLAYER_ID)
        .maybeSingle();
      const latestStatus = latestStatusRaw as { state: string | null; current_media_id: string | null } | null;

      if (!latestStatusError) {
        const stillIdleOnSameMedia =
          latestStatus?.state === 'idle' &&
          (!expectedMediaId || latestStatus.current_media_id === expectedMediaId);

        if (!stillIdleOnSameMedia) {
          // DB has already advanced to a new state (e.g. 'loading' from a concurrent
          // queue_next) or current_media_id changed.  The idempotency guard correctly
          // blocked our call — the Realtime subscription will deliver the new song.
          // Do NOT null out currentMedia here: doing so would blank the player display
          // even though the next song is already queued and loading.
          return;
        }

        if (stillIdleOnSameMedia) {
          const retryResult = await callPlayerControl({
            player_id: PLAYER_ID,
            state: 'idle',
            progress: 1,
            action: 'ended',
          });

          if (applyNextItem(retryResult)) {
            return;
          }
        }
      }

      // No video loaded — clear the skip-loading flag so the next natural end
      // doesn't incorrectly apply a fade-in to a non-skip transition.
      isSkipLoadingRef.current = false;
      setCurrentMedia(null);
    } catch (error) {
      console.error('[Player] Failed to call queue_next:', error);
      // On error, clear the skip-loading flag to avoid a stale true value
      // affecting the next video load.
      isSkipLoadingRef.current = false;
    } finally {
      // Do NOT reset isEndingRef on a short timer.  Instead, keep the guard active
      // until the next video actually starts PLAYING (reset in onPlayerStateChange
      // PLAYING handler and local-video onPlay).  A 10-second fallback covers edge
      // cases where the next video never reaches PLAYING (e.g. unplayable/error).
      //
      // The old 1-second cooldown was too short — YouTube fires stale ENDED events
      // 2-3 seconds after loadVideoById, slipping past the guard and causing a
      // double queue_next that desyncs "now playing" from the actual playback.
      setTimeout(() => {
        if (isEndingRef.current) {
          isEndingRef.current = false;
        }
      }, IS_ENDING_FALLBACK_MS);
    }
  }, [fadeOut, fadeOutYtm, isSlavePlayer, PLAYER_ID]);

  // YouTube Player event handlers
  const onPlayerReady = useCallback(() => {
    setPlayerReady(true);

    // Slave sync: Attempt to seek to master's current position
    if (isSyncing && targetSeekSeconds !== null && playerRef.current) {
      const seekSeconds = Math.floor(targetSeekSeconds);
      console.log('[Slave Sync] YouTube player ready — seeking to', seekSeconds, 'seconds');

      try {
        playerRef.current.seekTo(seekSeconds, true); // true = allow seek ahead
        console.log('[Slave Sync] YouTube seekTo() called, marking media as synced');
        setIsSyncing(false);
        setTargetSeekSeconds(null);
      } catch (error) {
        console.warn('[Slave Sync] YouTube seekTo() failed:', error);
        // Fallback: just play without seeking
        setIsSyncing(false);
        setTargetSeekSeconds(null);
      }

      // Timeout: if seek doesn't confirm within 500ms, assume it failed (e.g., live stream)
      const timeout = setTimeout(() => {
        console.warn('[Slave Sync] YouTube seek confirmation timeout — assuming live stream or unsupported');
        setIsSyncing(false);
        setTargetSeekSeconds(null);
      }, 500);

      return () => clearTimeout(timeout);
    }
  }, [isSyncing, targetSeekSeconds]);

  const onPlayerStateChange = useCallback((event: { data: number }) => {
    // Ignore YouTube events when a Cloudflare/local video is active
    if (localPlaybackUrlRef.current) return;

    // YouTube Player States:
    // -1 = UNSTARTED
    // 0 = ENDED
    // 1 = PLAYING
    // 2 = PAUSED
    // 3 = BUFFERING
    // 5 = CUED

    if (event.data === 1) {
      // PLAYING
      videoHasPlayedRef.current = true;
      if (isEndingRef.current) isEndingRef.current = false;
      reportStatus('playing');

      // Proactively generate radio if this is the last song in queue
      checkAutoRadioRef.current?.();

      // If we're at volume 0 (after skip), fade in
      if (playerRef.current) {
        const currentVol = ((): number => {
          if (typeof playerRef.current.getVolume === 'function') return playerRef.current.getVolume();
          if (typeof (playerRef.current as any).volume === 'number') return (playerRef.current as any).volume * 100;
          return 100;
        })();
        if (currentVol === 0) fadeIn();
      }
    } else if (event.data === 2) {
      // PAUSED
      // Option B: Player-online continuous playback enforcement
      // If player is online, never allow pause — auto-resume immediately.
      // This implements radio-like continuous playback: error => auto-resume; stalled => skip.

      // If the video hasn't played yet, this is a transient loading pause (YouTube
      // fires PAUSED right after loadVideoById before playVideo() has been called).
      // Auto-resume without reporting to DB.
      if (!videoHasPlayedRef.current) {
        if (playerRef.current && typeof playerRef.current.playVideo === 'function') {
          try {
            playerRef.current.playVideo();
            recentlyLoadedRef.current = false;
          } catch {
            // Silent fail - will report paused below
          }
        }
      } else {
        // Video has played before — could be a genuine pause OR unexpected mid-load pause.
        //
        // IMPORTANT: Do NOT call reportStatus('paused') before playVideo() when we intend
        // to immediately resume. If we do, the 'paused' DB write can arrive at the server
        // AFTER the subsequent 'playing' write (HTTP jitter), leaving the DB permanently
        // stuck in 'paused'. The status-sync effect then enforces that by calling
        // pauseVideo() — causing the video to freeze indefinitely.
        // 
        // Option B logic (Pause Only When Offline):
        // - Player app is inherently "online" if executing code, so always auto-resume
        //   unless admin explicitly paused or if recently loaded (transient pause)
        const shouldAutoResume = !adminPausedRef.current && recentlyLoadedRef.current;
        
        if (shouldAutoResume && playerRef.current && typeof playerRef.current.playVideo === 'function') {
          try {
            playerRef.current.playVideo();
            recentlyLoadedRef.current = false;
          } catch {
            reportStatus('paused');
          }
        } else {
          // No auto-resume: admin paused or not recently loaded
          reportStatus('paused');
        }
      }
    } else if (event.data === 0) {
      // ENDED - trigger queue progression.
      // Guard: YouTube fires stale ENDED events 2-3 s after loadVideoById for the
      // previous video.  These arrive after the new video's PLAYING event has
      // already reset isEndingRef, so isEndingRef alone cannot block them.
      // Option B: Use extended timeout to account for slower YouTube API loads.
      const msSinceLoad = Date.now() - lastVideoLoadTimeRef.current;
      if (msSinceLoad < RECENTLY_LOADED_TIMEOUT_OPTION_B_MS) return;
      reportEndedAndNext();
    } else if (event.data === 3) {
      // BUFFERING
      reportStatus('loading');
    }
  }, [reportStatus, reportEndedAndNext, fadeIn]);

  // Handle playback errors — any YouTube player error skips immediately to the next video.
  // Error codes:
  //   2   = Invalid parameter (age-restricted or bad video ID)
  //   5   = HTML5 player error (network, decoding)
  //   100 = Video not found or private  → also removes it from queue/playlists
  //   101 = Embedding not allowed by owner
  //   150 = Same as 101 (embedding not allowed by owner)
  const onPlayerError = useCallback(async (event: any) => {
    // Ignore YouTube errors when a Cloudflare/local video is active
    if (localPlaybackUrlRef.current) return;

    if (isSlavePlayer) return;

    // Error codes that mean the video can never play (deleted, private, or embedding blocked).
    // Remove from queue and all playlists so they never come up again.
    const UNPLAYABLE_ERROR_CODES = [100, 101, 150];
    if (UNPLAYABLE_ERROR_CODES.includes(event.data)) {
      const unavailableMediaId = currentMediaIdRef.current;
      if (unavailableMediaId) {
        try {
          const { data: queueItem, error: queueError } = await supabase
            .from('queue')
            .select('id')
            .eq('media_item_id', unavailableMediaId)
            .eq('player_id', PLAYER_ID)
            .maybeSingle();

          if (!queueError && queueItem) {
            await callQueueManager({
              player_id: PLAYER_ID,
              action: 'remove',
              queue_id: (queueItem as { id: string }).id,
            });
          }

          await callPlaylistManager({
            action: 'remove_media_globally',
            player_id: PLAYER_ID,
            media_item_id: unavailableMediaId,
          });
        } catch {
          // Silent fail - already logged at higher level
        }
      }
    }

    // Skip immediately for all error codes.
    // Do not rely on the 4-second loading timeout: a YouTube PAUSED event often
    // fires just before the error, causing the server status to land in 'paused'
    // (via an async race between reportStatus calls), which cancels the timeout
    // and leaves the player stuck indefinitely.
    //
    // Also clear isEndingRef before calling reportEndedAndNext. An errored video
    // will never reach PLAYING state (which is the normal isEndingRef clear point),
    // so without this reset the guard stays true for the full 10-second fallback
    // window and silently drops the skip, leaving the player stuck in Loading.
    isEndingRef.current = false;
    reportEndedAndNext(false);
  }, [isSlavePlayer, reportEndedAndNext]);

  // Load YouTube IFrame API
  useEffect(() => {
    if (ytApiReady) return;

    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    const firstScriptTag = document.getElementsByTagName('script')[0];
    firstScriptTag.parentNode?.insertBefore(tag, firstScriptTag);

    window.onYouTubeIframeAPIReady = () => setYtApiReady(true);
  }, [ytApiReady]);

  // Initialize player with default playlist
  useEffect(() => {
    if (!identityReady || !activePlayerId) return;

    const initPlayer = async () => {
      if (hasInitialized.current) return;
      hasInitialized.current = true;

      try {
        const result = await initializePlayerPlaylist(PLAYER_ID) as { success?: boolean; playlist_name?: string; loaded_count?: number };

        if (!result?.success) {
          console.warn('[Player] No playlist available');
        }

        // Register this player instance as a potential priority player
        const storedPlayerId = localStorage.getItem('obie_priority_player_id');
        
        const sessionResult = await callPlayerControl({
          player_id: PLAYER_ID,
          action: 'register_session',
          session_id: sessionIdRef.current,
          stored_player_id: storedPlayerId || undefined,
        });

        // Store whether this player is a slave (not priority)
        setIsSlavePlayer(!sessionResult.is_priority);
        
        // If this player became priority, store its ID in localStorage
        if (sessionResult.is_priority) {
          localStorage.setItem('obie_priority_player_id', PLAYER_ID);
        } else if (storedPlayerId === PLAYER_ID) {
          localStorage.removeItem('obie_priority_player_id');
        }
      } catch (error) {
        console.error('[Player] Failed to initialize:', error);
      }
    };

    initPlayer();
  }, [identityReady, activePlayerId, PLAYER_ID]);

  // Slave player sync: Fetch master player status and seek to current position
  // This runs once on app init if this is a slave player
  useEffect(() => {
    if (!identityReady || !activePlayerId || !isSlavePlayer) return;

    const syncSlaveToMaster = async () => {
      console.log('[Slave Sync] Attempting to sync with master player...');
      const masterStatus = await fetchMasterPlayerStatus(PLAYER_ID);

      if (!masterStatus) {
        console.log('[Slave Sync] Master status unavailable, skipping sync');
        return;
      }

      // Guard: only sync if master is actively playing
      if (masterStatus.state !== 'playing') {
        console.log('[Slave Sync] Master not playing, skipping sync');
        return;
      }

      // Guard: only sync if progress is past the start
      if (!masterStatus.progress || masterStatus.progress <= 0) {
        console.log('[Slave Sync] Master at start of video, no sync needed');
        return;
      }

      // Guard: don't re-sync the same media_id in this session
      const mediaId = masterStatus.current_media_id;
      if (!mediaId || syncedMediaIdsRef.current.has(mediaId)) {
        console.log('[Slave Sync] Already synced this media_id, skipping');
        return;
      }

      // Calculate target seek position (0 if duration unavailable)
      const duration = masterStatus.current_media?.duration;
      const elapsedSeconds = masterStatus.progress * (duration ?? 0);
      console.log('[Slave Sync] Master at', {
        progress: masterStatus.progress,
        duration: duration ?? 'unknown',
        elapsedSeconds: elapsedSeconds.toFixed(1),
        source: masterStatus.source,
      });

      // Mark as synced to prevent re-sync on Realtime updates
      syncedMediaIdsRef.current.add(mediaId);

      // Store seek target and begin sync phase
      setTargetSeekSeconds(elapsedSeconds);
      setIsSyncing(true);

      // Auto-clear sync state after 3 seconds (fail-safe)
      setTimeout(() => {
        setIsSyncing(false);
        setTargetSeekSeconds(null);
      }, 3000);
    };

    syncSlaveToMaster().catch(error => {
      console.error('[Slave Sync] Sync failed:', error);
      setIsSyncing(false);
      setTargetSeekSeconds(null);
    });
  }, [identityReady, activePlayerId, isSlavePlayer, PLAYER_ID]);

  // NOTE: Shuffle-on-load is handled entirely by the load_playlist RPC (migration 0028).
  // When a playlist is loaded, load_playlist reads player_settings.shuffle and, if enabled,
  // calls queue_shuffle which pins position 0 (Now Playing) and randomises positions 1+.
  // A client-side effect here would fire on settings-change rather than on playlist-load,
  // causing unexpected re-shuffles and potentially moving the currently playing item.

  // Realtime subscription for player_status — instant admin commands (pause/skip/resume)
  // with zero polling overhead. Only refetches with JOIN when current_media_id changes.
  //
  // Polling fallback: Supabase Realtime can hit its message-per-second rate limit and
  // silently drop change events.  If the player enters 'loading' state but never
  // receives the subsequent 'playing' (or new 'loading') event, the video stalls
  // forever.  To recover, we schedule a 10-second REST fallback: if it fires, we
  // re-fetch player_status directly from PostgREST and apply it as if it had
  // arrived via Realtime.  The timer is cleared on every status update so it only
  // fires when Realtime has genuinely gone silent.
  useEffect(() => {
    if (!identityReady || !activePlayerId) return;

    console.log('[Player] Starting player status subscription...');
    const prevStateRef = { current: status?.state };

    // Closure variable — tracks the pending REST fallback poll timer.
    let realtimePollTimer: number | null = null;

    const clearPollTimer = () => {
      if (realtimePollTimer !== null) {
        clearTimeout(realtimePollTimer);
        realtimePollTimer = null;
      }
    };

    // Core status-application logic, shared by both the Realtime subscription
    // and the REST polling fallback so both paths behave identically.
    const applyStatus = async (newStatus: PlayerStatus) => {
      // Any update (Realtime or polled) clears the pending poll timer.
      clearPollTimer();

      const prevState = prevStateRef.current;
      const newState = newStatus.state;

      // Always update the prevStateRef immediately so state tracking works
      // correctly even if playerRef isn't ready yet
      prevStateRef.current = newState;

      // Handle state transitions with fades.
      // In YTM Desktop mode playerRef.current is null (no iframe), so we must also
      // allow the block when playerModeRef indicates 'ytm_desktop'.
      if ((playerRef.current || playerModeRef.current === 'ytm_desktop') && prevState !== newState) {
        // SKIP: Admin set state to 'idle' while video was playing
        if (newState === 'idle' && (prevState === 'playing' || prevState === 'paused')) {
          console.log('[Player] Skip detected from Admin - triggering fade and skip');
          await reportEndedAndNext(true); // Skip with fade
          return; // Exit early, don't process other state changes
        }

        if (newState === 'paused' && prevState === 'playing') {
          // Mark that admin triggered this pause to prevent auto-resume
          adminPausedRef.current = true;
          setTimeout(() => { adminPausedRef.current = false; }, 5000); // Clear after 5s
          if (playerModeRef.current === 'ytm_desktop') {
            ytmAdminPausedRef.current = true;
            setTimeout(() => { ytmAdminPausedRef.current = false; }, 3000);
            ytmFetch('/api/v1/command', { method: 'POST', body: JSON.stringify({ command: 'pause' }) }).catch(() => {});
          } else if (localPlaybackUrlRef.current && localVideoRef.current) {
            localVideoRef.current.pause();
          } else if (playerRef.current) {
            await fadeOut();
            playerRef.current.pauseVideo();
          }
        } else if (newState === 'playing' && prevState === 'paused') {
          if (playerModeRef.current === 'ytm_desktop') {
            ytmFetch('/api/v1/command', { method: 'POST', body: JSON.stringify({ command: 'play' }) }).catch(() => {});
          } else if (localPlaybackUrlRef.current && localVideoRef.current) {
            console.log('[Player] Resuming local/Cloudflare video...');
            localVideoRef.current.play().catch(() => {});
          } else if (playerRef.current) {
            console.log('[Player] Resuming - fading in...');
            playerRef.current.playVideo();
            await fadeIn();
          }
        }
      }

      setStatus(newStatus);

      // Check if current_media changed
      const newMediaId = newStatus.current_media_id;
      const oldMediaId = currentMediaIdRef.current;

      // ── Non-YouTube source (yt-dlp download or Cloudflare R2) ─────────────
      if ((newStatus.source === 'local' || newStatus.source === 'cloudflare') && newStatus.local_url) {
        if (newStatus.local_url !== localPlaybackUrl) {
          console.log(`[Player][realtime] source=${newStatus.source} → activating <video>`);
          setLocalPlaybackUrl(newStatus.local_url);
        }
      } else if (newMediaId && newMediaId !== oldMediaId) {
        console.log(`[Player][realtime] source=${newStatus.source ?? 'youtube'} new media_id=${newMediaId} → reset to iframe mode`);
        setLocalPlaybackUrl(null);
      }

      if (newMediaId && newMediaId !== oldMediaId) {
        console.log('[Player] New media from status (CHANGED):', {
          old_id: oldMediaId,
          new_id: newMediaId,
          title: newStatus.current_media?.title,
          artist: newStatus.current_media?.artist
        });
        setCurrentMedia(newStatus.current_media || null);

        recentlyLoadedRef.current = true;
        setTimeout(() => {
          recentlyLoadedRef.current = false;
        }, 5000);
      }

      // ── Realtime polling fallback ────────────────────────────────────────────
      // If the player enters 'loading' state, schedule a REST fetch in 10 seconds.
      // Slave players don't drive playback so they don't need the fallback.
      if (newState === 'loading' && !isSlavePlayer) {
        realtimePollTimer = window.setTimeout(async () => {
          realtimePollTimer = null;
          console.warn('[Player] Realtime silent for 10s in loading state — polling REST for fresh status');
          try {
            const { data, error } = await supabase
              .from('player_status')
              .select('*, current_media:media_items(*)')
              .eq('player_id', PLAYER_ID)
              .single();
            if (error || !data) {
              console.error('[Player] REST fallback poll failed:', error);
              return;
            }
            const polledStatus = data as PlayerStatus;
            if (polledStatus.state !== 'loading') {
              // Realtime dropped an event — apply the fresh status now.
              console.log('[Player] REST poll found state:', polledStatus.state, '— applying as Realtime recovery');
              await applyStatus(polledStatus);
            } else {
              // Still loading after 10s — keep polling every 10s until it changes.
              // (The 6-second loadingTimeout in the status-watch effect will fire
              //  advanceToNext independently if the video truly never loads.)
              console.warn('[Player] REST poll: still loading after 10s — will retry');
              realtimePollTimer = window.setTimeout(async () => {
                realtimePollTimer = null;
                const { data: retryData } = await supabase
                  .from('player_status')
                  .select('*, current_media:media_items(*)')
                  .eq('player_id', PLAYER_ID)
                  .single();
                if (retryData && (retryData as PlayerStatus).state !== 'loading') {
                  await applyStatus(retryData as PlayerStatus);
                }
              }, 10000);
            }
          } catch (err) {
            console.error('[Player] REST fallback poll error:', err);
          }
        }, 10000);
      }
    };

    const subscription = subscribeToPlayerStatus(PLAYER_ID, applyStatus);

    return () => {
      console.log('[Player] Unsubscribing from player status');
      subscription.unsubscribe();
      clearPollTimer();
    };
  }, [identityReady, activePlayerId, PLAYER_ID, fadeIn, fadeOut, reportEndedAndNext, isSlavePlayer]);

  // Subscribe to player settings (to watch karaoke_mode)
  useEffect(() => {
    if (!identityReady || !activePlayerId) return;
    const settingsSub = subscribeToPlayerSettings(PLAYER_ID, setSettings);
    return () => settingsSub.unsubscribe();
  }, [identityReady, activePlayerId, PLAYER_ID]);

  // Derive current player mode; keep a ref in sync for use inside subscription callbacks
  const playerMode = settings?.player_mode ?? 'iframe';
  useEffect(() => {
    playerModeRef.current = settings?.player_mode ?? 'iframe';
  }, [settings?.player_mode]);
  useEffect(() => { localPlaybackUrlRef.current = localPlaybackUrl; }, [localPlaybackUrl]);

  // ── YTM Desktop auth ──────────────────────────────────────────────────────
  const ytmRequestAuth = useCallback(async () => {
    setYtmAuthStep('requesting');
    setYtmError(null);
    try {
      const res = await fetch(`${YTM_BASE}/api/v1/auth/requestcode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: YTM_APP_ID, appName: 'Obie Jukebox', appVersion: '1.0.0' }),
      });
      if (!res.ok) throw new Error('YTM Desktop not responding');
      const data = await res.json();
      const code: string = data.code;
      setYtmAuthCode(code);
      setYtmAuthStep('waiting');
      // Poll every 2 s until approved (max 30 s timeout per request)
      let attempts = 0;
      const poll = setInterval(async () => {
        attempts++;
        if (attempts > 45) { clearInterval(poll); setYtmAuthStep('idle'); return; }
        try {
          const authRes = await fetch(`${YTM_BASE}/api/v1/auth/request`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ appId: YTM_APP_ID, code }),
          });
          if (!authRes.ok) return;
          const authData = await authRes.json();
          if (authData.token) {
            clearInterval(poll);
            saveYtmToken(authData.token);
            setYtmToken(authData.token); // triggers Socket.IO connection effect
            setYtmAuthStep('authorized');
          }
        } catch { /* still waiting */ }
      }, 2000);
    } catch {
      setYtmError('YTM Desktop not found at localhost:9863. Start YTM Desktop and enable Companion Server.');
      setYtmAuthStep('idle');
    }
  }, []);

  // Test reachability of YTM Desktop Companion Server without requiring auth
  const ytmTestConnection = useCallback(async () => {
    setYtmTestResult('testing');
    setYtmTestMsg(null);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`${YTM_BASE}/api/v1/state`, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) {
        setYtmTestResult('ok');
        setYtmTestMsg('Server is running');
      } else if (res.status === 401) {
        setYtmTestResult('ok');
        setYtmTestMsg('Server found — click Connect to authorize');
      } else {
        setYtmTestResult('error');
        setYtmTestMsg(`HTTP ${res.status} — check Companion Server settings`);
      }
    } catch {
      setYtmTestResult('error');
      setYtmTestMsg('No response from localhost:9863 — is YTM Desktop running?');
    }
  }, []);

  // Tear down YTM connections when leaving ytm_desktop mode
  useEffect(() => {
    if (playerMode !== 'ytm_desktop') {
      ytmSocketRef.current?.disconnect();
      ytmSocketRef.current = null;
      setYtmNowPlaying(null);
      setYtmConnected(false);
      setYtmError(null);
      setYtmAuthStep('idle');
    }
  }, [playerMode]);

  // Socket.IO realtime connection: replaces polling — state-update events fire instantly on track changes
  useEffect(() => {
    if (playerMode !== 'ytm_desktop') return;
    if (!ytmToken) return;

    const socket = io(`${YTM_BASE}/api/v1/realtime`, {
      auth: { token: ytmToken },
      transports: ['websocket'], // API requires websocket-only (no polling)
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 2000,
    });
    ytmSocketRef.current = socket;

    socket.on('connect', () => {
      console.log('[YTM] Socket.IO connected');
      setYtmConnected(true);
      setYtmError(null);
    });

    socket.on('disconnect', () => {
      console.log('[YTM] Socket.IO disconnected');
      setYtmConnected(false);
    });

    socket.on('connect_error', (err: Error) => {
      console.error('[YTM] Socket.IO connect error:', err.message);
      setYtmConnected(false);
      setYtmError('Connection error — is YTM Desktop companion server running?');
    });

    socket.on('state-update', (data: any) => {
      setYtmConnected(true);
      setYtmError(null);
      // YTM Desktop API v1 state-update has the same structure as GET /state:
      //   data.player.trackState    (-1=Unknown, 0=Paused, 1=Playing, 2=Buffering; no "ended" state)
      //   data.player.videoProgress (float, SECONDS)
      //   data.video.id             (YouTube video ID)
      //   data.video.durationSeconds (integer, seconds)
      const video = data.video;
      const trackState: number = typeof data.player?.trackState === 'number' ? data.player.trackState : -1;
      const videoProgress: number = typeof data.player?.videoProgress === 'number' ? data.player.videoProgress : 0;

      if (video) {
        const thumb = video.thumbnails?.[0]?.url || '';
        setYtmNowPlaying({ title: video.title || '', artist: video.author || '', thumbnail: thumb });
      }

      if (ytmCurrentVideoIdRef.current) {
        // Per API: the state video object uses "id" for the YouTube video ID
        const videoMatches = (video?.id ?? null) === ytmCurrentVideoIdRef.current;
        const prevTrackState = ytmTrackStateRef.current;
        ytmTrackStateRef.current = trackState;

        // Report 'playing' once per video (backup path if changeVideo HTTP response was slow/missed)
        if (videoMatches && trackState === 1 && !ytmPlayingReportedRef.current) {
          ytmPlayingReportedRef.current = true;
          reportStatus('playing');
        }

        // End detection — videoProgress is SECONDS, trackState 0=Paused (no "ended" state in API).
        // API field is video.durationSeconds; fall back to video.duration in case of API variance.
        const duration: number =
          (typeof video?.durationSeconds === 'number' && video.durationSeconds > 0 ? video.durationSeconds : 0) ||
          (typeof video?.duration === 'number' && video.duration > 0 ? video.duration : 0);

        // Within 2 seconds of the end (requires duration to be known)
        const atEnd = videoMatches && duration > 0 && videoProgress >= duration - 2;

        // YTM Desktop transitions playing→unknown (-1) at end (observed via Socket.IO).
        // Fallback: also catch playing→paused (0) in case behaviour varies by track.
        // Gated on !ytmAdminPausedRef so admin-initiated pauses don't falsely trigger this.
        const pausedWhilePlaying = videoMatches
          && (trackState === 0 || trackState === -1) && prevTrackState === 1  // playing → paused/unknown
          && !ytmAdminPausedRef.current                        // not an admin pause
          && (duration > 0 ? videoProgress > duration * 0.85  // near end (if duration known)
                           : videoProgress > 10);             // >10s in (if duration unknown)

        if (atEnd || pausedWhilePlaying) {
          console.log('[YTM] Song ended — triggering queue_next', { videoProgress, duration, trackState, prevTrackState });
          ytmCurrentVideoIdRef.current = null; // prevent double-trigger
          reportEndedAndNext();
        }
      }
    });

    return () => {
      socket.disconnect();
      ytmSocketRef.current = null;
    };
  }, [playerMode, ytmToken, reportEndedAndNext, reportStatus]);

  // Create or update YouTube player when media changes
  useEffect(() => {
    if (!currentMedia) return;

    // Cloudflare / local source: handled by the <video> element, not the YouTube iframe.
    // Just update the ref so the status subscription doesn't re-trigger media changes.
    if (localPlaybackUrl) {
      if (currentMediaIdRef.current !== currentMedia.id) {
        console.log('[Player] Cloudflare/local media — handled by <video>, skipping YouTube load');
        currentMediaIdRef.current = currentMedia.id;
        videoHasPlayedRef.current = false;
      }
      return;
    }

    // YTM Desktop mode: dispatch changeVideo instead of creating an iframe
    if (playerModeRef.current === 'ytm_desktop') {
      if (currentMediaIdRef.current === currentMedia.id) {
        console.log('[Player] Same media (YTM), skipping');
        return;
      }
      const videoId = extractYouTubeId(currentMedia.url);
      if (!videoId) { console.error('[YTM] Could not extract YouTube ID from:', currentMedia.url); return; }
      currentMediaIdRef.current = currentMedia.id;
      ytmCurrentVideoIdRef.current = videoId;
      ytmPlayingReportedRef.current = false;
      ytmTrackStateRef.current = null;
      console.log('[YTM] Sending changeVideo:', videoId);
      ytmFetch('/api/v1/command', {
        method: 'POST',
        body: JSON.stringify({ command: 'changeVideo', data: { videoId } }),
      }).then(res => {
        if (res.ok) {
          setYtmConnected(true);
          setYtmError(null);
          // changeVideo causes immediate autoplay in YTM Desktop — report 'playing' now
          // so admin console advances from 'loading' → 'playing' without waiting for a socket event.
          reportStatus('playing');
        } else if (res.status === 401) { setYtmConnected(false); setYtmError('YTM auth failed — please reconnect'); }
        else setYtmError(`YTM command failed (HTTP ${res.status})`);
      }).catch(() => {
        setYtmError('YTM Desktop offline — start YTM Desktop with Companion Server enabled');
        setYtmConnected(false);
      });
      return;
    }

    if (!ytApiReady || !playerDivRef.current) return;

    // Check if this is actually a new media item
    if (currentMediaIdRef.current === currentMedia.id) {
      console.log('[Player] Same media, skipping player update');
      return;
    }

    console.log('[Player] Loading NEW media:', {
      id: currentMedia.id,
      title: currentMedia.title,
      artist: currentMedia.artist,
      url: currentMedia.url
    });

    const youtubeId = extractYouTubeId(currentMedia.url);
    if (!youtubeId) {
      console.error('[Player] Could not extract YouTube ID from:', currentMedia.url);
      return;
    }

    // If player already exists, just load the new video
    if (playerRef.current && playerRef.current.loadVideoById) {
      console.log('[Player] Loading new video in existing player:', youtubeId);
      currentMediaIdRef.current = currentMedia.id;
      currentYouTubeIdRef.current = youtubeId;
      videoHasPlayedRef.current = false; // Reset — new video hasn't played yet
      
      // Check if this is loading after a skip
      const isAfterSkip = isSkipLoadingRef.current;
      
      if (isAfterSkip) {
        // After skip: start with volume 0 and opacity 0, then immediately fade in
        console.log('[Player] Loading after skip - will fade in on play');
        if (playerDivRef.current) {
          playerDivRef.current.style.opacity = '0';
        }
        playerRef.current.setVolume(0);
        isSkipLoadingRef.current = false; // Reset flag

        // Load and explicitly play video (will trigger fade-in when playing state is detected)
        lastVideoLoadTimeRef.current = Date.now(); // Guard stale ENDED events for 3 s
        playerRef.current.loadVideoById(youtubeId);
        // Ensure playback starts
        setTimeout(() => {
          if (playerRef.current && playerRef.current.playVideo) {
            console.log('[Player] Explicitly calling playVideo() after skip load');
            playerRef.current.playVideo();
          }
        }, 500);
      } else {
        // Normal load: restore volume and opacity
        if (playerDivRef.current) {
          playerDivRef.current.style.opacity = '1';
        }
        playerRef.current.setVolume(100);

        // loadVideoById and explicitly play
        lastVideoLoadTimeRef.current = Date.now(); // Guard stale ENDED events for 3 s
        playerRef.current.loadVideoById(youtubeId);
        // Ensure playback starts
        setTimeout(() => {
          if (playerRef.current && playerRef.current.playVideo) {
            console.log('[Player] Explicitly calling playVideo() after normal load');
            playerRef.current.playVideo();
          }
        }, 500);
      }
      return;
    }

    // First time setup - create new player
    currentMediaIdRef.current = currentMedia.id;
    currentYouTubeIdRef.current = youtubeId;
    videoHasPlayedRef.current = false; // Reset — new player, video hasn't played yet
    lastVideoLoadTimeRef.current = Date.now(); // Guard stale ENDED events for 3 s
    setPlayerReady(false);

    console.log('[Player] Creating YouTube player for video:', youtubeId);
    playerRef.current = new window.YT.Player(playerDivRef.current, {
      videoId: youtubeId,
      playerVars: {
        autoplay: 0,        // Don't autoplay on first load (browser policy)
        controls: 0,        // Hide controls to prevent accidental clicks
        disablekb: 1,       // Disable keyboard controls
        modestbranding: 1,  // Hide YouTube logo
        rel: 0,             // Don't show related videos
        iv_load_policy: 3,  // Hide annotations
        vq: 'auto',         // Set quality to auto (let YouTube choose best quality)
      },
      events: {
        onReady: onPlayerReady,
        onStateChange: onPlayerStateChange,
        onError: onPlayerError,
      },
    });
  }, [currentMedia, localPlaybackUrl, ytApiReady, onPlayerReady, onPlayerStateChange, onPlayerError, reportStatus]);

  // Auto-skip videos that stay in 'loading' status for 4+ seconds, or that enter
  // 'paused' before the video has ever actually played (unexpected pause = error).
  // This catches age-restricted, geographically blocked, embedding-blocked, or
  // other failed-to-load videos regardless of which transient state they land in.
  useEffect(() => {
    if (!status) return;

    // ── Clear any existing timeouts ────────────────────────────────────────
    if (loadingTimeoutRef.current) {
      clearTimeout(loadingTimeoutRef.current);
      loadingTimeoutRef.current = null;
    }
    if (unexpectedPauseTimeoutRef.current) {
      clearTimeout(unexpectedPauseTimeoutRef.current);
      unexpectedPauseTimeoutRef.current = null;
    }

    const advanceToNext = async (reason: string) => {
      // Respect the same ending guard used by reportEndedAndNext —
      // if a queue advance is already in-flight, don't fire a second one.
      if (isEndingRef.current) {
        console.log(`[Player] ${reason} — skipping auto-advance (isEndingRef active, queue advance already in-flight)`);
        return;
      }
      isEndingRef.current = true;
      console.error(`[Player] ${reason} — advancing to next video`);

      // Fade out audio before advancing so the transition isn't jarring.
      // This mirrors the skip fade in reportEndedAndNext(true).
      if (!localPlaybackUrlRef.current && playerModeRef.current !== 'ytm_desktop') {
        try { await fadeOut(); } catch (_) { /* non-fatal */ }
      }

      try {
        const result = await callPlayerControl({
          player_id: PLAYER_ID,
          state: 'idle',
          progress: 1,
          action: 'ended',
          current_media_id: currentMediaIdRef.current || undefined,
        });
        if (result?.next_item) {
          const nextMedia: MediaItem = {
            id: result.next_item.media_item_id,
            title: result.next_item.title || 'Unknown',
            artist: 'Unknown',
            url: result.next_item.url,
            duration: result.next_item.duration || 0,
            source_id: '',
            source_type: 'youtube',
            thumbnail: null,
            fetched_at: new Date().toISOString(),
            metadata: {},
          };
          setCurrentMedia(nextMedia);
        }
      } catch (error) {
        console.error('[Player] Failed to advance after auto-skip:', error);
      } finally {
        // Same 10-second fallback as reportEndedAndNext
        setTimeout(() => {
          if (isEndingRef.current) {
            console.warn('[Player] isEndingRef fallback reset after 10s (auto-skip path)');
            isEndingRef.current = false;
          }
        }, 10000);
      }
    };

    // Skip loading/pause timeouts when a local/Cloudflare video is active —
    // the <video> element handles its own lifecycle and will report 'playing'.
    if (status.source === 'cloudflare' || status.source === 'local') {
      console.log(`[Player] Source is ${status.source} — skipping YouTube loading/pause timeouts`);
      return;
    }

    if (status.state === 'loading') {
      // ── 6-second loading timeout ──────────────────────────────────────────
      // IMPORTANT: Before advancing, check actual YouTube player state.
      // Supabase Realtime frequently drops the 'playing' status update under
      // load (MessagePerSecondRateLimitReached).  When it does, React status
      // stays 'loading' even though YouTube is already playing, causing this
      // timer to fire advanceToNext() on a perfectly healthy video — the root
      // cause of the ~9-second premature-skip pattern seen in production logs.
      console.log('[Player] Video entered loading state, setting 6-second timeout to load next if not loaded');
      loadingTimeoutRef.current = window.setTimeout(() => {
        loadingTimeoutRef.current = null;

        // Check the live YouTube / local player state before deciding to skip.
        if (!localPlaybackUrlRef.current && playerModeRef.current !== 'ytm_desktop') {
          if (playerRef.current && typeof playerRef.current.getPlayerState === 'function') {
            const ytState = playerRef.current.getPlayerState();
            if (ytState === 1) {
              // YouTube IS playing — Realtime dropped the 'playing' event.
              // Correct the DB state and do NOT skip the video.
              console.warn('[Player] Loading timeout fired but YouTube is PLAYING — Realtime dropped event; correcting DB state');
              reportStatus('playing');
              return;
            }
            if (ytState === 3) {
              // YouTube is still buffering — extend the timeout by 4 s rather
              // than skipping a video that is actively loading data.
              console.warn('[Player] Loading timeout fired but YouTube is BUFFERING — extending by 4s');
              loadingTimeoutRef.current = window.setTimeout(() => {
                loadingTimeoutRef.current = null;
                advanceToNext('Video still buffering after 10 seconds total');
              }, 4000);
              return;
            }
          }
        }

        advanceToNext('Video still in loading state after 6 seconds');
      }, 6000);

    } else if (status.state === 'paused' && !videoHasPlayedRef.current) {
      // ── Unexpected pause: video paused before it ever played ──────────────
      // This fires when an error (e.g. embedding block, network issue, YT API lag) causes the
      // player to land in 'paused' rather than 'loading'. Since the video has
      // never entered 'playing' state, this is not a user-initiated pause.
      // Option B: Auto-advance after ~2.5s to enforce continuous playback (radio mode).
      // We use an aggressive timeout because the player app is inherently "online" if executing code.
      //
      // Guard: if a queue advance is already in-flight (e.g. this is the initial
      // loading pause right after a skip/end advances the queue), skip the timer.
      // The normal PLAYING event will clear isEndingRef once the video starts.
      if (isEndingRef.current) {
        console.log('[Player] Unexpected pause while queue advance in-flight — suppressing guard (skip/end in progress)');
      } else {
        // Option B: Always use aggressive timeout for stalled pauses (player is online by virtue of executing code)
        console.warn('[Player] Video paused before playing — will auto-advance in 2.5s (Option B)');
        unexpectedPauseTimeoutRef.current = window.setTimeout(() => {
          unexpectedPauseTimeoutRef.current = null;
          advanceToNext('Video paused before playing (unexpected pause - Option B)');
        }, 2500);
      }

    } else if (status.state !== 'paused') {
      // Status changed to something other than paused/loading — log the transition
      console.log('[Player] Status changed from loading to:', status.state);
    }

    return () => {
      if (loadingTimeoutRef.current) {
        clearTimeout(loadingTimeoutRef.current);
        loadingTimeoutRef.current = null;
      }
      if (unexpectedPauseTimeoutRef.current) {
        clearTimeout(unexpectedPauseTimeoutRef.current);
        unexpectedPauseTimeoutRef.current = null;
      }
    };
  }, [status?.state]);

  useEffect(() => {
    if (!status || status.state !== 'idle' || !currentMedia || isSlavePlayer) return;
    if (isEndingRef.current) return;

    const recoverFromIdle = async () => {
      if (localPlaybackUrlRef.current && localVideoRef.current) {
        if (localVideoRef.current.ended) {
          console.warn('[Player] Idle with ended local video - advancing queue');
          await reportEndedAndNext();
          return;
        }

        console.warn('[Player] Idle while local video is loaded - resuming playback');
        try {
          await localVideoRef.current.play();
        } catch (error) {
          console.error('[Player] Failed to resume local video from idle state:', error);
        }
        return;
      }

      if (playerModeRef.current === 'ytm_desktop') {
        console.warn('[Player] Idle while YTM Desktop is active - requesting play');
        try {
          await ytmFetch('/api/v1/command', { method: 'POST', body: JSON.stringify({ command: 'play' }) });
          reportStatus('playing');
        } catch (error) {
          console.error('[Player] Failed to resume YTM Desktop from idle state:', error);
        }
        return;
      }

      if (!playerRef.current || typeof playerRef.current.getPlayerState !== 'function') return;
      if (currentMediaIdRef.current !== currentMedia.id) return;

      const ytState = playerRef.current.getPlayerState();

      if (ytState === 0) {
        console.warn('[Player] Idle with ended YouTube video - advancing queue');
        await reportEndedAndNext();
        return;
      }

      if (ytState === 1 || ytState === 3) {
        console.warn('[Player] Idle while YouTube player is active - correcting server state to playing');
        reportStatus('playing');
        return;
      }

      console.warn('[Player] Idle while YouTube video is loaded - attempting resume');
      try {
        playerRef.current.playVideo();
      } catch (error) {
        console.error('[Player] Failed to resume YouTube video from idle state:', error);
      }
    };

    recoverFromIdle().catch((error) => {
      console.error('[Player] Idle recovery failed:', error);
    });
  }, [status?.state, status?.current_media_id, currentMedia, isSlavePlayer, reportEndedAndNext, reportStatus]);

  // Sync player state with server commands
  useEffect(() => {
    if (!status) return;

    if (playerModeRef.current === 'ytm_desktop') {
      if (status.state === 'playing') {
        ytmFetch('/api/v1/command', { method: 'POST', body: JSON.stringify({ command: 'play' }) }).catch(() => {});
      } else if (status.state === 'paused') {
        ytmFetch('/api/v1/command', { method: 'POST', body: JSON.stringify({ command: 'pause' }) }).catch(() => {});
      }
      return;
    }

    if (!playerRef.current || !playerRef.current.playVideo) return;

    // Don't send commands to the YouTube iframe when a local/Cloudflare video is active —
    // the <video> element controls its own playback state.
    if (localPlaybackUrl) return;

    const player = playerRef.current;

    // Send commands to YouTube player based on server state
    if (status.state === 'playing') {
      player.playVideo();
    } else if (status.state === 'paused') {
      // Self-heal: if the DB says 'paused' but YouTube is actively playing,
      // the DB state is stale (reportStatus('paused') arrived after 'playing'
      // due to HTTP jitter).  Correct the DB rather than pausing a healthy video.
      const ytState = typeof player.getPlayerState === 'function' ? player.getPlayerState() : -1;
      if (ytState === 1) {
        console.warn('[Player] status-sync: DB is paused but YouTube is PLAYING — correcting DB state');
        reportStatus('playing');
      } else {
        player.pauseVideo();
      }
    }
  }, [status?.state, localPlaybackUrl, reportStatus]);

  if (!identityReady) return <ResolvingScreen />;

  if (!activePlayerId) return <JukeboxNamePrompt />;

  return (
    <div className="relative w-screen h-screen bg-black">
      {/* YouTube Player Container (hidden in ytm_desktop mode or when local fallback is active) */}
      <div
        ref={playerDivRef}
        id="player"
        className="w-full h-full"
        style={{ display: (playerMode === 'ytm_desktop' || !!localPlaybackUrl) ? 'none' : 'block' }}
      />

      {/* Local Video Fallback — plays a yt-dlp-downloaded .mp4 from Supabase Storage */}
      {localPlaybackUrl && (
        <video
          ref={localVideoRef}
          key={localPlaybackUrl}
          src={localPlaybackUrl}
          autoPlay
          className="absolute inset-0 w-full h-full"
          style={{ objectFit: 'contain', background: 'black' }}
          onLoadedMetadata={() => {
            // Slave sync: Seek to master's position when metadata loads
            if (isSyncing && targetSeekSeconds !== null && localVideoRef.current) {
              const seekSeconds = targetSeekSeconds;
              console.log('[Slave Sync] Local video metadata loaded — seeking to', seekSeconds.toFixed(1), 'seconds');
              try {
                localVideoRef.current.currentTime = seekSeconds;
                localVideoRef.current.play().catch(() => {});
                console.log('[Slave Sync] Local video seek complete, marking media as synced');
                setIsSyncing(false);
                setTargetSeekSeconds(null);
              } catch (error) {
                console.warn('[Slave Sync] Local video seek failed:', error);
                setIsSyncing(false);
                setTargetSeekSeconds(null);
              }
            }
          }}
          onPlay={() => {
            const v = localVideoRef.current;
            console.log(`[Player][local-video] ▶ PLAY  src=${localPlaybackUrl}  duration=${v ? v.duration.toFixed(1) + 's' : '?'}`);
            videoHasPlayedRef.current = true;
            // Clear ending guard — local/Cloudflare video confirmed playing
            if (isEndingRef.current) {
              console.log('[Player] Clearing isEndingRef — local/Cloudflare video confirmed PLAYING');
              isEndingRef.current = false;
            }
            reportStatus('playing');
          }}
          onTimeUpdate={() => {
            const now = Date.now();
            if (now - localVideoLastReportRef.current < 5000) return; // Throttle to every 5s
            localVideoLastReportRef.current = now;
            const v = localVideoRef.current;
            if (v && v.duration && isFinite(v.duration) && v.duration > 0) {
              const progress = v.currentTime / v.duration;
              reportStatus('playing', progress);
            }
          }}
          onPause={() => {
            // Guard: ignore programmatic pauses during skip/end transitions (isEndingRef) and
            // transient load pauses before the video has ever played (videoHasPlayedRef).
            // Only report a genuine pause to the DB so the admin console reflects it and the
            // status-sync effect can issue a resume command if the admin un-pauses remotely.
            if (videoHasPlayedRef.current && !isEndingRef.current) {
              console.log('[Player][local-video] ⏸ PAUSE — reporting paused state');
              reportStatus('paused');
            }
          }}
          onEnded={() => {
            console.log('[Player][local-video] ■ ENDED — triggering queue_next');
            reportEndedAndNext(false);
          }}
          onError={(e) => {
            console.error('[Player][local-video] ✖ ERROR:', e);
            setLocalPlaybackUrl(null);
            reportEndedAndNext(false);
          }}
        />
      )}

      {/* Slave Sync UI Overlay */}
      {isSyncing && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50 z-50 pointer-events-none">
          <div className="flex flex-col items-center gap-4">
            <div className="w-12 h-12 border-4 border-blue-400 border-t-transparent rounded-full animate-spin" />
            <div className="text-white text-sm font-medium">Syncing with master...</div>
          </div>
        </div>
      )}

      {/* YTM Desktop Overlay */}
      {playerMode === 'ytm_desktop' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black">
          {ytmConnected && ytmNowPlaying ? (
            <div style={{ textAlign: 'center', maxWidth: 480, padding: '0 24px' }}>
              {ytmNowPlaying.thumbnail && (
                <img src={ytmNowPlaying.thumbnail} alt="" style={{ width: 240, height: 180, objectFit: 'cover', borderRadius: 12, marginBottom: 20 }} />
              )}
              <div style={{ color: '#fff', fontSize: 26, fontWeight: 700, marginBottom: 8, lineHeight: '1.3' }}>{ytmNowPlaying.title}</div>
              <div style={{ color: '#aaa', fontSize: 18, marginBottom: 16 }}>{ytmNowPlaying.artist}</div>
              <div style={{ color: '#4ade80', fontSize: 12, letterSpacing: 1 }}>▶ Playing via YTM Desktop</div>
            </div>
          ) : ytmAuthStep === 'waiting' && ytmAuthCode ? (
            <div style={{ textAlign: 'center', color: '#fff' }}>
              <div style={{ fontSize: 16, color: '#aaa', marginBottom: 12 }}>Approve connection in YTM Desktop:</div>
              <div style={{ fontSize: 36, fontWeight: 700, letterSpacing: 10, background: '#111', padding: '18px 28px', borderRadius: 10, marginBottom: 16, fontFamily: 'monospace' }}>{ytmAuthCode}</div>
              <div style={{ fontSize: 13, color: '#555' }}>Waiting for approval…</div>
            </div>
          ) : ytmAuthStep === 'requesting' ? (
            <div style={{ color: '#aaa', fontSize: 16 }}>Connecting to YTM Desktop…</div>
          ) : (
            <div style={{ color: '#fff', maxWidth: 540, width: '100%', padding: '0 24px' }}>
              <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 6, textAlign: 'center' }}>YTM Desktop Mode</div>
              <div style={{ textAlign: 'center', marginBottom: 20 }}>
                <a
                  href="https://github.com/ytmdesktop/ytmdesktop/releases"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: '#60a5fa', fontSize: 12, textDecoration: 'none', fontFamily: 'monospace' }}
                >
                  ↗ github.com/ytmdesktop/ytmdesktop/releases
                </a>
              </div>

              {/* ── API Server Settings reference ── */}
              <div style={{ marginBottom: 16, borderRadius: 10, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                <div style={{ padding: '8px 16px', background: 'rgba(255,255,255,0.05)', fontFamily: 'monospace', fontSize: 10, color: 'rgba(255,255,255,0.35)', letterSpacing: 1, textTransform: 'uppercase' }}>
                  Required API Server Settings
                </div>
                {([
                  ['Hostname',          'localhost  (127.0.0.1)'],
                  ['Port',              '9863'],
                  ['Authorization',     'Bearer token  —  OAuth-style companion handshake'],
                  ['HTTPS / TLS',       'Disabled  (plain HTTP, no certificates needed)'],
                ] as [string, string][]).map(([label, value]) => (
                  <div key={label} style={{ display: 'flex', padding: '8px 16px', borderTop: '1px solid rgba(255,255,255,0.05)', gap: 12, alignItems: 'baseline' }}>
                    <span style={{ fontFamily: 'monospace', fontSize: 11, color: 'rgba(255,255,255,0.35)', minWidth: 130, flexShrink: 0 }}>{label}</span>
                    <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#e2e8f0' }}>{value}</span>
                  </div>
                ))}
              </div>

              {/* ── Setup instructions ── */}
              <div style={{ marginBottom: 16, padding: '12px 16px', borderRadius: 10, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <div style={{ fontFamily: 'monospace', fontSize: 10, color: 'rgba(255,255,255,0.35)', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 10 }}>Setup</div>
                {([
                  <>Open YTM Desktop → <b style={{ color: '#e2e8f0' }}>Settings → Integrations → Companion Server</b></>,
                  <>Toggle <b style={{ color: '#e2e8f0' }}>Enable Companion Server</b> ON; confirm port is <b style={{ color: '#e2e8f0' }}>9863</b></>,
                  <>Click <b style={{ color: '#e2e8f0' }}>Test Connection</b> to verify reachability, then <b style={{ color: '#e2e8f0' }}>Connect</b> to authorize Obie</>,
                ]).map((step, i) => (
                  <div key={i} style={{ display: 'flex', gap: 10, marginBottom: i < 2 ? 8 : 0, fontSize: 13, color: '#999', lineHeight: '1.5' }}>
                    <span style={{ color: 'rgba(255,255,255,0.2)', minWidth: 18, fontFamily: 'monospace', flexShrink: 0 }}>{i + 1}.</span>
                    <span>{step}</span>
                  </div>
                ))}
              </div>

              {/* ── Error banner ── */}
              {ytmError && (
                <div style={{ marginBottom: 14, padding: '8px 14px', borderRadius: 8, background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.25)', color: '#fca5a5', fontSize: 12 }}>
                  {ytmError}
                </div>
              )}

              {/* ── Action row ── */}
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <button
                  onClick={ytmTestConnection}
                  disabled={ytmTestResult === 'testing'}
                  style={{ padding: '9px 18px', borderRadius: 9, border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.06)', color: '#fff', cursor: ytmTestResult === 'testing' ? 'default' : 'pointer', fontSize: 13, fontWeight: 600, opacity: ytmTestResult === 'testing' ? 0.6 : 1 }}
                >
                  {ytmTestResult === 'testing' ? 'Testing…' : 'Test Connection'}
                </button>
                <button
                  onClick={ytmRequestAuth}
                  style={{ padding: '9px 18px', background: '#e33122', borderRadius: 9, border: 'none', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
                >
                  {getYtmToken() ? 'Reconnect YTM Desktop' : 'Connect YTM Desktop'}
                </button>
              </div>

              {/* ── Test result ── */}
              {ytmTestResult !== 'idle' && ytmTestMsg && (
                <div style={{ marginTop: 10, fontSize: 12, color: ytmTestResult === 'ok' ? '#4ade80' : '#f87171', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontFamily: 'monospace' }}>{ytmTestResult === 'ok' ? '✓' : '✗'}</span>
                  <span>{ytmTestMsg}</span>
                </div>
              )}
            </div>
          )}
          {ytmError && ytmConnected && (
            <div style={{ position: 'absolute', top: 16, left: 16, right: 16, background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, padding: '8px 16px', color: '#fca5a5', fontSize: 12, textAlign: 'center' }}>
              {ytmError}
            </div>
          )}
        </div>
      )}

      {/* Click Prevention Overlay - Allows play when paused, blocks pause when playing */}
      {/* Disabled in YTM Desktop mode so the YTM overlay buttons are clickable */}
      <div
        className="absolute inset-0 w-full h-full cursor-default"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();

          // Allow clicking to PLAY when video is paused
          if (status?.state === 'paused' && playerRef.current && typeof playerRef.current.playVideo === 'function') {
            console.log('[Player] User clicked to PLAY paused video');
            try {
              playerRef.current.playVideo();
            } catch (error) {
              console.error('[Player] Error playing video:', error);
            }
            return false;
          }

          // Block all other clicks (including pause when playing)
          console.log('[Player] Click blocked - can only play when paused');
          return false;
        }}
        style={{ pointerEvents: playerMode === 'ytm_desktop' ? 'none' : 'auto' }}
      />

      {/* Obie Logo Overlay */}
      <img
        src="/Obie_neon_no_BG.png"
        alt="Obie Logo"
        className="absolute bottom-[40px] left-[20px] w-[8vw] h-auto pointer-events-none z-10"
        style={{ maxWidth: '160px', minWidth: '60px' }}
      />

      {/* Status Overlay (for debugging) - HIDDEN */}
      {/* 
      <div className="absolute top-4 right-4 bg-black bg-opacity-75 text-white p-4 rounded-lg text-sm font-mono max-w-md" style={{ zIndex: 20 }}>
        <div className="mb-2">
          <span className="text-gray-400">Init:</span>{' '}
          <span className={`font-bold ${initStatus === 'ready' ? 'text-green-400' : initStatus === 'error' ? 'text-red-400' : 'text-yellow-400'}`}>
            {initStatus}
          </span>
        </div>
        <div className="mb-2">
          <span className="text-gray-400">Status:</span>{' '}
          <span className={`font-bold ${status?.state === 'playing' ? 'text-green-400' : 'text-yellow-400'}`}>
            {status?.state || 'initializing'}
          </span>
        </div>
        {currentMedia && (
          <>
            <div className="mb-1 text-gray-300 truncate">{cleanDisplayText(currentMedia.title)}</div>
            <div className="text-gray-500 text-xs truncate">{cleanDisplayText(currentMedia.artist)}</div>
          </>
        )}
        <div className="mt-2 text-xs text-gray-500">
          Progress: {Math.round((status?.progress || 0) * 100)}%
        </div>
        {status && (
          <div className="mt-1 text-xs text-gray-600">
            Index: {status.now_playing_index} | Media: {status.current_media_id?.slice(0, 8)}...
          </div>
        )}
      </div>
      */}

      <StatusOverlays state={status?.state} playerReady={playerReady}
        currentMedia={currentMedia} isSlavePlayer={isSlavePlayer} />
    </div>
  );
}

export default App;
