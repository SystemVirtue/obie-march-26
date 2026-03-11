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
