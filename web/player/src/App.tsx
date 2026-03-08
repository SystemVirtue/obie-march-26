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
  initializePlayerPlaylist,
  type PlayerStatus,
  type MediaItem,
  type PlayerSettings,
} from '@shared/supabase-client';

const PLAYER_ID = '00000000-0000-0000-0000-000000000001';

// ── YTM Desktop Companion ────────────────────────────────────────────────────
const YTM_BASE = 'http://localhost:9863';
const YTM_APP_ID = 'obie-jukebox';
const getYtmToken = () => localStorage.getItem('ytm_auth_token');
const saveYtmToken = (token: string) => localStorage.setItem('ytm_auth_token', token);

async function ytmFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getYtmToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = token; // YTM hashes the raw token — no "Bearer" prefix
  return fetch(`${YTM_BASE}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers as Record<string, string> ?? {}) },
  });
}

// YouTube Player API types
declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady: () => void;
  }
}

function App() {
  const [status, setStatus] = useState<PlayerStatus | null>(null);
  const [currentMedia, setCurrentMedia] = useState<MediaItem | null>(null);
  const [settings, setSettings] = useState<PlayerSettings | null>(null);
  const [isSlavePlayer, setIsSlavePlayer] = useState(false); // Track if this is a slave player
  const [playerReady, setPlayerReady] = useState(false); // Track if YouTube player is ready
  const [ytApiReady, setYtApiReady] = useState(false); // Track if YouTube API is loaded
  const playerRef = useRef<any>(null);
  const playerDivRef = useRef<HTMLDivElement>(null);
  const hasInitialized = useRef(false);
  const currentMediaIdRef = useRef<string | null>(null);
  const fadeIntervalRef = useRef<number | null>(null);
  const isSkipLoadingRef = useRef(false); // Track if loading after skip
  const recentlyLoadedRef = useRef(false); // Track if video was recently loaded and should auto-play
  const isEndingRef = useRef(false); // In-flight guard: prevents double queue_next from concurrent calls
  const loadingTimeoutRef = useRef<number | null>(null); // Timeout to skip if status stays in 'loading' for 4+ seconds
  const videoHasPlayedRef = useRef(false); // true once current video reaches YouTube state PLAYING; reset on new media
  const unexpectedPauseTimeoutRef = useRef<number | null>(null); // Timeout to auto-advance if paused before video ever played
  // ── Local video fallback (yt-dlp) ──────────────────────────────────────────
  const [localPlaybackUrl, setLocalPlaybackUrl] = useState<string | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  // Tracks the YouTube ID of the currently-loaded video (legacy reference, kept for potential future use)
  const currentYouTubeIdRef = useRef<string | null>(null);
  const localVideoLastReportRef = useRef<number>(0); // Throttle local video progress reports
  const localPlaybackUrlRef = useRef<string | null>(null); // Mirror of localPlaybackUrl for use inside callbacks
  // Karaoke / lyrics refs
  const lyricsDataRef = useRef<Array<{ startTimeMs?: number; endTimeMs?: number; words: string }> | null>(null);
  const lyricsRafRef = useRef<number | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

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

  // Fade out audio and opacity over 2 seconds
  const fadeOut = useCallback((): Promise<void> => {
    return new Promise((resolve) => {
      if (!playerRef.current || !playerDivRef.current) {
        resolve();
        return;
      }

      const startVolume = ((): number => {
        if (!playerRef.current) return 100;
        if (typeof playerRef.current.getVolume === 'function') return playerRef.current.getVolume();
        // HTMLMediaElement uses 0..1 volume
        if (typeof (playerRef.current as any).volume === 'number') return (playerRef.current as any).volume * 100;
        return 100;
      })();
      const startOpacity = 1;
      const duration = 2000; // 2 seconds
      const steps = 60; // 60 fps
      const stepDuration = duration / steps;
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

        if (playerRef.current) {
          if (typeof playerRef.current.setVolume === 'function') {
            playerRef.current.setVolume(Math.max(0, newVolume));
          } else if (typeof (playerRef.current as any).volume === 'number') {
            (playerRef.current as any).volume = Math.max(0, Math.min(1, Math.max(0, newVolume) / 100));
          }
        }
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

  // YTM Desktop skip fade: step volume 100→0 over 2s via setVolume commands
  const fadeOutYtm = useCallback((): Promise<void> => {
    return new Promise((resolve) => {
      const steps = 10;
      const stepDuration = 2000 / steps; // 200ms per step
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
      if (!playerRef.current || !playerDivRef.current) {
        resolve();
        return;
      }

      const targetVolume = 100; // Can be made configurable later
      const targetOpacity = 1;
      const duration = 2000; // 2 seconds
      const steps = 60; // 60 fps
      const stepDuration = duration / steps;
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

        if (playerRef.current) {
          if (typeof playerRef.current.setVolume === 'function') {
            playerRef.current.setVolume(Math.min(100, newVolume));
          } else if (typeof (playerRef.current as any).volume === 'number') {
            (playerRef.current as any).volume = Math.min(1, Math.max(0, Math.min(100, newVolume) / 100));
          }
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

  // Extract YouTube video ID from URL
  const extractYouTubeId = (url: string): string | null => {
    const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\s]+)/);
    return match ? match[1] : null;
  };

  // Report playback events to server (disabled for slave players)
  const reportStatus = useCallback(async (state: PlayerStatus['state'], progress?: number) => {
    // Slave players do not send status updates to server
    if (isSlavePlayer) {
      console.log('[Slave Player] Skipping status report:', { state, progress });
      return;
    }

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
  }, [isSlavePlayer]);

  // Report video ended and trigger queue_next (disabled for slave players)
  const reportEndedAndNext = useCallback(async (isSkip = false) => {
    // Slave players do not trigger queue operations
    if (isSlavePlayer) {
      console.log('[Slave Player] Skipping ended/next report');
      return;
    }

    // Prevent concurrent calls: natural end + status subscription can both fire simultaneously.
    // The primary guard is server-side (player-control skips the intermediate state='idle' write),
    // but this ref provides belt-and-suspenders protection.
    //
    // isEndingRef stays true for 1000ms AFTER the queue_next call completes (see finally block).
    // This covers a race where player-control writing progress=1 to player_status fires a
    // second Realtime event with state='idle' that arrives after the first call returns —
    // the 1s cooldown absorbs that bounce window and prevents a double queue_next.
    if (isEndingRef.current) {
      console.log('[Player] End/skip cooldown active, ignoring duplicate trigger');
      return;
    }
    isEndingRef.current = true;

    console.log(isSkip ? '[Player] Video SKIPPED - triggering queue_next' : '[Player] Video ENDED - triggering queue_next');

    // Fade out if this is a skip
    if (isSkip) {
      if (playerModeRef.current === 'ytm_desktop') {
        // YTM Desktop: fade volume to 0, pause, then restore volume for next track
        await fadeOutYtm();
        await ytmFetch('/api/v1/command', { method: 'POST', body: JSON.stringify({ command: 'pause' }) }).catch(() => {});
        ytmFetch('/api/v1/command', { method: 'POST', body: JSON.stringify({ command: 'setVolume', data: 100 }) }).catch(() => {});
      } else {
        await fadeOut();
      }
      // Don't set skip loading flag - we'll fade back in immediately after loading
    }

    try {
      const result = await callPlayerControl({
        player_id: PLAYER_ID,
        state: 'idle',
        progress: 1,
        action: 'ended', // Always use 'ended' after fade completes to trigger queue_next
      });
      console.log('[Player] Queue_next full result:', JSON.stringify(result, null, 2));
      
      // Load the next video immediately from the result
      if (result?.next_item) {
        console.log('[Player] Next item data:', {
          media_item_id: result.next_item.media_item_id,
          title: result.next_item.title,
          url: result.next_item.url,
          duration: result.next_item.duration
        });
        
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
        console.log('[Player] Loading next media from queue_next result:', nextMedia);
        
        // If this was a skip, mark it so we can fade in when video starts
        if (isSkip) {
          isSkipLoadingRef.current = true;
        }
        
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
      } else {
        console.log('[Player] No more items in queue - result:', result);
        setCurrentMedia(null);
      }
    } catch (error) {
      console.error('[Player] Failed to call queue_next:', error);
    } finally {
      // Hold the guard for 1000ms after completion.
      // A second Realtime state='idle' event (caused by the progress=1 write in player-control)
      // can arrive right after the first call returns. Without this cooldown, prevStateRef
      // still shows 'playing' (updated only after the await resolves), so the subscription
      // would trigger a second reportEndedAndNext and a second queue_next, skipping a song.
      setTimeout(() => {
        isEndingRef.current = false;
      }, 1000);
    }
  }, [fadeOut, fadeOutYtm]);

  // YouTube Player event handlers
  const onPlayerReady = useCallback((_event: any) => {
    console.log('[Player] YouTube player ready - waiting for user to press play');
    setPlayerReady(true); // Mark player as ready to hide loading overlay
    // Don't report status here - let user click play first
    // Reporting 'idle' here causes the backend to think video ended and skip to next
  }, []);

  const onPlayerStateChange = useCallback((event: any) => {
    // Ignore YouTube events when a Cloudflare/local video is active
    if (localPlaybackUrlRef.current) {
      console.log('[Player] YouTube state change ignored (local/Cloudflare video active):', event.data);
      return;
    }
    console.log('[Player] YouTube state change:', event.data);

    // YouTube Player States:
    // -1 = UNSTARTED
    // 0 = ENDED
    // 1 = PLAYING
    // 2 = PAUSED
    // 3 = BUFFERING
    // 5 = CUED

    if (event.data === 1) {
      // PLAYING
      console.log('[Player] Video PLAYING');
      videoHasPlayedRef.current = true; // Video confirmed playing — any subsequent pause is user-initiated
      reportStatus('playing');

      // If we're at volume 0 (after skip), fade in
      if (playerRef.current) {
        const currentVol = ((): number => {
          if (typeof playerRef.current.getVolume === 'function') return playerRef.current.getVolume();
          if (typeof (playerRef.current as any).volume === 'number') return (playerRef.current as any).volume * 100;
          return 100;
        })();
        if (currentVol === 0) {
          console.log('[Player] Auto-playing after skip - fading in...');
          fadeIn();
        }
      }
    } else if (event.data === 2) {
      // PAUSED
      console.log('[Player] Video PAUSED');
      reportStatus('paused');

      // If video was recently loaded and paused unexpectedly, attempt to auto-play
      if (recentlyLoadedRef.current && playerRef.current && typeof playerRef.current.playVideo === 'function') {
        console.log('[Player] Video paused unexpectedly after load, attempting auto-play...');
        try {
          playerRef.current.playVideo();
          // Clear the flag since we're attempting to play
          recentlyLoadedRef.current = false;
        } catch (error) {
          console.error('[Player] Error auto-playing video:', error);
        }
      }
    } else if (event.data === 0) {
      // ENDED - trigger queue progression
      console.log('[Player] Video ENDED - calling queue_next');
      reportEndedAndNext();
    } else if (event.data === 3) {
      // BUFFERING
      console.log('[Player] Video BUFFERING');
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
    if (localPlaybackUrlRef.current) {
      console.log('[Player] YouTube error ignored (local/Cloudflare video active):', event.data);
      return;
    }
    console.error('[Player] YouTube player error:', event.data);

    if (isSlavePlayer) return;

    if (event.data === 100) {
      // Video is gone — remove it from the queue and all playlists so it never comes up again.
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
          console.log('[Player] Removed unavailable video from queue and playlists');
        } catch (removeErr) {
          console.error('[Player] Failed to remove unavailable video:', removeErr);
        }
      }
    }

    // Skip immediately for all error codes.
    // Do not rely on the 4-second loading timeout: a YouTube PAUSED event often
    // fires just before the error, causing the server status to land in 'paused'
    // (via an async race between reportStatus calls), which cancels the timeout
    // and leaves the player stuck indefinitely.
    console.error(`[Player] Skipping video due to playback error (${event.data})`);
    reportEndedAndNext(false);
  }, [isSlavePlayer, reportEndedAndNext]);

  // Load YouTube IFrame API
  useEffect(() => {
    if (ytApiReady) return;

    console.log('[Player] Loading YouTube IFrame API...');

    // Load the IFrame Player API code asynchronously
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    const firstScriptTag = document.getElementsByTagName('script')[0];
    firstScriptTag.parentNode?.insertBefore(tag, firstScriptTag);

    // API will call this function when ready
    window.onYouTubeIframeAPIReady = () => {
      console.log('[Player] YouTube IFrame API ready');
      setYtApiReady(true);
    };
  }, [ytApiReady]);

  // Initialize player with default playlist
  useEffect(() => {
    const initPlayer = async () => {
      if (hasInitialized.current) return;
      hasInitialized.current = true;

      try {
        console.log('[Player] Initializing player with default playlist...');
        
        const result = await initializePlayerPlaylist(PLAYER_ID) as any;
        
        if (result?.success) {
          console.log('[Player] Playlist loaded:', {
            playlist_name: result.playlist_name,
            loaded_count: result.loaded_count
          });
        } else {
          console.warn('[Player] No playlist available');
        }

        // Register this player instance as a potential priority player
        const sessionId = crypto.randomUUID();
        
        // Check if this player was previously priority
        const storedPlayerId = localStorage.getItem('obie_priority_player_id');
        
        console.log('[Player] Registering session:', sessionId, 'stored_player_id:', storedPlayerId);
        
        const sessionResult = await callPlayerControl({
          player_id: PLAYER_ID,
          action: 'register_session',
          session_id: sessionId,
          stored_player_id: storedPlayerId || undefined,
        });

        // Store whether this player is a slave (not priority)
        setIsSlavePlayer(!sessionResult.is_priority);
        
        // If this player became priority, store its ID in localStorage
        if (sessionResult.is_priority) {
          localStorage.setItem('obie_priority_player_id', PLAYER_ID);
          console.log('[Player] Priority player ID stored in localStorage');
        } else if (storedPlayerId === PLAYER_ID) {
          // This player was previously priority but is no longer - clear localStorage
          localStorage.removeItem('obie_priority_player_id');
          console.log('[Player] Priority player ID removed from localStorage');
        }
        
        console.log('[Player] Session registered successfully, is_slave:', !sessionResult.is_priority, 'restored:', sessionResult.restored || false);
      } catch (error) {
        console.error('[Player] Failed to initialize:', error);
      }
    };

    initPlayer();
  }, []);

  // NOTE: Shuffle-on-load is handled entirely by the load_playlist RPC (migration 0028).
  // When a playlist is loaded, load_playlist reads player_settings.shuffle and, if enabled,
  // calls queue_shuffle which pins position 0 (Now Playing) and randomises positions 1+.
  // A client-side effect here would fire on settings-change rather than on playlist-load,
  // causing unexpected re-shuffles and potentially moving the currently playing item.

  // Subscribe to player_status updates from Supabase
  useEffect(() => {
    console.log('[Player] Subscribing to player status...');
    const prevStateRef = { current: status?.state };
    
    const subscription = subscribeToPlayerStatus(PLAYER_ID, async (newStatus) => {
      console.log('[Player] Status update:', newStatus);
      const prevState = prevStateRef.current;
      const newState = newStatus.state;
      
      // Handle state transitions with fades.
      // In YTM Desktop mode playerRef.current is null (no iframe), so we must also
      // allow the block when playerModeRef indicates ytm_desktop.
      if ((playerRef.current || playerModeRef.current === 'ytm_desktop') && prevState !== newState) {
        // SKIP: Admin set state to 'idle' while video was playing
        if (newState === 'idle' && (prevState === 'playing' || prevState === 'paused')) {
          console.log('[Player] Skip detected from Admin - triggering fade and skip');
          await reportEndedAndNext(true); // Skip with fade
          prevStateRef.current = newState;
          setStatus(newStatus);
          return; // Exit early, don't process other state changes
        }
        
        if (newState === 'paused' && prevState === 'playing') {
          if (playerModeRef.current === 'ytm_desktop') {
            // Mark that this pause is admin-initiated so end detection ignores the
            // resulting trackState 1→0 transition in the state-update handler.
            ytmAdminPausedRef.current = true;
            setTimeout(() => { ytmAdminPausedRef.current = false; }, 3000);
            ytmFetch('/api/v1/command', { method: 'POST', body: JSON.stringify({ command: 'pause' }) }).catch(() => {});
          } else if (localPlaybackUrlRef.current && localVideoRef.current) {
            // Cloudflare/local: pause the <video> element
            console.log('[Player] Pausing local/Cloudflare video...');
            localVideoRef.current.pause();
          } else if (playerRef.current) {
            // Fade out when pausing
            console.log('[Player] Pausing - fading out...');
            await fadeOut();
            playerRef.current.pauseVideo();
          }
        } else if (newState === 'playing' && prevState === 'paused') {
          if (playerModeRef.current === 'ytm_desktop') {
            ytmFetch('/api/v1/command', { method: 'POST', body: JSON.stringify({ command: 'play' }) }).catch(() => {});
          } else if (localPlaybackUrlRef.current && localVideoRef.current) {
            // Cloudflare/local: resume the <video> element
            console.log('[Player] Resuming local/Cloudflare video...');
            localVideoRef.current.play().catch(() => {});
          } else if (playerRef.current) {
            // Fade in when resuming
            console.log('[Player] Resuming - fading in...');
            playerRef.current.playVideo();
            await fadeIn();
          }
        }
      }
      
      prevStateRef.current = newState;
      setStatus(newStatus);

      // Check if current_media changed
      const newMediaId = newStatus.current_media_id;
      const oldMediaId = currentMediaIdRef.current;

      // ── Non-YouTube source (yt-dlp download or Cloudflare R2) ─────────────
      if ((newStatus.source === 'local' || newStatus.source === 'cloudflare') && newStatus.local_url) {
        // Only activate when the local_url is actually new (avoid redundant sets)
        if (newStatus.local_url !== localPlaybackUrl) {
          console.log(`[Player][realtime] source=${newStatus.source} → activating <video>`);
          console.log(`[Player][realtime]   media_id=${newMediaId}  url=${newStatus.local_url}`);
          setLocalPlaybackUrl(newStatus.local_url);
        }
      } else if (newMediaId && newMediaId !== oldMediaId) {
        // New song started — always return to YouTube iframe mode
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

        // Mark that video was recently loaded and should auto-play if it pauses unexpectedly
        recentlyLoadedRef.current = true;
        // Clear the flag after 5 seconds
        setTimeout(() => {
          recentlyLoadedRef.current = false;
        }, 5000);
      } else {
        console.log('[Player] Same media in status update, not updating state');
      }
    });

    return () => {
      console.log('[Player] Unsubscribing from player status');
      subscription.unsubscribe();
    };
  }, [fadeIn, fadeOut, reportEndedAndNext]);

  // Subscribe to player settings (to watch karaoke_mode)
  useEffect(() => {
    const settingsSub = subscribeToPlayerSettings(PLAYER_ID, setSettings);
    return () => settingsSub.unsubscribe();
  }, []);

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

  // Fetch lyrics for a video/title using lrclib API (best-effort)
  async function fetchLyricsForMedia(title: string | undefined, artist?: string) {
    try {
      const track = encodeURIComponent(title || '');
      const artistName = encodeURIComponent(artist || '');
      const url = `https://lrclib.net/api/get?artist_name=${artistName}&track_name=${track}`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = await res.json();

      // data may contain syncedLyrics (array) or plainLyrics (string)
      if (Array.isArray(data?.syncedLyrics) && data.syncedLyrics.length > 0) {
        // normalize entries to have startTimeMs, endTimeMs, words
        return data.syncedLyrics.map((s: any) => ({ startTimeMs: s.startTimeMs, endTimeMs: s.endTimeMs, words: s.words }));
      }
      if (data?.plainLyrics) {
        return [{ words: data.plainLyrics }];
      }
    } catch (err) {
      console.warn('[Karaoke] fetchLyrics failed', err);
    }
    return null;
  }

  // Sync lyrics to player time
  const syncLyrics = useCallback(() => {
    try {
      if (!overlayRef.current || !playerRef.current || !lyricsDataRef.current) {
        lyricsRafRef.current = requestAnimationFrame(syncLyrics);
        return;
      }

      const player = playerRef.current;
      const timeMs = (player.getCurrentTime ? player.getCurrentTime() : 0) * 1000;
      const data = lyricsDataRef.current;

      // If it's unsynced (single entry with plain text), just display whole
      if (data.length === 1 && !data[0].startTimeMs) {
        overlayRef.current.innerHTML = `<div class="lyric-line">${escapeHtml(data[0].words)}</div>`;
      } else {
        const found = data.find((l) => (timeMs >= (l.startTimeMs || 0) && timeMs < (l.endTimeMs || Infinity)));
        if (found) {
          overlayRef.current.innerHTML = `<div class="lyric-line">${escapeHtml(found.words)}</div>`;
        }
      }

    } catch (err) {
      console.warn('[Karaoke] sync error', err);
    }
    lyricsRafRef.current = requestAnimationFrame(syncLyrics);
  }, []);

  function stopLyricsSync() {
    if (lyricsRafRef.current) {
      cancelAnimationFrame(lyricsRafRef.current);
      lyricsRafRef.current = null;
    }
    if (overlayRef.current) {
      overlayRef.current.style.display = 'none';
      overlayRef.current.innerHTML = '';
    }
    lyricsDataRef.current = null;
  }

  // Escape HTML content to avoid XSS when inserting lyrics
  function escapeHtml(s: string) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
  }

  // Start lyrics when karaoke mode enabled and media available
  useEffect(() => {
    const karaokeOn = !!settings?.karaoke_mode;
    if (!karaokeOn) {
      stopLyricsSync();
      return;
    }

    // Ensure overlay element exists
    if (!overlayRef.current) {
      const el = document.createElement('div');
      el.id = 'lyrics-overlay';
      el.style.position = 'absolute';
      el.style.left = '0';
      el.style.right = '0';
      el.style.bottom = '8%';
      el.style.textAlign = 'center';
      el.style.pointerEvents = 'none';
      el.style.zIndex = '60';
      el.style.display = 'none';
      el.className = 'text-white text-2xl drop-shadow-lg';
      // basic lyric-line style
      const style = document.createElement('style');
      style.innerHTML = `.lyric-line{background:rgba(0,0,0,0.5);display:inline-block;padding:8px 16px;border-radius:8px;}`;
      document.head.appendChild(style);
      overlayRef.current = el;
      // append into the root player container
      const container = document.querySelector('#root') || document.body;
      container.appendChild(el);
    }

    if (!currentMedia) return; // wait until media available

    // If we already have lyrics for this media id, reuse
    if (lyricsDataRef.current && currentMediaIdRef.current === currentMedia.id) {
      if (overlayRef.current) overlayRef.current.style.display = 'block';
      if (!lyricsRafRef.current) lyricsRafRef.current = requestAnimationFrame(syncLyrics);
      return;
    }

    // Fetch lyrics and start syncing
    (async () => {
      try {
        if (!currentMedia) return;
  const lyrics = await fetchLyricsForMedia(currentMedia.title, currentMedia.artist as any);
        if (!lyrics) {
          console.warn('[Karaoke] No lyrics found for', currentMedia.title);
          return;
        }
        lyricsDataRef.current = lyrics;
        currentMediaIdRef.current = currentMedia.id;
        if (overlayRef.current) overlayRef.current.style.display = 'block';
        if (!lyricsRafRef.current) lyricsRafRef.current = requestAnimationFrame(syncLyrics);
      } catch (err) {
        console.warn('[Karaoke] Failed to start lyrics', err);
      }
    })();

    return () => {
      // leave overlay shown if karaoke still on for other media; stop when karaoke disabled
    };
  }, [settings?.karaoke_mode, currentMedia, syncLyrics]);

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
      console.error(`[Player] ${reason} — advancing to next video`);
      try {
        const result = await callPlayerControl({
          player_id: PLAYER_ID,
          state: 'idle',
          progress: 1,
          action: 'ended',
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
      }
    };

    // Skip loading/pause timeouts when a local/Cloudflare video is active —
    // the <video> element handles its own lifecycle and will report 'playing'.
    if (status.source === 'cloudflare' || status.source === 'local') {
      console.log(`[Player] Source is ${status.source} — skipping YouTube loading/pause timeouts`);
      return;
    }

    if (status.state === 'loading') {
      // ── 4-second loading timeout ──────────────────────────────────────────
      console.log('[Player] Video entered loading state, setting 4-second timeout to load next if not loaded');
      loadingTimeoutRef.current = window.setTimeout(() => {
        loadingTimeoutRef.current = null;
        advanceToNext('Video still in loading state after 4 seconds');
      }, 4000);

    } else if (status.state === 'paused' && !videoHasPlayedRef.current) {
      // ── Unexpected pause: video paused before it ever played ──────────────
      // This fires when an error (e.g. embedding block, network issue) causes the
      // player to land in 'paused' rather than 'loading'. Since the video has
      // never entered 'playing' state, this is not a user-initiated pause —
      // auto-advance after 3 seconds.
      console.warn('[Player] Video paused before it ever played — unexpected pause, will auto-advance in 3s');
      unexpectedPauseTimeoutRef.current = window.setTimeout(() => {
        unexpectedPauseTimeoutRef.current = null;
        advanceToNext('Video paused before playing (unexpected pause)');
      }, 3000);

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
      player.pauseVideo();
    }
  }, [status?.state, localPlaybackUrl]);

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
          onPlay={() => {
            const v = localVideoRef.current;
            console.log(`[Player][local-video] ▶ PLAY  src=${localPlaybackUrl}  duration=${v ? v.duration.toFixed(1) + 's' : '?'}`);
            videoHasPlayedRef.current = true;
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

      {/* Idle State */}
      {status?.state === 'idle' && !currentMedia && (
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-gray-900 to-black">
          <div className="text-center">
            <div className="text-6xl font-bold text-white mb-4">Obie Jukebox</div>
            <div className="text-xl text-gray-400">Waiting for next song...</div>
            <div className="mt-8">
              <div className="inline-block w-12 h-12 border-4 border-white border-t-transparent rounded-full animate-spin"></div>
            </div>
          </div>
        </div>
      )}

      {/* Loading State */}
      {(status?.state === 'loading' && !playerReady) && (
        <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-90">
          <div className="text-center">
            <div className="inline-block w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
            <div className="text-2xl text-white">Loading...</div>
          </div>
        </div>
      )}

      {/* Error State */}
      {status?.state === 'error' && (
        <div className="absolute inset-0 flex items-center justify-center bg-red-900 bg-opacity-50">
          <div className="text-center">
            <div className="text-4xl font-bold text-white mb-4">⚠️ Playback Error</div>
            <div className="text-lg text-gray-200">Check logs for details</div>
          </div>
        </div>
      )}

      {/* Slave Player Debug Overlay */}
      {isSlavePlayer && (
        <div className="absolute bottom-0 left-0 right-0 flex justify-center items-end pb-4 pointer-events-none">
          <div className="text-5xl font-bold text-white opacity-50" style={{ fontFamily: 'Arial, sans-serif' }}>
            SLAVE
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
