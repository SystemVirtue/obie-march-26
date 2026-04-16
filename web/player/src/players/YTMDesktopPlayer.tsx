/**
 * YTMDesktopPlayer — YouTube Music Desktop companion integration
 *
 * All YTM Desktop state, Socket.IO connection, and auth UI previously lived
 * in App.tsx as 9 useState + 6 useRef + 3 useEffect + 2 useCallback = ~300 lines.
 * This component owns all of it.
 *
 * Parent App.tsx simply renders <YTMDesktopPlayer> when settings.player_mode
 * === 'ytm_desktop' and passes dispatch + the current media URL.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import { YTM_BASE, YTM_APP_ID, getYtmToken, saveYtmToken, ytmFetch } from '../utils/ytm';
import { extractYouTubeId } from '../utils/youtube';
import type { PlaybackAction } from '../state/playbackMachine';
import type { MediaItem } from '@shared/supabase-client';

type YTMDesktopPlayerProps = {
  currentMedia: MediaItem | null;
  dispatch: React.Dispatch<PlaybackAction>;
  onAdminPause: () => void;
  onAdminResume: () => void;
};

export function YTMDesktopPlayer({
  currentMedia,
  dispatch,
  onAdminPause: _onAdminPause,
  onAdminResume: _onAdminResume,
}: YTMDesktopPlayerProps) {
  const [connected, setConnected]         = useState(false);
  const [error, setError]                 = useState<string | null>(null);
  const [nowPlaying, setNowPlaying]       = useState<{ title: string; artist: string; thumbnail: string } | null>(null);
  const [authStep, setAuthStep]           = useState<'idle' | 'requesting' | 'waiting' | 'authorized'>('idle');
  const [authCode, setAuthCode]           = useState<string | null>(null);
  const [token, setToken]                 = useState<string | null>(() => getYtmToken());
  const [testResult, setTestResult]       = useState<'idle' | 'testing' | 'ok' | 'error'>('idle');
  const [testMsg, setTestMsg]             = useState<string | null>(null);

  const socketRef              = useRef<any>(null);
  const currentVideoIdRef      = useRef<string | null>(null);
  const playingReportedRef     = useRef(false);
  const prevTrackStateRef      = useRef<number | null>(null);
  const adminPausedRef         = useRef(false);

  // ── Load current video when media changes ────────────────────────────────
  useEffect(() => {
    if (!currentMedia) return;
    const videoId = extractYouTubeId(currentMedia.url);
    if (!videoId) return;

    currentVideoIdRef.current  = videoId;
    playingReportedRef.current = false;
    prevTrackStateRef.current  = null;

    ytmFetch('/api/v1/command', {
      method: 'POST',
      body: JSON.stringify({ command: 'changeVideo', data: { videoId } }),
    })
      .then((res) => {
        if (res.ok) {
          setConnected(true);
          setError(null);
          dispatch({ type: 'YOUTUBE_PLAYING' }); // YTM autoplays immediately
        } else if (res.status === 401) {
          setConnected(false);
          setError('YTM auth expired — please reconnect');
        } else {
          setError(`YTM command failed (HTTP ${res.status})`);
        }
      })
      .catch(() => {
        setError('YTM Desktop offline — start YTM Desktop with Companion Server enabled');
        setConnected(false);
      });
  }, [currentMedia?.id, dispatch]);

  // ── Socket.IO realtime connection ────────────────────────────────────────
  useEffect(() => {
    if (!token) return;

    const socket = io(`${YTM_BASE}/api/v1/realtime`, {
      auth: { token },
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 2000,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      setError(null);
    });

    socket.on('disconnect', () => setConnected(false));

    socket.on('connect_error', (err: Error) => {
      setConnected(false);
      setError('Connection error — is YTM Desktop companion server running?');
      console.error('[YTMDesktop] Socket error:', err.message);
    });

    socket.on('state-update', (data: any) => {
      setConnected(true);
      setError(null);

      const video = data.video;
      const trackState: number = data.player?.trackState ?? -1;
      const videoProgress: number = data.player?.videoProgress ?? 0;

      if (video) {
        setNowPlaying({
          title:     video.title    ?? '',
          artist:    video.author   ?? '',
          thumbnail: video.thumbnails?.[0]?.url ?? '',
        });
      }

      if (!currentVideoIdRef.current) return;

      const videoMatches = (video?.id ?? null) === currentVideoIdRef.current;
      const prevState    = prevTrackStateRef.current;
      prevTrackStateRef.current = trackState;

      // Report playing once per video
      if (videoMatches && trackState === 1 && !playingReportedRef.current) {
        playingReportedRef.current = true;
        dispatch({ type: 'YOUTUBE_PLAYING' });
      }

      // End detection (YTM has no explicit ENDED state — detect via state transitions)
      const duration: number =
        (video?.durationSeconds > 0 ? video.durationSeconds : 0) ||
        (video?.duration > 0 ? video.duration : 0);

      const atEnd = videoMatches && duration > 0 && videoProgress >= duration - 2;

      const transitionToEnd =
        videoMatches &&
        (trackState === 0 || trackState === -1) && prevState === 1 &&
        !adminPausedRef.current &&
        (duration > 0 ? videoProgress > duration * 0.85 : videoProgress > 10);

      if (atEnd || transitionToEnd) {
        console.log('[YTMDesktop] Song ended — advancing queue');
        currentVideoIdRef.current = null; // Prevent double-trigger
        dispatch({ type: 'YOUTUBE_ENDED' });
      }
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [token, dispatch]);

  // ── Auth flow ────────────────────────────────────────────────────────────
  const requestAuth = useCallback(async () => {
    setAuthStep('requesting');
    setError(null);

    try {
      const res = await fetch(`${YTM_BASE}/api/v1/auth/requestcode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: YTM_APP_ID, appName: 'Obie Jukebox', appVersion: '1.0.0' }),
      });
      if (!res.ok) throw new Error('YTM Desktop not responding');

      const { code } = await res.json();
      setAuthCode(code);
      setAuthStep('waiting');

      let attempts = 0;
      const poll = setInterval(async () => {
        if (++attempts > 45) { clearInterval(poll); setAuthStep('idle'); return; }
        try {
          const authRes = await fetch(`${YTM_BASE}/api/v1/auth/request`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ appId: YTM_APP_ID, code }),
          });
          if (!authRes.ok) return;
          const { token: newToken } = await authRes.json();
          if (newToken) {
            clearInterval(poll);
            saveYtmToken(newToken);
            setToken(newToken);
            setAuthStep('authorized');
          }
        } catch { /* still waiting */ }
      }, 2000);
    } catch {
      setError('YTM Desktop not found at localhost:9863. Start YTM Desktop and enable Companion Server.');
      setAuthStep('idle');
    }
  }, []);

  const testConnection = useCallback(async () => {
    setTestResult('testing');
    setTestMsg(null);
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`${YTM_BASE}/api/v1/state`, { signal: controller.signal });
      clearTimeout(t);
      if (res.ok) {
        setTestResult('ok');
        setTestMsg('Server is running');
      } else if (res.status === 401) {
        setTestResult('ok');
        setTestMsg('Server found — click Connect to authorize');
      } else {
        setTestResult('error');
        setTestMsg(`HTTP ${res.status} — check Companion Server settings`);
      }
    } catch {
      setTestResult('error');
      setTestMsg('No response from localhost:9863 — is YTM Desktop running?');
    }
  }, []);

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-black">
      {connected && nowPlaying ? (
        <div style={{ textAlign: 'center', maxWidth: 480, padding: '0 24px' }}>
          {nowPlaying.thumbnail && (
            <img
              src={nowPlaying.thumbnail}
              alt=""
              style={{ width: 240, height: 180, objectFit: 'cover', borderRadius: 12, marginBottom: 20 }}
            />
          )}
          <div style={{ color: '#fff', fontSize: 26, fontWeight: 700, marginBottom: 8, lineHeight: '1.3' }}>
            {nowPlaying.title}
          </div>
          <div style={{ color: '#aaa', fontSize: 18, marginBottom: 16 }}>{nowPlaying.artist}</div>
          <div style={{ color: '#4ade80', fontSize: 12, letterSpacing: 1 }}>▶ Playing via YTM Desktop</div>
        </div>
      ) : authStep === 'waiting' && authCode ? (
        <div style={{ textAlign: 'center', color: '#fff' }}>
          <div style={{ fontSize: 16, color: '#aaa', marginBottom: 12 }}>
            Approve connection in YTM Desktop:
          </div>
          <div style={{
            fontSize: 36, fontWeight: 700, letterSpacing: 10,
            background: '#111', padding: '18px 28px', borderRadius: 10,
            marginBottom: 16, fontFamily: 'monospace',
          }}>
            {authCode}
          </div>
          <div style={{ fontSize: 13, color: '#555' }}>Waiting for approval…</div>
        </div>
      ) : authStep === 'requesting' ? (
        <div style={{ color: '#aaa', fontSize: 16 }}>Connecting to YTM Desktop…</div>
      ) : (
        /* Setup UI */
        <div style={{ color: '#fff', maxWidth: 540, width: '100%', padding: '0 24px' }}>
          <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 16, textAlign: 'center' }}>
            YTM Desktop Mode
          </div>

          {error && (
            <div style={{
              marginBottom: 14, padding: '8px 14px', borderRadius: 8,
              background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.25)',
              color: '#fca5a5', fontSize: 12,
            }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button
              onClick={testConnection}
              disabled={testResult === 'testing'}
              style={{
                padding: '9px 18px', borderRadius: 9,
                border: '1px solid rgba(255,255,255,0.15)',
                background: 'rgba(255,255,255,0.06)',
                color: '#fff', cursor: testResult === 'testing' ? 'default' : 'pointer',
                fontSize: 13, fontWeight: 600,
                opacity: testResult === 'testing' ? 0.6 : 1,
              }}
            >
              {testResult === 'testing' ? 'Testing…' : 'Test Connection'}
            </button>

            <button
              onClick={requestAuth}
              style={{
                padding: '9px 18px', background: '#e33122', borderRadius: 9,
                border: 'none', color: '#fff', cursor: 'pointer',
                fontSize: 13, fontWeight: 600,
              }}
            >
              {getYtmToken() ? 'Reconnect YTM Desktop' : 'Connect YTM Desktop'}
            </button>
          </div>

          {testResult !== 'idle' && testMsg && (
            <div style={{
              marginTop: 10, fontSize: 12,
              color: testResult === 'ok' ? '#4ade80' : '#f87171',
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
              <span style={{ fontFamily: 'monospace' }}>{testResult === 'ok' ? '✓' : '✗'}</span>
              <span>{testMsg}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
