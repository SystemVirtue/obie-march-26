// Shared types and constants for admin app components
import type { QueueItem, PlayerStatus, PlayerSettings, SystemLog, Playlist, PlaylistItem, MediaItem, AuthUser, JukeboxSummary } from '@shared/supabase-client';

export type { QueueItem, PlayerStatus, PlayerSettings, SystemLog, Playlist, PlaylistItem, MediaItem, AuthUser, JukeboxSummary };

export type ViewId =
  | 'queue'
  | 'playlists-all' | 'playlists-import'
  | 'settings-playback' | 'settings-kiosk' | 'settings-branding' | 'settings-scripts' | 'settings-prefs'
  | 'logs';

export interface Prefs {
  accent: string;
  setAccent: (hex: string) => void;
  fsIdx: number;
  setFsIdx: (idx: number) => void;
  fsScale: { zoom: number; label: string; pct: string };
}

export function fmtDuration(sec: number | null | undefined): string {
  const s = sec ?? 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const PLAYER_ID = '00000000-0000-0000-0000-000000000001';

export const FS_SCALES = [
  { zoom: 0.82, label: 'Smallest', pct: '82%' },
  { zoom: 0.91, label: 'Smaller',  pct: '91%' },
  { zoom: 1.00, label: 'Normal',   pct: '100%' },
  { zoom: 1.10, label: 'Larger',   pct: '110%' },
  { zoom: 1.22, label: 'Largest',  pct: '122%' },
];

export const PRESET_COLOURS = [
  { hex: '#f59e0b', name: 'Amber' },    { hex: '#ef4444', name: 'Red' },
  { hex: '#f97316', name: 'Orange' },   { hex: '#eab308', name: 'Yellow' },
  { hex: '#22c55e', name: 'Green' },    { hex: '#14b8a6', name: 'Teal' },
  { hex: '#06b6d4', name: 'Cyan' },     { hex: '#3b82f6', name: 'Blue' },
  { hex: '#6366f1', name: 'Indigo' },   { hex: '#8b5cf6', name: 'Violet' },
  { hex: '#d946ef', name: 'Fuchsia' },  { hex: '#ec4899', name: 'Pink' },
  { hex: '#a3e635', name: 'Lime' },     { hex: '#94a3b8', name: 'Slate' },
  { hex: '#ffffff', name: 'White' },
];

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function darkenHex(hex: string, pct: number): string {
  const [r, g, b] = hexToRgb(hex);
  return '#' + [r, g, b].map(v => Math.round(v * (1 - pct)).toString(16).padStart(2, '0')).join('');
}
export function isLightColour(hex: string): boolean {
  const [r, g, b] = hexToRgb(hex);
  return r * 0.299 + g * 0.587 + b * 0.114 > 186;
}

export function navigateClient(path: string, replace: boolean = false): void {
  const target = path.startsWith('/') ? path : `/${path}`;
  if (replace) {
    window.history.replaceState({}, '', target);
  } else {
    window.history.pushState({}, '', target);
  }
  window.dispatchEvent(new Event('popstate'));
}

export const PREDEFINED_PLAYLISTS = [
  { ytId: 'PLJ7vMjpVbhBWLWJpweVDki43Wlcqzsqdu', name: 'DJAMMMS Default Playlist' },
  { ytId: 'PLN9QqCogPsXIoSObV0F39OZ_MlRZ9tRT9', name: 'Obie Nights' },
  { ytId: 'PLN9QqCogPsXJCgeL_iEgYnW6Rl_8nIUUH', name: 'Obie Playlist' },
  { ytId: 'PLN9QqCogPsXIkPh6xm7cxSN9yTVaEoj0j', name: 'Obie Jo' },
  { ytId: 'PLN9QqCogPsXLAtgvLQ0tvpLv820R7PQsM', name: 'Karaoke' },
  { ytId: 'PLN9QqCogPsXLsv5D5ZswnOSnRIbGU80IS', name: 'Poly' },
  { ytId: 'PLN9QqCogPsXIqfwdfe4hf3qWM1mFweAXP', name: 'Obie Johno' },
];
