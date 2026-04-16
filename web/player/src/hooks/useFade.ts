/**
 * useFade — audio/opacity fade in and out
 *
 * Extracted from App.tsx where fadeOut/fadeIn were defined as useCallback
 * with 60-step setInterval loops. This version is identical in behaviour
 * but lives in its own hook so App.tsx doesn't need to carry it.
 *
 * Works for both YouTube iframe (via YT.Player API) and <video> elements.
 * Pass the appropriate ref depending on active playback mode.
 */

import { useCallback, useRef } from 'react';
import { FADE_DURATION_MS } from '@shared/constants';

type FadeTarget = {
  /** YouTube player ref — must expose getVolume/setVolume */
  ytPlayerRef?: React.MutableRefObject<any>;
  /** Native <video> element ref */
  videoRef?: React.MutableRefObject<HTMLVideoElement | null>;
  /** Optional div whose CSS opacity should track the fade */
  containerRef?: React.MutableRefObject<HTMLDivElement | null>;
};

export function useFade(target: FadeTarget) {
  const fadeIntervalRef = useRef<number | null>(null);

  const clearFade = useCallback(() => {
    if (fadeIntervalRef.current !== null) {
      clearInterval(fadeIntervalRef.current);
      fadeIntervalRef.current = null;
    }
  }, []);

  /** Resolve the current volume (0–100) from whichever source is active */
  const getVolume = useCallback((): number => {
    const yt = target.ytPlayerRef?.current;
    if (yt && typeof yt.getVolume === 'function') return yt.getVolume();
    const vid = target.videoRef?.current;
    if (vid) return vid.volume * 100;
    return 100;
  }, [target]);

  /** Apply a normalised volume value (0–100) to whichever source is active */
  const setVolume = useCallback((vol: number) => {
    const yt = target.ytPlayerRef?.current;
    if (yt && typeof yt.setVolume === 'function') {
      yt.setVolume(Math.max(0, Math.min(100, vol)));
    }
    const vid = target.videoRef?.current;
    if (vid) {
      vid.volume = Math.max(0, Math.min(1, vol / 100));
    }
  }, [target]);

  const setOpacity = useCallback((opacity: number) => {
    const el = target.containerRef?.current;
    if (el) el.style.opacity = String(Math.max(0, Math.min(1, opacity)));
  }, [target]);

  /** Fade out to silence over FADE_DURATION_MS. Resolves when complete. */
  const fadeOut = useCallback((): Promise<void> => {
    return new Promise((resolve) => {
      clearFade();
      const startVolume = getVolume();
      const steps = 60;
      const stepDuration = FADE_DURATION_MS / steps;
      let step = 0;

      fadeIntervalRef.current = window.setInterval(() => {
        step++;
        const progress = step / steps;
        setVolume(startVolume * (1 - progress));
        setOpacity(1 - progress);

        if (step >= steps) {
          clearFade();
          resolve();
        }
      }, stepDuration);
    });
  }, [clearFade, getVolume, setVolume, setOpacity]);

  /** Fade in from silence over FADE_DURATION_MS. Resolves when complete. */
  const fadeIn = useCallback((): Promise<void> => {
    return new Promise((resolve) => {
      clearFade();
      const steps = 60;
      const stepDuration = FADE_DURATION_MS / steps;
      let step = 0;

      fadeIntervalRef.current = window.setInterval(() => {
        step++;
        const progress = step / steps;
        setVolume(100 * progress);
        setOpacity(progress);

        if (step >= steps) {
          clearFade();
          resolve();
        }
      }, stepDuration);
    });
  }, [clearFade, setVolume, setOpacity]);

  /** Snap volume to 0 without animation (e.g. before a skip-load) */
  const snapSilent = useCallback(() => {
    clearFade();
    setVolume(0);
    setOpacity(0);
  }, [clearFade, setVolume, setOpacity]);

  /** Snap volume to 100 without animation */
  const snapFull = useCallback(() => {
    clearFade();
    setVolume(100);
    setOpacity(1);
  }, [clearFade, setVolume, setOpacity]);

  return { fadeOut, fadeIn, snapSilent, snapFull, clearFade };
}
