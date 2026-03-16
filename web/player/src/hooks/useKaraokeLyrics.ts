import { useCallback, useEffect, useRef } from 'react';
import type { MediaItem } from '@shared/supabase-client';
import { escapeHtml } from '../utils/youtube';

type LyricEntry = {
  startTimeMs?: number;
  endTimeMs?: number;
  words: string;
};

type UseKaraokeLyricsArgs = {
  enabled: boolean;
  currentMedia: MediaItem | null;
  playerRef: React.MutableRefObject<any>;
  currentMediaIdRef: React.MutableRefObject<string | null>;
};

export function useKaraokeLyrics({
  enabled,
  currentMedia,
  playerRef,
  currentMediaIdRef,
}: UseKaraokeLyricsArgs) {
  const lyricsDataRef = useRef<LyricEntry[] | null>(null);
  const lyricsRafRef = useRef<number | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  const fetchLyricsForMedia = useCallback(async (title: string | undefined, artist?: string) => {
    try {
      const track = encodeURIComponent(title || '');
      const artistName = encodeURIComponent(artist || '');
      const url = `https://lrclib.net/api/get?artist_name=${artistName}&track_name=${track}`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = await res.json();

      if (Array.isArray(data?.syncedLyrics) && data.syncedLyrics.length > 0) {
        return data.syncedLyrics.map((s: any) => ({
          startTimeMs: s.startTimeMs,
          endTimeMs: s.endTimeMs,
          words: s.words,
        })) as LyricEntry[];
      }

      if (data?.plainLyrics) {
        return [{ words: data.plainLyrics }] as LyricEntry[];
      }
    } catch (err) {
      console.warn('[Karaoke] fetchLyrics failed', err);
    }
    return null;
  }, []);

  const syncLyrics = useCallback(() => {
    try {
      if (!overlayRef.current || !playerRef.current || !lyricsDataRef.current) {
        lyricsRafRef.current = requestAnimationFrame(syncLyrics);
        return;
      }

      const player = playerRef.current;
      const timeMs = (player.getCurrentTime ? player.getCurrentTime() : 0) * 1000;
      const data = lyricsDataRef.current;

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
  }, [playerRef]);

  const stopLyricsSync = useCallback(() => {
    if (lyricsRafRef.current) {
      cancelAnimationFrame(lyricsRafRef.current);
      lyricsRafRef.current = null;
    }

    if (overlayRef.current) {
      overlayRef.current.style.display = 'none';
      overlayRef.current.innerHTML = '';
    }

    lyricsDataRef.current = null;
  }, []);

  useEffect(() => {
    if (!enabled) {
      stopLyricsSync();
      return;
    }

    if (!overlayRef.current) {
      const styleId = 'obie-karaoke-lyrics-style';
      if (!document.getElementById(styleId)) {
        const style = document.createElement('style');
        style.id = styleId;
        style.innerHTML = '.lyric-line{background:rgba(0,0,0,0.5);display:inline-block;padding:8px 16px;border-radius:8px;}';
        document.head.appendChild(style);
      }

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

      overlayRef.current = el;
      const container = document.querySelector('#root') || document.body;
      container.appendChild(el);
    }

    if (!currentMedia) return;

    if (lyricsDataRef.current && currentMediaIdRef.current === currentMedia.id) {
      if (overlayRef.current) overlayRef.current.style.display = 'block';
      if (!lyricsRafRef.current) lyricsRafRef.current = requestAnimationFrame(syncLyrics);
      return;
    }

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
  }, [enabled, currentMedia, currentMediaIdRef, fetchLyricsForMedia, stopLyricsSync, syncLyrics]);
}
