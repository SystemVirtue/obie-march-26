import { useCallback, useEffect, useState } from 'react';
import { FS_SCALES, hexToRgb, darkenHex, type Prefs } from '../types';

function applyAccentCSS(hex: string) {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return;
  const [r, g, b] = hexToRgb(hex);
  const root = document.documentElement;
  root.style.setProperty('--accent', hex);
  root.style.setProperty('--accent-dark', darkenHex(hex, 0.12));
  root.style.setProperty('--accent-dim', `rgba(${r},${g},${b},0.15)`);
  root.style.setProperty('--accent-border', `rgba(${r},${g},${b},0.30)`);
  root.style.setProperty('--accent-glow', `rgba(${r},${g},${b},0.38)`);
  root.style.setProperty('--accent-rgb', `${r},${g},${b}`);
}

function applyZoom(zoom: number) {
  const el = document.getElementById('root');
  if (el) (el.style as unknown as Record<string, string>).zoom = String(zoom);
}

export function useAdminPrefs(): Prefs {
  const [accent, setAccentState] = useState(() => {
    try {
      return localStorage.getItem('obie_accent') || '#f59e0b';
    } catch {
      return '#f59e0b';
    }
  });

  const [fsIdx, setFsIdxState] = useState(() => {
    try {
      const value = localStorage.getItem('obie_fontsize');
      return value !== null ? parseInt(value, 10) : 2;
    } catch {
      return 2;
    }
  });

  useEffect(() => {
    applyAccentCSS(accent);
  }, [accent]);

  useEffect(() => {
    applyZoom(FS_SCALES[fsIdx].zoom);
  }, [fsIdx]);

  const setAccent = useCallback((hex: string) => {
    setAccentState(hex);
    applyAccentCSS(hex);
    try {
      localStorage.setItem('obie_accent', hex);
    } catch {
      // no-op
    }
  }, []);

  const setFsIdx = useCallback((idx: number) => {
    const clamped = Math.max(0, Math.min(FS_SCALES.length - 1, idx));
    setFsIdxState(clamped);
    applyZoom(FS_SCALES[clamped].zoom);
    try {
      localStorage.setItem('obie_fontsize', String(clamped));
    } catch {
      // no-op
    }
  }, []);

  return {
    accent,
    setAccent,
    fsIdx,
    setFsIdx,
    fsScale: FS_SCALES[fsIdx],
  };
}
