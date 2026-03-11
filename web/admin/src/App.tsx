// Obie Admin Console v2 — Obsidian Stage Design
// All data flows through real Supabase subscriptions and Edge Function calls.
// No mock data. No simulated anything.

import { useEffect, useState, useCallback, useRef } from 'react';
import { cleanDisplayText } from '../../shared/media-utils';
import {
  supabase,
  subscribeToQueue,
  subscribeToPlayerStatus,
  subscribeToPlayerSettings,
  subscribeToTable,
  callQueueManager,
  callPlayerControl,
  callPlaylistManager,
  getPlaylists,
  getPlaylistItems,
  getTotalCredits,
  updateAllCredits,
  type QueueItem,
  type PlayerStatus,
  type SystemLog,
  type Playlist,
  type PlaylistItem,
  type PlayerSettings,
  type MediaItem,
  signIn,
  signOut,
  getCurrentUser,
  getUserPlayerId,
  getMyJukeboxes,
  createJukebox,
  callYouTubeScraper,
  resolveJukeboxSlug,
  subscribeToAuth,
  type JukeboxSummary,
  type AuthUser,
} from '@shared/supabase-client';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const PLAYER_ID = '00000000-0000-0000-0000-000000000001';

function normalizeJukeboxSlug(raw: string | null | undefined): string {
  return (raw || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_')
    .replace(/[^A-Z0-9_-]/g, '')
    .replace(/_+/g, '_')
    .replace(/-+/g, '-')
    .replace(/^[_-]+|[_-]+$/g, '');
}

function getPathJukeboxSlug(): string {
  const firstPathPart = window.location.pathname.split('/').filter(Boolean)[0] || '';
  return normalizeJukeboxSlug(firstPathPart);
}

// ─────────────────────────────────────────────────────────────────────────────
// PREFERENCES  (localStorage-backed font size + accent colour)
// ─────────────────────────────────────────────────────────────────────────────

const FS_SCALES = [
  { zoom: 0.82, label: 'Smallest', pct: '82%' },
  { zoom: 0.91, label: 'Smaller',  pct: '91%' },
  { zoom: 1.00, label: 'Normal',   pct: '100%' },
  { zoom: 1.10, label: 'Larger',   pct: '110%' },
  { zoom: 1.22, label: 'Largest',  pct: '122%' },
];

const PRESET_COLOURS = [
  { hex: '#f59e0b', name: 'Amber' },    { hex: '#ef4444', name: 'Red' },
  { hex: '#f97316', name: 'Orange' },   { hex: '#eab308', name: 'Yellow' },
  { hex: '#22c55e', name: 'Green' },    { hex: '#14b8a6', name: 'Teal' },
  { hex: '#06b6d4', name: 'Cyan' },     { hex: '#3b82f6', name: 'Blue' },
  { hex: '#6366f1', name: 'Indigo' },   { hex: '#8b5cf6', name: 'Violet' },
  { hex: '#d946ef', name: 'Fuchsia' },  { hex: '#ec4899', name: 'Pink' },
  { hex: '#a3e635', name: 'Lime' },     { hex: '#94a3b8', name: 'Slate' },
  { hex: '#ffffff', name: 'White' },
];

// Hardcoded playlists matching import-all-playlists.sh
const PREDEFINED_PLAYLISTS = [
  { ytId: 'PLJ7vMjpVbhBWLWJpweVDki43Wlcqzsqdu', name: 'DJAMMMS Default Playlist' },
  { ytId: 'PLN9QqCogPsXIoSObV0F39OZ_MlRZ9tRT9', name: 'Obie Nights' },
  { ytId: 'PLN9QqCogPsXJCgeL_iEgYnW6Rl_8nIUUH', name: 'Obie Playlist' },
  { ytId: 'PLN9QqCogPsXIkPh6xm7cxSN9yTVaEoj0j', name: 'Obie Jo' },
  { ytId: 'PLN9QqCogPsXLAtgvLQ0tvpLv820R7PQsM', name: 'Karaoke' },
  { ytId: 'PLN9QqCogPsXLsv5D5ZswnOSnRIbGU80IS', name: 'Poly' },
  { ytId: 'PLN9QqCogPsXIqfwdfe4hf3qWM1mFweAXP', name: 'Obie Johno' },
];

// ─── Colour helpers ──────────────────────────────────────────────────────────
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function darkenHex(hex: string, pct: number): string {
  const [r, g, b] = hexToRgb(hex);
  return '#' + [r, g, b].map(v => Math.round(v * (1 - pct)).toString(16).padStart(2, '0')).join('');
}
function isLightColour(hex: string): boolean {
  const [r, g, b] = hexToRgb(hex);
  return r * 0.299 + g * 0.587 + b * 0.114 > 186;
}
function applyAccentCSS(hex: string) {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return;
  const [r, g, b] = hexToRgb(hex);
  const root = document.documentElement;
  root.style.setProperty('--accent',        hex);
  root.style.setProperty('--accent-dark',   darkenHex(hex, 0.12));
  root.style.setProperty('--accent-dim',    `rgba(${r},${g},${b},0.15)`);
  root.style.setProperty('--accent-border', `rgba(${r},${g},${b},0.30)`);
  root.style.setProperty('--accent-glow',   `rgba(${r},${g},${b},0.38)`);
  root.style.setProperty('--accent-rgb',    `${r},${g},${b}`);
}
function applyZoom(zoom: number) {
  const el = document.getElementById('root');
  if (el) (el.style as unknown as Record<string,string>).zoom = String(zoom);
}

// ─── Prefs hook ──────────────────────────────────────────────────────────────
function usePrefs() {
  const [accent, setAccentState] = useState(() => {
    try { return localStorage.getItem('obie_accent') || '#f59e0b'; } catch { return '#f59e0b'; }
  });
  const [fsIdx, setFsIdxState] = useState(() => {
    try { const v = localStorage.getItem('obie_fontsize'); return v !== null ? parseInt(v, 10) : 2; }
    catch { return 2; }
  });
  useEffect(() => { applyAccentCSS(accent); }, [accent]);
  useEffect(() => { applyZoom(FS_SCALES[fsIdx].zoom); }, [fsIdx]);

  const setAccent = useCallback((hex: string) => {
    setAccentState(hex); applyAccentCSS(hex);
    try { localStorage.setItem('obie_accent', hex); } catch { /* noop */ }
  }, []);
  const setFsIdx = useCallback((idx: number) => {
    const c = Math.max(0, Math.min(FS_SCALES.length - 1, idx));
    setFsIdxState(c); applyZoom(FS_SCALES[c].zoom);
    try { localStorage.setItem('obie_fontsize', String(c)); } catch { /* noop */ }
  }, []);

  return { accent, setAccent, fsIdx, setFsIdx, fsScale: FS_SCALES[fsIdx] };
}

type Prefs = ReturnType<typeof usePrefs>;

// ─────────────────────────────────────────────────────────────────────────────
// SHARED UI PRIMITIVES
// ─────────────────────────────────────────────────────────────────────────────

function fmtDuration(sec: number | null | undefined): string {
  const s = sec ?? 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function Spinner({ size = 20 }: { size?: number }) {
  return (
    <div className="animate-spin rounded-full border-2 border-t-transparent inline-block"
      style={{ width: size, height: size, borderColor: 'var(--accent)', borderTopColor: 'transparent' }} />
  );
}

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}
      style={{ width: 44, height: 24, borderRadius: 999, flexShrink: 0,
        background: checked ? 'var(--accent)' : 'rgba(255,255,255,0.12)', transition: 'background 0.2s',
        position: 'relative', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
        border: 'none', outline: 'none' }}>
      <span style={{ position: 'absolute', top: 3, left: checked ? 23 : 3, width: 18, height: 18,
        borderRadius: '50%', background: '#fff', transition: 'left 0.2s', boxShadow: '0 1px 4px rgba(0,0,0,0.5)' }} />
    </button>
  );
}

function PanelHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '16px 24px', flexShrink: 0, borderBottom: '1px solid var(--border)' }}>
      <div>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 700, color: '#fff', letterSpacing: '-0.02em' }}>{title}</h1>
        {subtitle && <p style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--muted)', marginTop: 3 }}>{subtitle}</p>}
      </div>
      {actions && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{actions}</div>}
    </div>
  );
}

function Btn({ onClick, children, variant = 'ghost', disabled, style: xs }: {
  onClick?: (e: React.MouseEvent) => void; children: React.ReactNode;
  variant?: 'accent' | 'solid' | 'ghost' | 'danger'; disabled?: boolean; style?: React.CSSProperties;
}) {
  const vmap: Record<string, React.CSSProperties> = {
    accent: { background: 'var(--accent-dim)', color: 'var(--accent)', border: '1px solid var(--accent-border)' },
    solid:  { background: 'var(--accent)', color: '#000' },
    ghost:  { background: 'rgba(255,255,255,0.05)', color: 'var(--muted)', border: '1px solid rgba(255,255,255,0.1)' },
    danger: { background: 'rgba(239,68,68,0.12)', color: '#f87171', border: '1px solid rgba(239,68,68,0.25)' },
  };
  return (
    <button disabled={disabled} onClick={onClick}
      style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 10, border: 'none',
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1,
        fontFamily: 'var(--font-display)', fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap',
        ...vmap[variant], ...xs }}>
      {children}
    </button>
  );
}

function SaveBtn({ onSave, loading }: { onSave: () => Promise<void>; loading?: boolean }) {
  const [saved, setSaved] = useState(false);
  const handle = async () => { await onSave(); setSaved(true); setTimeout(() => setSaved(false), 2500); };
  return (
    <button onClick={handle} disabled={loading}
      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 24px', borderRadius: 12,
        cursor: loading ? 'default' : 'pointer', fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 600,
        background: saved ? 'rgba(34,197,94,0.18)' : 'var(--accent)',
        color: saved ? '#4ade80' : '#000',
        border: saved ? '1px solid rgba(34,197,94,0.4)' : 'none', transition: 'all 0.2s' }}>
      {loading ? <Spinner size={14} /> : saved ? '✓ Saved' : 'Save Settings'}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LOGIN FORM
// ─────────────────────────────────────────────────────────────────────────────

function LoginForm({ onSignIn }: { onSignIn: (user: AuthUser) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); setLoading(true); setError(null);
    try {
      const result = await signIn(email, password);
      if (result.user) {
        onSignIn({ id: result.user.id, email: result.user.email || '',
          role: result.user.user_metadata?.role || result.user.app_metadata?.role });
      }
    } catch (err: unknown) { setError(err instanceof Error ? err.message : 'Failed to sign in'); }
    finally { setLoading(false); }
  };

  const handleCreateNewJukebox = async () => {
    if (!email.trim() || !password.trim()) {
      setError('Enter email and password to create a new jukebox.');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const auth = await signIn(email, password);
      if (!auth.user) throw new Error('Authentication failed');

      const entered = window.prompt('Enter new jukebox name (A-Z, 0-9, underscore, dash):');
      const slug = normalizeJukeboxSlug(entered);
      if (!slug) {
        setLoading(false);
        return;
      }

      const created = await createJukebox(slug, slug);
      onSignIn({
        id: auth.user.id,
        email: auth.user.email || '',
        role: auth.user.user_metadata?.role || auth.user.app_metadata?.role,
      });

      window.location.assign(`/${created.jukebox_slug}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create jukebox');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ position: 'fixed', inset: 0, background: 'radial-gradient(ellipse 60% 50% at 50% 0%,rgba(245,158,11,0.08),transparent)', pointerEvents: 'none' }} />
      <div style={{ width: 380, background: '#0e0e0e', border: '1px solid var(--border)', borderRadius: 20, padding: 36, position: 'relative' }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ width: 48, height: 48, borderRadius: 14, background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px', boxShadow: '0 0 24px var(--accent-glow)' }}>
            <span style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 22, color: '#000' }}>O</span>
          </div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 700, color: '#fff', letterSpacing: '-0.02em' }}>Obie Admin</h1>
          <p style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--muted)', marginTop: 4, letterSpacing: '0.1em' }}>CONSOLE ACCESS</p>
        </div>
        <form onSubmit={handleSubmit}>
          {['Email', 'Password'].map((label) => (
            <div key={label} style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontFamily: 'var(--font-display)', fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>{label}</label>
              <input type={label === 'Password' ? 'password' : 'email'} required
                name={label === 'Email' ? 'email' : 'password'}
                autoComplete={label === 'Email' ? 'email' : 'current-password'}
                value={label === 'Email' ? email : password}
                onChange={e => label === 'Email' ? setEmail(e.target.value) : setPassword(e.target.value)}
                style={{ width: '100%', padding: '10px 14px', borderRadius: 10, background: '#0a0a0a',
                  border: '1px solid rgba(255,255,255,0.1)', color: '#fff', fontFamily: 'var(--font-mono)', fontSize: 13, outline: 'none' }} />
            </div>
          ))}
          {error && <p style={{ color: '#f87171', fontSize: 12, marginBottom: 12, fontFamily: 'var(--font-mono)' }}>{error}</p>}
          <button type="submit" disabled={loading}
            style={{ width: '100%', padding: '12px', borderRadius: 12, border: 'none', cursor: loading ? 'default' : 'pointer',
              background: 'var(--accent)', color: '#000', fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 700,
              opacity: loading ? 0.6 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            {loading ? <><Spinner size={16} /> Signing in…</> : 'Sign In'}
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={handleCreateNewJukebox}
            style={{ width: '100%', marginTop: 10, padding: '11px 12px', borderRadius: 12, border: '1px solid rgba(255,255,255,0.15)', cursor: loading ? 'default' : 'pointer',
              background: 'rgba(255,255,255,0.04)', color: '#fff', fontFamily: 'var(--font-display)', fontSize: 13, fontWeight: 600,
              opacity: loading ? 0.6 : 1 }}
          >
            Create New Jukebox
          </button>
        </form>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// NOW PLAYING STAGE
// ─────────────────────────────────────────────────────────────────────────────

function NowPlayingStage({ status, queue, settings, onPlayPause, onSkip, isSkipping, onRemove }: {
  status: PlayerStatus | null; queue: QueueItem[]; settings: PlayerSettings | null;
  onPlayPause: () => void; onSkip: () => void; isSkipping: boolean; onRemove: (id: string) => void;
}) {
  const [showPauseConfirm, setShowPauseConfirm] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cm = (status as any)?.current_media as any;
  const thumb  = cm?.thumbnail || '';
  const title  = cleanDisplayText(cm?.title) || 'Nothing playing';
  const artist = cleanDisplayText(cm?.artist) || '—';
  const isPlaying = status?.state === 'playing';
  const isPaused  = status?.state === 'paused';
  const progress  = Math.min(100, (status?.progress ?? 0) * 100);
  const stateLabel = isSkipping ? 'SKIPPING' : isPlaying ? 'Now Playing' : isPaused ? 'Paused' : (status?.state || 'Idle');
  const handlePlayPauseClick = () => {
    if (isSkipping) return;
    if (isPlaying) { setShowPauseConfirm(true); } else { onPlayPause(); }
  };

  // 🐛 DEBUG: Track what's playing vs what's in queue
  console.log('[NowPlayingStage] 🎵 Current playing status:', {
    current_media_id: (status as any)?.current_media_id?.slice(0, 8) || 'none',
    title: title,
    state: status?.state,
    queue_length: queue.length,
    queue_items: queue.map(item => ({
      id: item.id.slice(0, 8),
      media_id: item.media_item_id?.slice(0, 8),
      position: item.position,
      type: item.type,
      title: item.media_item?.title?.slice(0, 30)
    }))
  });

  // Check if current media is actually in the queue
  const currentQueueItem = queue.find((item) => item.media_item_id === (status as any)?.current_media_id);
  console.log('[NowPlayingStage] 🎯 currentQueueItem match:', {
    found: !!currentQueueItem,
    media_id: currentQueueItem?.media_item_id?.slice(0, 8) || 'none',
    position: currentQueueItem?.position,
    type: currentQueueItem?.type,
    title: currentQueueItem?.media_item?.title?.slice(0, 30) || 'none'
  });

  const upNext   = queue.filter(q => q.media_item_id !== (status as any)?.current_media_id).slice(0, 3);
  const priority = queue.filter(q => q.type === 'priority');

  return (
    <div style={{ position: 'relative', height: '33vh', minHeight: 240, flexShrink: 0, overflow: 'hidden', background: '#050505' }}>
      {/* Blurred art backdrop */}
      {thumb && <>
        <img src={thumb} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', filter: 'blur(60px) saturate(1.4) brightness(0.28)', transform: 'scale(1.4)' }} />
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(135deg,rgba(5,5,5,0.85) 0%,rgba(5,5,5,0.2) 50%,rgba(5,5,5,0.92) 100%)' }} />
      </>}
      {/* Grain */}
      <div style={{ position: 'absolute', inset: 0, opacity: 0.12, pointerEvents: 'none', backgroundSize: '128px',
        backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.4'/%3E%3C/svg%3E")` }} />
      {/* Bottom line */}
      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 1, background: 'linear-gradient(90deg,transparent,var(--accent-border),transparent)' }} />

      <div style={{ position: 'relative', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: '16px 22px 0' }}>
        {/* Top */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
          {/* Thumb */}
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <div style={{ width: 80, height: 80, borderRadius: 14, overflow: 'hidden', background: '#111', boxShadow: '0 8px 32px rgba(0,0,0,0.9),0 0 0 1px rgba(255,255,255,0.07)' }}>
              {thumb ? <img src={thumb} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.15)', fontSize: 28 }}>♪</div>}
            </div>
            <div style={{ position: 'absolute', bottom: -3, right: -3, width: 14, height: 14, borderRadius: '50%', background: '#0a0a0a', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: isPlaying ? '#22c55e' : '#fbbf24', boxShadow: `0 0 6px ${isPlaying ? '#22c55e' : '#fbbf24'}` }} />
            </div>
          </div>

          {/* Info */}
          <div style={{ flex: 1, minWidth: 0, paddingTop: 2 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <div style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                background: isSkipping ? '#f59e0b' : isPlaying ? '#22c55e' : '#fbbf24',
                boxShadow: `0 0 8px ${isSkipping ? '#f59e0b' : isPlaying ? '#22c55e' : '#fbbf24'}`,
                animation: (isPlaying || isSkipping) ? 'pulse 1.6s ease-in-out infinite' : 'none' }} />
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.14em',
                color: isSkipping ? '#f59e0b' : isPlaying ? '#4ade80' : 'rgba(255,255,255,0.4)',
                textTransform: 'uppercase', fontWeight: 600 }}>
                {stateLabel}
              </span>
            </div>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 26, fontWeight: 800, color: '#fff',
              letterSpacing: '-0.03em', lineHeight: 1.1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              textShadow: isPlaying ? '0 0 40px rgba(255,255,255,0.15)' : 'none' }}>{title}</h2>
            <p style={{ fontFamily: 'var(--font-display)', fontSize: 15, color: 'rgba(255,255,255,0.55)', marginTop: 4,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', letterSpacing: '-0.01em' }}>{artist}</p>
          </div>

          {/* Up Next */}
          <div style={{ width: 240, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.1em', color: 'rgba(255,255,255,0.28)', textTransform: 'uppercase', marginBottom: 2 }}>Up Next</div>
            {upNext.length === 0
              ? <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(255,255,255,0.2)' }}>Queue empty</div>
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              : upNext.map((item, i) => { const m = (item as any).media_item as any; return (
                <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 8, borderRadius: 9, padding: '5px 9px', background: 'rgba(255,255,255,0.06)' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(255,255,255,0.22)', width: 12 }}>{i + 1}</span>
                  {m?.thumbnail && <img src={m.thumbnail} alt="" style={{ width: 28, height: 28, borderRadius: 5, objectFit: 'cover', flexShrink: 0 }} />}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 500, color: 'rgba(255,255,255,0.85)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cleanDisplayText(m?.title) || 'Unknown'}</div>
                    <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>{cleanDisplayText(m?.artist) || ''}</div>
                  </div>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(255,255,255,0.28)', flexShrink: 0 }}>{fmtDuration(m?.duration)}</span>
                  <button onClick={() => onRemove(item.id)} style={{ width: 20, height: 20, borderRadius: 5, background: 'rgba(239,68,68,0.12)', border: 'none', cursor: 'pointer', color: '#f87171', fontSize: 10, flexShrink: 0 }}>✕</button>
                </div>
              );})}
          </div>

          {/* Priority requests */}
          {/* Moved to upNext for consistent order */}
        </div>

        {/* Controls */}
        <div style={{ paddingBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 9 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(255,255,255,0.3)', flexShrink: 0 }}>
              {fmtDuration((status?.progress ?? 0) * (cm?.duration ?? 0))}
            </span>
            <div style={{ flex: 1, height: 3, borderRadius: 99, background: 'rgba(255,255,255,0.1)', position: 'relative' }}>
              <div style={{ height: '100%', borderRadius: 99, background: 'linear-gradient(90deg,var(--accent),var(--accent-dark))', width: `${progress}%`, transition: 'width 0.5s linear' }} />
            </div>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(255,255,255,0.3)', flexShrink: 0 }}>{fmtDuration(cm?.duration)}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* Play/Pause — RED+yellow when playing, GREEN+white when paused, grey when skipping */}
            <button onClick={handlePlayPauseClick} disabled={isSkipping}
              title={isSkipping ? 'Skipping…' : isPlaying ? 'Pause playback' : 'Resume playback'}
              style={{ width: 44, height: 44, borderRadius: '50%', border: 'none',
                cursor: isSkipping ? 'default' : 'pointer', flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18,
                background: isSkipping ? 'rgba(255,255,255,0.08)' : isPlaying ? '#dc2626' : '#16a34a',
                color: isSkipping ? 'rgba(255,255,255,0.25)' : isPlaying ? '#facc15' : '#fff',
                boxShadow: isSkipping ? 'none' : isPlaying ? '0 4px 18px rgba(220,38,38,0.45)' : '0 4px 18px rgba(22,163,74,0.45)',
                transition: 'background 0.2s, box-shadow 0.2s, color 0.2s',
                opacity: isSkipping ? 0.45 : 1 }}>
              {isPlaying ? '⏸' : '▶'}
            </button>
            <button onClick={onSkip} disabled={isSkipping} style={{ width: 34, height: 34, borderRadius: 9, border: 'none', cursor: isSkipping ? 'default' : 'pointer',
              background: 'rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, opacity: isSkipping ? 0.45 : 1 }}>
              {isSkipping ? <Spinner size={14} /> : '⏭'}
            </button>
            <div style={{ width: 1, height: 20, background: 'rgba(255,255,255,0.1)', margin: '0 4px' }} />
            <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.38)' }}>🔊</span>
            <div style={{ width: 72 }}><input type="range" min={0} max={100} value={settings?.volume ?? 75} readOnly /></div>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(255,255,255,0.28)', width: 22 }}>{settings?.volume ?? 75}</span>
            <div style={{ flex: 1 }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 9px', borderRadius: 99,
              background: isSkipping ? 'rgba(245,158,11,0.12)' : isPlaying ? 'rgba(34,197,94,0.12)' : 'rgba(255,255,255,0.07)',
              border: `1px solid ${isSkipping ? 'rgba(245,158,11,0.3)' : isPlaying ? 'rgba(34,197,94,0.25)' : 'rgba(255,255,255,0.1)'}` }}>
              <div style={{ width: 5, height: 5, borderRadius: '50%', background: isSkipping ? '#f59e0b' : isPlaying ? '#22c55e' : '#fbbf24' }} />
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.06em', textTransform: 'uppercase',
                color: isSkipping ? '#fbbf24' : isPlaying ? '#4ade80' : '#fbbf24' }}>{stateLabel}</span>
            </div>
            {priority.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 9px', borderRadius: 99, background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(59,130,246,0.25)' }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: '#60a5fa' }}>⭐ {priority.length} PRIORITY</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Pause confirmation modal */}
      {showPauseConfirm && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.72)', backdropFilter: 'blur(4px)' }}
          onClick={() => setShowPauseConfirm(false)}>
          <div style={{ background: '#111', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 18, padding: '28px 32px',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20, minWidth: 280,
            boxShadow: '0 24px 80px rgba(0,0,0,0.9)' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700, color: '#fff', letterSpacing: '-0.02em' }}>Pause Playback?</div>
            <div style={{ display: 'flex', gap: 12 }}>
              <button onClick={() => setShowPauseConfirm(false)}
                style={{ padding: '9px 24px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.12)',
                  background: 'transparent', color: 'rgba(255,255,255,0.55)', cursor: 'pointer',
                  fontFamily: 'var(--font-display)', fontSize: 13, fontWeight: 500 }}>
                Cancel
              </button>
              <button onClick={() => { setShowPauseConfirm(false); onPlayPause(); }}
                style={{ padding: '9px 24px', borderRadius: 10, border: 'none',
                  background: '#dc2626', color: '#fff', cursor: 'pointer',
                  fontFamily: 'var(--font-display)', fontSize: 13, fontWeight: 700,
                  boxShadow: '0 4px 18px rgba(220,38,38,0.4)' }}>
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SIDEBAR
// ─────────────────────────────────────────────────────────────────────────────

type ViewId =
  | 'queue'
  | 'playlists-all' | 'playlists-import'
  | 'settings-playback' | 'settings-kiosk' | 'settings-branding' | 'settings-scripts' | 'settings-prefs'
  | 'logs';

const NAV = [
  { id: 'queue',     icon: '🎵', label: 'Queue',     children: [] as { id: ViewId; label: string }[] },
  { id: 'playlists', icon: '📋', label: 'Playlists', children: [
    { id: 'playlists-all'    as ViewId, label: 'All Playlists' },
    { id: 'playlists-import' as ViewId, label: 'Import Playlist' },
  ]},
  { id: 'settings',  icon: '⚙️', label: 'Settings',  children: [
    { id: 'settings-playback' as ViewId, label: 'Playback' },
    { id: 'settings-kiosk'    as ViewId, label: 'Kiosk' },
    { id: 'settings-branding' as ViewId, label: 'Branding' },
    { id: 'settings-scripts'  as ViewId, label: 'Functions & Scripts' },
    { id: 'settings-prefs'    as ViewId, label: 'Console Preferences' },
  ]},
  { id: 'logs',      icon: '📄', label: 'Logs',      children: [] as { id: ViewId; label: string }[] },
];

function Sidebar({ view, setView, queue, user, onSignOut, jukeboxes, activeJukeboxSlug, onSwitchJukebox }: {
  view: ViewId; setView: (v: ViewId) => void;
  queue: QueueItem[]; user: AuthUser; onSignOut: () => void;
  jukeboxes: JukeboxSummary[];
  activeJukeboxSlug: string | null;
  onSwitchJukebox: (slug: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [openGroup, setOpenGroup] = useState<string>('queue');
  const [showJukeboxPicker, setShowJukeboxPicker] = useState(false);
  const priorityCount = queue.filter(q => q.type === 'priority').length;
  const canSwitchJukebox = jukeboxes.length > 1;
  const currentJukebox = jukeboxes.find((j) => j.jukebox_slug === activeJukeboxSlug) || jukeboxes[0] || null;

  const handleGroup = (group: typeof NAV[0]) => {
    if (group.children.length === 0) { setOpenGroup(''); setView(group.id as ViewId); return; }
    const isOpen = openGroup === group.id;
    setOpenGroup(isOpen ? '' : group.id);
    if (!isOpen) setView(group.children[0].id);
  };

  const isGroupActive = (group: typeof NAV[0]) =>
    group.children.some(c => c.id === view) || (group.children.length === 0 && view === group.id as ViewId);

  return (
    <aside style={{ display: 'flex', flexDirection: 'column', flexShrink: 0,
      width: expanded ? 220 : 60, height: '100%', background: 'var(--surface)',
      borderRight: '1px solid var(--border)', transition: 'width 0.25s cubic-bezier(0.4,0,0.2,1)', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 13px', height: 54, flexShrink: 0, borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
        <div style={{ width: 30, height: 30, borderRadius: 9, flexShrink: 0, background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 14px var(--accent-glow)' }}>
          <span style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 14, color: '#000' }}>O</span>
        </div>
        {expanded && <>
          <div style={{ overflow: 'hidden', flex: 1 }}>
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15, color: '#fff', letterSpacing: '-0.02em', whiteSpace: 'nowrap' }}>Obie</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'rgba(255,255,255,0.25)', letterSpacing: '0.1em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>Admin Console</div>
          </div>
          <button onClick={() => setExpanded(false)} style={{ marginLeft: 'auto', width: 22, height: 22, background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.25)', cursor: 'pointer', borderRadius: 6, fontSize: 14 }}>‹</button>
        </>}
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, padding: '8px 0', overflowY: 'auto', overflowX: 'hidden' }}>
        {NAV.map(group => {
          const active = isGroupActive(group);
          const open   = openGroup === group.id;
          return (
            <div key={group.id}>
              <button onClick={() => handleGroup(group)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 9,
                padding: expanded ? '9px 13px' : '9px 0', justifyContent: expanded ? 'flex-start' : 'center',
                background: 'transparent', border: 'none', cursor: 'pointer', position: 'relative',
                color: active ? 'var(--accent)' : 'rgba(255,255,255,0.4)' }}>
                {active && <div style={{ position: 'absolute', left: 0, top: '50%', transform: 'translateY(-50%)', width: 2, height: 18, borderRadius: '0 2px 2px 0', background: 'var(--accent)' }} />}
                <div style={{ width: 30, height: 30, borderRadius: 8, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, background: active ? 'var(--accent-dim)' : 'transparent' }}>{group.icon}</div>
                {expanded && <>
                  <span style={{ fontFamily: 'var(--font-display)', fontSize: 13, fontWeight: 500, flex: 1, textAlign: 'left', whiteSpace: 'nowrap' }}>{group.label}</span>
                  {group.children.length > 0 && <span style={{ fontSize: 11, opacity: 0.45, flexShrink: 0, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }}>›</span>}
                  {group.id === 'queue' && priorityCount > 0 && !open && (
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, padding: '1px 5px', borderRadius: 99, background: 'rgba(59,130,246,0.2)', color: '#60a5fa' }}>{priorityCount}</span>
                  )}
                </>}
              </button>
              {expanded && open && group.children.length > 0 && (
                <div style={{ background: 'rgba(255,255,255,0.015)', borderLeft: '1px solid rgba(255,255,255,0.06)', marginLeft: 21 }}>
                  {group.children.map(child => (
                    <button key={child.id} onClick={() => setView(child.id)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 7,
                      padding: '7px 13px', background: 'transparent', border: 'none', cursor: 'pointer',
                      color: view === child.id ? 'var(--accent)' : 'rgba(255,255,255,0.38)' }}>
                      <div style={{ width: 5, height: 5, borderRadius: '50%', flexShrink: 0, background: view === child.id ? 'var(--accent)' : 'rgba(255,255,255,0.15)' }} />
                      <span style={{ fontFamily: 'var(--font-display)', fontSize: 12, flex: 1, textAlign: 'left', whiteSpace: 'nowrap' }}>{child.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {/* Footer */}
      {expanded ? (
        <div style={{ padding: '10px 13px', borderTop: '1px solid rgba(255,255,255,0.05)', flexShrink: 0, position: 'relative' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'rgba(255,255,255,0.25)', marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.email}</div>
          <button
            onClick={() => {
              if (!canSwitchJukebox) return;
              setShowJukeboxPicker((v) => !v);
            }}
            style={{ width: '100%', padding: '6px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.16)', background: 'rgba(255,255,255,0.06)', color: '#e5e7eb', cursor: canSwitchJukebox ? 'pointer' : 'default', fontFamily: 'var(--font-display)', fontSize: 11, marginBottom: 6, opacity: canSwitchJukebox ? 1 : 0.7 }}
            title={canSwitchJukebox ? 'Select a Jukebox' : 'Only one jukebox is associated with this account'}
          >
            Jukebox : {currentJukebox?.jukebox_slug || activeJukeboxSlug || 'N/A'}
          </button>
          {showJukeboxPicker && canSwitchJukebox && (
            <div style={{ position: 'absolute', left: 13, right: 13, bottom: 76, borderRadius: 10, border: '1px solid rgba(255,255,255,0.15)', background: '#111', boxShadow: '0 10px 30px rgba(0,0,0,0.4)', overflow: 'hidden', zIndex: 30 }}>
              <div style={{ padding: '8px 10px', fontFamily: 'var(--font-display)', fontSize: 11, color: 'rgba(255,255,255,0.6)', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                Select a Jukebox
              </div>
              {jukeboxes.map((j) => (
                <button
                  key={j.player_id}
                  onClick={() => {
                    setShowJukeboxPicker(false);
                    if (j.jukebox_slug !== activeJukeboxSlug) onSwitchJukebox(j.jukebox_slug);
                  }}
                  style={{ width: '100%', textAlign: 'left', padding: '8px 10px', border: 'none', borderBottom: '1px solid rgba(255,255,255,0.05)', background: j.jukebox_slug === activeJukeboxSlug ? 'rgba(245,158,11,0.12)' : 'transparent', color: j.jukebox_slug === activeJukeboxSlug ? '#fbbf24' : '#e5e7eb', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 11 }}
                >
                  {j.jukebox_slug}
                </button>
              ))}
              <button
                onClick={() => setShowJukeboxPicker(false)}
                style={{ width: '100%', textAlign: 'center', padding: '8px 10px', border: 'none', background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.7)', cursor: 'pointer', fontFamily: 'var(--font-display)', fontSize: 11 }}
              >
                Cancel
              </button>
            </div>
          )}
          <button onClick={onSignOut} style={{ width: '100%', padding: '6px', borderRadius: 8, border: '1px solid rgba(239,68,68,0.2)', background: 'rgba(239,68,68,0.08)', color: '#f87171', cursor: 'pointer', fontFamily: 'var(--font-display)', fontSize: 11 }}>Sign Out</button>
        </div>
      ) : (
        <button onClick={() => setExpanded(true)} style={{ padding: '10px 0', display: 'flex', alignItems: 'center', justifyContent: 'center', borderTop: '1px solid rgba(255,255,255,0.05)', background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.25)', cursor: 'pointer', fontSize: 14 }}>›</button>
      )}
    </aside>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// QUEUE PANEL
// ─────────────────────────────────────────────────────────────────────────────

function SortableQueueItem({ item, onRemove }: { item: QueueItem; onRemove: (id: string) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = (item as any).media_item as any;
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, borderRadius: 11, padding: '9px 11px',
        background: 'rgba(255,255,255,0.025)', marginBottom: 4, border: '1px solid rgba(255,255,255,0.04)' }}>
        <button {...attributes} {...listeners} style={{ cursor: 'grab', background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.2)', padding: 2, flexShrink: 0, fontSize: 14 }}>⋮⋮</button>
        {m?.thumbnail && <img src={m.thumbnail} alt="" style={{ width: 34, height: 34, borderRadius: 7, objectFit: 'cover', flexShrink: 0 }} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 13, fontWeight: 500, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m?.title || 'Unknown'}</div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.38)' }}>{m?.artist || ''}</div>
        </div>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(255,255,255,0.3)', flexShrink: 0 }}>{fmtDuration(m?.duration)}</span>
        <button onClick={() => onRemove(item.id)} style={{ width: 26, height: 26, borderRadius: 7, background: 'rgba(239,68,68,0.12)', border: 'none', cursor: 'pointer', color: '#f87171', fontSize: 12 }}>✕</button>
      </div>
    </div>
  );
}

function QueuePanel({ queue, status, onRemove, onReorder, onShuffle, isShuffling }: {
  queue: QueueItem[]; status: PlayerStatus | null;
  onRemove: (id: string) => void; onReorder: (e: DragEndEvent) => void;
  onShuffle: () => void; isShuffling: boolean;
}) {
  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const normalQ   = queue.filter(q => q.type === 'normal'   && q.media_item_id !== status?.current_media_id);
  const priorityQ = queue.filter(q => q.type === 'priority' && q.media_item_id !== status?.current_media_id);
  const totalCount = normalQ.length + priorityQ.length;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <PanelHeader title="Queue" subtitle={`${totalCount} song${totalCount !== 1 ? 's' : ''}`}
        actions={<Btn variant="accent" onClick={onShuffle} disabled={isShuffling}>{isShuffling ? <><Spinner size={12} /> Shuffling…</> : '🔀 Shuffle'}</Btn>}
      />

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 16px' }}>

        {/* ── Priority Requests ─────────────────────────────────── */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.12em', color: '#60a5fa', textTransform: 'uppercase' }}>Priority Requests</span>
            {priorityQ.length > 0 && (
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, padding: '1px 6px', borderRadius: 99, background: 'rgba(59,130,246,0.2)', color: '#60a5fa' }}>{priorityQ.length}</span>
            )}
          </div>

          {priorityQ.length === 0 ? (
            <div style={{ borderRadius: 10, padding: '14px 16px', background: 'rgba(59,130,246,0.04)', border: '1px dashed rgba(59,130,246,0.15)', color: 'rgba(255,255,255,0.22)', fontFamily: 'var(--font-mono)', fontSize: 11, textAlign: 'center' }}>
              Empty
            </div>
          ) : (
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            priorityQ.map(item => { const m = (item as any).media_item as any; return (
              <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 10, borderRadius: 12, padding: '10px 12px', marginBottom: 6, background: 'rgba(59,130,246,0.07)', border: '1px solid rgba(59,130,246,0.15)' }}>
                {m?.thumbnail && <img src={m.thumbnail} alt="" style={{ width: 36, height: 36, borderRadius: 7, objectFit: 'cover', flexShrink: 0 }} />}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--font-display)', fontSize: 13, fontWeight: 500, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m?.title || 'Unknown'}</div>
                  <div style={{ fontSize: 11, color: '#60a5fa', marginTop: 2 }}>{item.requested_by || 'Kiosk'}</div>
                </div>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(255,255,255,0.3)', flexShrink: 0 }}>{fmtDuration(m?.duration)}</span>
                <button onClick={() => onRemove(item.id)} style={{ width: 28, height: 28, borderRadius: 7, background: 'rgba(239,68,68,0.12)', border: 'none', cursor: 'pointer', color: '#f87171', fontSize: 12, flexShrink: 0 }}>✕</button>
              </div>
            );})
          )}
        </div>

        {/* ── Divider ───────────────────────────────────────────── */}
        <div style={{ height: 1, background: 'rgba(255,255,255,0.06)', marginBottom: 20 }} />

        {/* ── Up Next ───────────────────────────────────────────── */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.12em', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase' }}>Up Next</span>
            {normalQ.length > 0 && (
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, padding: '1px 6px', borderRadius: 99, background: 'rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.4)' }}>{normalQ.length}</span>
            )}
          </div>

          {normalQ.length === 0 ? (
            <div style={{ color: 'rgba(255,255,255,0.25)', fontFamily: 'var(--font-mono)', fontSize: 12, textAlign: 'center', paddingTop: 20 }}>Queue is empty</div>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onReorder}>
              <SortableContext items={normalQ.map(i => i.id)} strategy={verticalListSortingStrategy}>
                {normalQ.map(item => <SortableQueueItem key={item.id} item={item} onRemove={onRemove} />)}
              </SortableContext>
            </DndContext>
          )}
        </div>

      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PLAYLISTS PANEL
// ─────────────────────────────────────────────────────────────────────────────

function PlaylistsPanel({ view, playerId }: { view: ViewId; playerId: string }) {
  const [playlists, setPlaylists] = useState<(Playlist & { item_count?: number })[]>([]);
  const [playlistItems, setPlaylistItems] = useState<(PlaylistItem & { media_item?: MediaItem })[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loadingId, setLoadingId]   = useState<string | null>(null);
  const isLoadingPlaylistRef        = useRef(false); // prevents concurrent load_playlist calls
  const [msg, setMsg]               = useState<{ text: string; ok: boolean } | null>(null);
  const [importYtId, setImportYtId] = useState('');
  const [importName, setImportName] = useState('');
  const [importing, setImporting]   = useState(false);
  const [importResult, setImportResult] = useState<{ text: string; ok: boolean } | null>(null);

  const loadPlaylists = useCallback(async () => {
    try { const data = await getPlaylists(playerId); setPlaylists(data as typeof playlists); }
    catch (e) { console.error(e); }
  }, [playerId]);

  useEffect(() => { loadPlaylists(); }, [loadPlaylists]);
  useEffect(() => {
    if (expandedId) getPlaylistItems(expandedId).then(setPlaylistItems).catch(console.error);
  }, [expandedId]);

  const handleLoad = async (e: React.MouseEvent, playlist: Playlist) => {
    // Ref guard prevents concurrent load_playlist calls regardless of React render timing.
    // State guard (loadingId !== null) covers the UI, but there is a micro-race window
    // between setLoadingId() and the next render that the ref eliminates.
    if (isLoadingPlaylistRef.current) return;
    e.stopPropagation();
    setLoadingId(playlist.id);
    isLoadingPlaylistRef.current = true;
    try {
      // Single atomic call: clears normal queue, loads playlist, sets active_playlist_id,
      // updates player_status — all under pg_advisory_xact_lock in the load_playlist RPC.
      await callPlaylistManager({ action: 'load_playlist', player_id: playerId, playlist_id: playlist.id });
      setMsg({ text: `✓ Loaded "${playlist.name}" into queue`, ok: true });
      await loadPlaylists();
    } catch (e) { console.error(e); setMsg({ text: '❌ Failed to load playlist', ok: false }); }
    finally { setLoadingId(null); isLoadingPlaylistRef.current = false; }
  };

  const handleDelete = async (playlist: Playlist) => {
    if (!window.confirm(`Delete "${playlist.name}"? This cannot be undone.`)) return;
    try { await callPlaylistManager({ action: 'delete', player_id: playerId, playlist_id: playlist.id }); await loadPlaylists(); }
    catch (e) { console.error(e); }
  };

  const handleCreate = async () => {
    const name = window.prompt('New playlist name:');
    if (!name) return;
    try { await callPlaylistManager({ action: 'create', player_id: playerId, name }); await loadPlaylists(); }
    catch (e) { console.error(e); }
  };

  const handleImport = async () => {
    if (!importYtId.trim()) return;
    setImporting(true); setImportResult(null);
    try {
      const name = importName.trim() || `Imported ${importYtId.trim().slice(0, 12)}`;
      const created = await callPlaylistManager({ action: 'create', player_id: playerId, name }) as { playlist?: { id: string } };
      const playlistId = created?.playlist?.id;
      if (!playlistId) throw new Error('Failed to create playlist record');
      const ytUrl = `https://www.youtube.com/playlist?list=${importYtId.trim()}`;
      const result = await callPlaylistManager({ action: 'scrape', playlist_id: playlistId, url: ytUrl }) as { count?: number };
      setImportResult({ text: `✓ Imported ${result?.count ?? 0} videos into "${name}"`, ok: true });
      setImportYtId(''); setImportName('');
      await loadPlaylists();
    } catch (e: unknown) {
      setImportResult({ text: `❌ ${e instanceof Error ? e.message : 'Import failed'}`, ok: false });
    } finally { setImporting(false); }
  };

  if (view === 'playlists-import') return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <PanelHeader title="Import Playlist" subtitle="Scrape a YouTube playlist into Obie via Edge Function" />
      <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
        <div style={{ maxWidth: 480, background: 'rgba(255,255,255,0.025)', border: '1px solid var(--border)', borderRadius: 16, padding: 24 }}>
          {[{ label: 'YouTube Playlist ID *', value: importYtId, set: setImportYtId, ph: 'PLN9QqCogPsXJCgeL_iEgYnW6Rl_8nIUUH', mono: true },
            { label: 'Playlist Name (optional)', value: importName, set: setImportName, ph: 'My Custom Playlist', mono: false }].map(f => (
            <div key={f.label} style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontFamily: 'var(--font-display)', fontSize: 13, color: 'var(--muted)', marginBottom: 6 }}>{f.label}</label>
              <input value={f.value} onChange={e => f.set(e.target.value)} placeholder={f.ph}
                style={{ width: '100%', padding: '10px 14px', borderRadius: 10, background: '#0d0d0d', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', fontFamily: f.mono ? 'var(--font-mono)' : 'var(--font-display)', fontSize: 13, outline: 'none' }} />
            </div>
          ))}
          <button onClick={handleImport} disabled={importing || !importYtId.trim()}
            style={{ width: '100%', padding: '12px', borderRadius: 12, border: 'none', cursor: importing || !importYtId.trim() ? 'default' : 'pointer',
              background: 'var(--accent)', color: '#000', fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 700,
              opacity: importing || !importYtId.trim() ? 0.5 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            {importing ? <><Spinner size={16} /> Importing…</> : '📥 Import Playlist'}
          </button>
          {importResult && <div style={{ marginTop: 14, padding: '10px 14px', borderRadius: 9,
            background: importResult.ok ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
            border: `1px solid ${importResult.ok ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)'}`,
            color: importResult.ok ? '#4ade80' : '#f87171', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{importResult.text}</div>}
        </div>
      </div>
    </div>
  );

  // playlists-all
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const active = playlists.find(p => (p as any).is_active);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sorted = [...playlists].sort((a, b) => ((b as any).is_active ? 1 : 0) - ((a as any).is_active ? 1 : 0));
  const totalSongs = playlists.reduce((a, p) => a + (p.item_count ?? 0), 0);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <PanelHeader title="Playlists" subtitle={`${playlists.length} playlists · ${totalSongs.toLocaleString()} total songs`}
        actions={<Btn variant="accent" onClick={handleCreate}>＋ New Playlist</Btn>}
      />
      {msg && <div style={{ margin: '8px 24px 0', padding: '8px 12px', borderRadius: 8,
        background: msg.ok ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
        color: msg.ok ? '#4ade80' : '#f87171', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{msg.text}</div>}
      {active && (
        <div style={{ margin: '8px 24px 0', padding: '8px 14px', borderRadius: 8, background: 'var(--accent-dim)', border: '1px solid var(--accent-border)', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--accent)' }}>
          ▶ Currently Active: {active.name}
        </div>
      )}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 24px' }}>
        {sorted.map(playlist => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const isActive   = (playlist as any).is_active;
          const isExpanded = expandedId === playlist.id;
          return (
            <div key={playlist.id} style={{ marginBottom: 6, borderRadius: 13,
              background: isActive ? 'var(--accent-dim)' : 'rgba(255,255,255,0.025)',
              border: `1px solid ${isActive ? 'var(--accent-border)' : 'rgba(255,255,255,0.06)'}` }}>
              <div onClick={() => setExpandedId(isExpanded ? null : playlist.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px', cursor: 'pointer' }}>
                <div style={{ width: 40, height: 40, borderRadius: 10, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, background: isActive ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.06)' }}>🎵</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <span style={{ fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 600, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{playlist.name}</span>
                    {isActive && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, padding: '1px 6px', borderRadius: 99, background: 'rgba(34,197,94,0.18)', color: '#4ade80', textTransform: 'uppercase', letterSpacing: '0.05em', flexShrink: 0 }}>ACTIVE</span>}
                  </div>
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', marginTop: 2 }}>{(playlist.item_count ?? 0).toLocaleString()} songs</div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }} onClick={e => e.stopPropagation()}>
                  <Btn variant="accent" onClick={e => handleLoad(e, playlist)} disabled={loadingId !== null}>
                    {loadingId === playlist.id ? <Spinner size={12} /> : '▶ Load Queue'}
                  </Btn>
                  <Btn variant="danger" onClick={() => handleDelete(playlist)}>🗑</Btn>
                </div>
              </div>
              {isExpanded && (
                <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', maxHeight: 240, overflowY: 'auto', padding: '8px 14px 10px' }}>
                  {playlistItems.length === 0
                    ? <div style={{ color: 'rgba(255,255,255,0.25)', fontFamily: 'var(--font-mono)', fontSize: 11, padding: '8px 0' }}>No items loaded yet</div>
                    : playlistItems.slice(0, 50).map((item, i) => (
                        <div key={item.id} style={{ display: 'flex', gap: 9, padding: '5px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', alignItems: 'center' }}>
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'rgba(255,255,255,0.2)', width: 28 }}>{i + 1}</span>
                          <div style={{ fontFamily: 'var(--font-display)', fontSize: 12, color: 'rgba(255,255,255,0.7)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                            {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                            {cleanDisplayText((item.media_item as any)?.title) || 'Unknown'}
                            {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                            {(item.media_item as any)?.artist ? ` · ${cleanDisplayText((item.media_item as any).artist)}` : ''}
                          </div>
                        </div>
                      ))
                  }
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SETTINGS — shared layout helpers
// ─────────────────────────────────────────────────────────────────────────────

function SettingsRow({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
      <div>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 13, fontWeight: 500, color: '#e5e5e5' }}>{label}</div>
        {desc && <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(255,255,255,0.28)', marginTop: 2 }}>{desc}</div>}
      </div>
      <div style={{ flexShrink: 0, marginLeft: 16 }}>{children}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SETTINGS PANEL
// ─────────────────────────────────────────────────────────────────────────────

function SettingsPanel({ view, settings, prefs, playerId }: { view: ViewId; settings: PlayerSettings | null; prefs: Prefs; playerId: string }) {
  const [local, setLocal]     = useState<PlayerSettings | null>(null);
  const [credits, setCredits] = useState<number | null>(null);
  const [creditsLoading, setCreditsLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [saving, setSaving]   = useState(false);
  const [localMediaScanning, setLocalMediaScanning]     = useState(false);
  const [localMediaScanResult, setLocalMediaScanResult] = useState<{ count: number; path: string } | null>(null);

  useEffect(() => { setLocal(settings ? { ...settings } : null); }, [settings]);
  useEffect(() => {
    setCreditsLoading(true);
    getTotalCredits(playerId).then(setCredits).catch(console.error).finally(() => setCreditsLoading(false));

    const sub = subscribeToTable('kiosk_sessions', { column: 'player_id', value: playerId }, async () => {
      const total = await getTotalCredits(playerId).catch(() => null);
      if (total !== null) setCredits(total);
    });
    return () => sub.unsubscribe();
  }, [playerId]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const set = (k: keyof PlayerSettings, v: any) => setLocal(p => p ? { ...p, [k]: v } : p);

  const saveFields = async (fields: Partial<PlayerSettings>) => {
    setSaving(true); setError(null);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase as any).from('player_settings').update(fields).eq('player_id', playerId);
      if (error) throw error;
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Failed to save'); }
    finally { setSaving(false); }
  };

  const handleSavePlayback = () => local ? saveFields({ shuffle: local.shuffle, loop: local.loop, volume: local.volume, karaoke_mode: local.karaoke_mode, player_mode: local.player_mode }) : Promise.resolve();
  const handleSaveKiosk    = () => local ? saveFields({ freeplay: local.freeplay, coin_per_song: local.coin_per_song, search_enabled: local.search_enabled, max_queue_size: local.max_queue_size, priority_queue_limit: local.priority_queue_limit, local_media_path: (local as any).local_media_path ?? null } as Partial<PlayerSettings>) : Promise.resolve();
  const handleSaveBranding = () => local ? saveFields({ branding: local.branding }) : Promise.resolve();

  const handleToggle = async (field: keyof PlayerSettings) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newVal = !(local as any)?.[field];
    set(field, newVal);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabase as any).from('player_settings').update({ [field]: newVal }).eq('player_id', playerId);
    } catch (e) { console.error(e); set(field, !newVal); }
  };

  const handleAddCredits = async (amt: number) => {
    setCreditsLoading(true);
    try { await updateAllCredits(playerId, 'add', amt); setCredits(await getTotalCredits(playerId)); }
    catch (e) { console.error(e); } finally { setCreditsLoading(false); }
  };
  const handleClearCredits = async () => {
    setCreditsLoading(true);
    try { await updateAllCredits(playerId, 'clear'); setCredits(0); }
    catch (e) { console.error(e); } finally { setCreditsLoading(false); }
  };
  const handleResetPriorityPlayer = async () => {
    try { await callPlayerControl({ player_id: playerId, action: 'reset_priority' }); }
    catch (e) { console.error(e); }
  };

  const handleScanLocalMedia = async () => {
    if (!('showDirectoryPicker' in window)) {
      setLocalMediaScanResult({ count: -1, path: 'Browser does not support directory picker' });
      return;
    }
    setLocalMediaScanning(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dirHandle = await (window as any).showDirectoryPicker({ mode: 'read' });
      const videoExts = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v', '.ogv', '.mpg', '.mpeg', '.wmv', '.flv']);
      let count = 0;
      for await (const entry of dirHandle.values()) {
        if (entry.kind === 'file') {
          const dot = entry.name.lastIndexOf('.');
          if (dot !== -1 && videoExts.has(entry.name.slice(dot).toLowerCase())) count++;
        }
      }
      const dirName: string = dirHandle.name;
      set('local_media_path' as keyof PlayerSettings, dirName);
      setLocalMediaScanResult({ count, path: dirName });
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') console.error('Directory scan error:', e);
    } finally {
      setLocalMediaScanning(false);
    }
  };

  if (!local) return <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spinner /></div>;

  const errBlock = error && (
    <div style={{ padding: '8px 12px', borderRadius: 9, background: 'rgba(239,68,68,0.1)', color: '#f87171', fontFamily: 'var(--font-mono)', fontSize: 11, marginBottom: 16 }}>{error}</div>
  );

  const wrap = (title: string, subtitle: string, content: React.ReactNode, onSave: () => Promise<void>) => (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <PanelHeader title={title} subtitle={subtitle} />
      <div style={{ flex: 1, overflowY: 'scroll', padding: 24 }}>
        <div style={{ maxWidth: 480 }}>{errBlock}{content}<div style={{ marginTop: 20 }}><SaveBtn onSave={onSave} loading={saving} /></div></div>
      </div>
    </div>
  );

  if (view === 'settings-playback') return wrap('Playback Settings', 'Queue and player behaviour', <>
    <SettingsRow label="Shuffle Playlist when loaded"  desc="Randomly reorder Up Next when a new playlist is loaded (Now Playing is never moved)"><Toggle checked={!!local.shuffle}      onChange={() => handleToggle('shuffle')} /></SettingsRow>
    <SettingsRow label="Loop Playlist"    desc="Restart from beginning when queue ends"><Toggle checked={!!local.loop}         onChange={() => handleToggle('loop')} /></SettingsRow>
    {'karaoke_mode' in local && <SettingsRow label="Karaoke Mode" desc="Enable karaoke UI on kiosk"><Toggle checked={!!local.karaoke_mode} onChange={() => handleToggle('karaoke_mode')} /></SettingsRow>}
    <SettingsRow label={`Volume: ${local.volume ?? 75}`} desc="Default player volume">
      <input type="range" min={0} max={100} value={local.volume ?? 75} onChange={e => set('volume', Number(e.target.value))} style={{ width: 160 }} />
    </SettingsRow>
    {'player_mode' in local && (
      <SettingsRow label="Player Mode" desc="iFrame embeds YouTube directly; ytm_desktop routes playback through YTM Desktop Companion (localhost:9863)">
        <select
          value={local.player_mode ?? 'iframe'}
          onChange={e => set('player_mode', e.target.value as 'iframe' | 'ytm_desktop')}
          style={{ padding: '7px 12px', borderRadius: 9, background: '#111', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', fontFamily: 'var(--font-mono)', fontSize: 13, outline: 'none', cursor: 'pointer' }}
        >
          <option value="iframe">iFrame Player</option>
          <option value="ytm_desktop">ytm_desktop API</option>
        </select>
      </SettingsRow>
    )}
  </>, handleSavePlayback);

  if (view === 'settings-kiosk') return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <PanelHeader title="Kiosk Settings" subtitle="Request, credits and coin acceptor configuration" />
      <div style={{ flex: 1, overflowY: 'scroll', padding: 24 }}>
        <div style={{ maxWidth: 480 }}>{errBlock}
          <SettingsRow label="Free Play"              desc="Allow requests without credits"><Toggle checked={!!local.freeplay}        onChange={() => handleToggle('freeplay')} /></SettingsRow>
          <SettingsRow label="Search Enabled"         desc="Allow kiosk users to search songs"><Toggle checked={!!local.search_enabled}  onChange={() => handleToggle('search_enabled')} /></SettingsRow>
          {'kiosk_show_virtual_coin_button' in local && (
            <SettingsRow label="Show Virtual Coin Button" desc="Display INSERT COIN button on kiosk">
              <Toggle checked={!!local.kiosk_show_virtual_coin_button} onChange={() => handleToggle('kiosk_show_virtual_coin_button' as keyof PlayerSettings)} />
            </SettingsRow>
          )}
          {[{ label: 'Credits per Song', key: 'coin_per_song', desc: 'credits required per request' },
            { label: 'Max Queue Size',   key: 'max_queue_size', desc: 'max songs in normal queue' },
            { label: 'Priority Queue Limit', key: 'priority_queue_limit', desc: 'max priority request slots' }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ].map(({ label, key, desc }) => (<SettingsRow key={key} label={label} desc={desc}>
            <input type="number" min={1} value={(local as any)[key] ?? 1} onChange={e => set(key as keyof PlayerSettings, Number(e.target.value))}
              style={{ width: 72, textAlign: 'center', padding: '7px 10px', borderRadius: 9, background: '#111', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', fontFamily: 'var(--font-mono)', fontSize: 13, outline: 'none' }} />
          </SettingsRow>))}
          {(local as any).local_media_enabled !== undefined && (
            <SettingsRow label="Include Local Media from this device" desc="Play video files from a local folder alongside YouTube content">
              <Toggle checked={!!(local as any).local_media_enabled} onChange={() => handleToggle('local_media_enabled' as keyof PlayerSettings)} />
            </SettingsRow>
          )}
          <div style={{ marginTop: 20 }}><SaveBtn onSave={handleSaveKiosk} loading={saving} /></div>

          {/* Local Media folder */}
          {(local as any).local_media_enabled && (
            <div style={{ marginTop: 16, padding: 18, borderRadius: 14, background: 'rgba(255,255,255,0.025)', border: '1px solid var(--border)' }}>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 600, color: '#fff', marginBottom: 10 }}>Local Media Folder</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(255,255,255,0.35)', marginBottom: 12 }}>
                Provide the path to a folder containing local video files, or use Browse &amp; Scan to pick a folder.
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  type="text"
                  placeholder="/path/to/local/videos"
                  value={(local as any).local_media_path ?? ''}
                  onChange={e => set('local_media_path' as keyof PlayerSettings, e.target.value)}
                  style={{ flex: 1, padding: '9px 12px', borderRadius: 9, background: '#111', border: '1px solid rgba(255,255,255,0.12)', color: '#fff', fontFamily: 'var(--font-mono)', fontSize: 12, outline: 'none' }}
                />
                <Btn variant="ghost" onClick={handleScanLocalMedia} disabled={localMediaScanning}>
                  {localMediaScanning ? '…' : '📁 Browse & Scan'}
                </Btn>
              </div>
              {localMediaScanResult && (
                <div style={{ marginTop: 10, padding: '10px 14px', borderRadius: 9, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  background: localMediaScanResult.count > 0 ? 'rgba(34,197,94,0.1)' : 'rgba(251,191,36,0.1)',
                  border: `1px solid ${localMediaScanResult.count > 0 ? 'rgba(74,222,128,0.3)' : 'rgba(251,191,36,0.3)'}` }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: localMediaScanResult.count > 0 ? '#4ade80' : '#fbbf24' }}>
                    {localMediaScanResult.count < 0
                      ? `⚠ ${localMediaScanResult.path}`
                      : localMediaScanResult.count > 0
                        ? `✓ Found ${localMediaScanResult.count} video file${localMediaScanResult.count !== 1 ? 's' : ''} in "${localMediaScanResult.path}"`
                        : `⚠ No video files found in "${localMediaScanResult.path}"`}
                  </span>
                  <button onClick={() => setLocalMediaScanResult(null)}
                    style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 11, padding: '2px 8px' }}>
                    OK
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Credits block */}
          <div style={{ marginTop: 28, padding: 18, borderRadius: 14, background: 'rgba(255,255,255,0.025)', border: '1px solid var(--border)' }}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 600, color: '#fff', marginBottom: 12 }}>Kiosk Credits</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 700, color: 'var(--accent)', marginRight: 8 }}>{creditsLoading ? '…' : credits ?? 0}</div>
              <Btn variant="accent" onClick={() => handleAddCredits(1)} disabled={creditsLoading}>+1</Btn>
              <Btn variant="accent" onClick={() => handleAddCredits(3)} disabled={creditsLoading}>+3</Btn>
              <Btn variant="danger" onClick={handleClearCredits} disabled={creditsLoading}>Clear</Btn>
            </div>
          </div>

          {/* Coin acceptor */}
          {'kiosk_coin_acceptor_enabled' in local && (
            <div style={{ marginTop: 16, padding: 18, borderRadius: 14, background: 'rgba(255,255,255,0.025)', border: '1px solid var(--border)' }}>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 600, color: '#fff', marginBottom: 10 }}>Coin Acceptor Hardware</div>
              <button onClick={() => handleToggle('kiosk_coin_acceptor_enabled' as keyof PlayerSettings)} style={{ padding: '9px 18px', borderRadius: 10, border: 'none', cursor: 'pointer', fontFamily: 'var(--font-display)', fontSize: 13, fontWeight: 600,
                background: local.kiosk_coin_acceptor_enabled ? (local.kiosk_coin_acceptor_connected ? 'rgba(34,197,94,0.18)' : 'rgba(251,191,36,0.15)') : 'rgba(59,130,246,0.15)',
                color:      local.kiosk_coin_acceptor_enabled ? (local.kiosk_coin_acceptor_connected ? '#4ade80'              : '#fbbf24')                  : '#60a5fa' }}>
                {local.kiosk_coin_acceptor_enabled ? (local.kiosk_coin_acceptor_connected ? '🟢 Connected' : '🟡 Connecting…') : '🔵 Enable Coin Acceptor'}
              </button>
              {local.kiosk_coin_acceptor_device_id && <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(255,255,255,0.35)', marginTop: 8 }}>Device: {local.kiosk_coin_acceptor_device_id}</div>}
            </div>
          )}

          {/* Priority player reset */}
          <div style={{ marginTop: 16, padding: 18, borderRadius: 14, background: 'rgba(255,255,255,0.025)', border: '1px solid var(--border)' }}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 600, color: '#fff', marginBottom: 6 }}>Priority Player</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(255,255,255,0.35)', marginBottom: 12 }}>Clears priority designation. The next player to initialise will claim it.</div>
            <Btn variant="ghost" onClick={handleResetPriorityPlayer}>🔄 Reset Priority Player</Btn>
          </div>
        </div>
      </div>
    </div>
  );

  if (view === 'settings-branding') return wrap('Branding', 'Kiosk display settings', <>
    {[{ label: 'Jukebox Name', key: 'name', ph: 'Obie Jukebox', mono: false }, { label: 'Logo URL', key: 'logo', ph: 'https://example.com/logo.png', mono: true }].map(f => (
      <div key={f.key} style={{ marginBottom: 16 }}>
        <label style={{ display: 'block', fontFamily: 'var(--font-display)', fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>{f.label}</label>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        <input value={(local.branding as any)?.[f.key] || ''} onChange={e => set('branding', { ...local.branding, [f.key]: e.target.value })} placeholder={f.ph}
          style={{ width: '100%', padding: '10px 14px', borderRadius: 10, background: '#0d0d0d', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', fontFamily: f.mono ? 'var(--font-mono)' : 'var(--font-display)', fontSize: 13, outline: 'none' }} />
      </div>
    ))}
    <div>
      <label style={{ display: 'block', fontFamily: 'var(--font-display)', fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>Theme</label>
      <div style={{ display: 'flex', gap: 8 }}>
        {['dark', 'light'].map(t => (
          <button key={t} onClick={() => set('branding', { ...local.branding, theme: t })}
            style={{ flex: 1, padding: '9px', borderRadius: 10, cursor: 'pointer', fontFamily: 'var(--font-display)', fontSize: 13,
              border: `1px solid ${local.branding?.theme === t ? 'var(--accent-border)' : 'rgba(255,255,255,0.08)'}`,
              background: local.branding?.theme === t ? 'var(--accent-dim)' : 'rgba(255,255,255,0.04)',
              color: local.branding?.theme === t ? 'var(--accent)' : 'rgba(255,255,255,0.4)' }}>
            {t === 'dark' ? '🌙 Dark' : '☀️ Light'}
          </button>
        ))}
      </div>
    </div>
  </>, handleSaveBranding);

  // prefs
  return <ConsolePrefsPanel prefs={prefs} />;
}

// ─────────────────────────────────────────────────────────────────────────────
// SCRIPTS PANEL  (real Edge Function calls)
// ─────────────────────────────────────────────────────────────────────────────

interface ScriptLog { ts: string; text: string; level: 'info' | 'ok' | 'err'; }

function ScriptCard({ icon, name, desc, category, onRun, input }: {
  icon: string; name: string; desc: string; category: string;
  onRun: (input: string, log: (e: ScriptLog) => void) => Promise<void>;
  input?: { label: string; placeholder: string; required?: boolean };
}) {
  const [inputVal, setInputVal] = useState('');
  const [running, setRunning]   = useState(false);
  const [logs, setLogs]         = useState<ScriptLog[]>([]);
  const [done, setDone]         = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const addLog = useCallback((entry: ScriptLog) => {
    setLogs(prev => [...prev, entry]);
    setTimeout(() => logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' }), 50);
  }, []);

  const handleRun = async () => {
    if (input?.required && !inputVal.trim()) return;
    setRunning(true); setDone(false); setLogs([]);
    try { await onRun(inputVal.trim(), addLog); setDone(true); }
    catch (e: unknown) { addLog({ ts: new Date().toLocaleTimeString(), text: `Error: ${e instanceof Error ? e.message : String(e)}`, level: 'err' }); }
    finally { setRunning(false); }
  };

  return (
    <div style={{ borderRadius: 16, marginBottom: 10, overflow: 'hidden', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, padding: '17px 18px' }}>
        <span style={{ fontSize: 22, flexShrink: 0, marginTop: 1 }}>{icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: '#e5e5e5' }}>{name}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, padding: '1px 7px', borderRadius: 99, background: 'var(--accent-dim)', color: 'var(--accent)' }}>{category}</span>
          </div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 12, color: 'rgba(255,255,255,0.4)', marginBottom: input ? 10 : 0 }}>{desc}</div>
          {input && (
            <input value={inputVal} onChange={e => setInputVal(e.target.value)} placeholder={input.placeholder} disabled={running}
              style={{ width: '100%', padding: '8px 12px', borderRadius: 9, background: '#0d0d0d', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', fontFamily: 'var(--font-mono)', fontSize: 12, outline: 'none' }} />
          )}
        </div>
        <div style={{ flexShrink: 0 }}>
          {done
            ? <Btn variant="ghost" onClick={() => { setLogs([]); setDone(false); setInputVal(''); }}>Reset</Btn>
            : <Btn variant="solid" onClick={handleRun} disabled={running || (!!input?.required && !inputVal.trim())}>
                {running ? <><Spinner size={12} /> Running…</> : '▶ Run'}
              </Btn>
          }
        </div>
      </div>
      {logs.length > 0 && (
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 18px', background: 'rgba(0,0,0,0.5)' }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: done ? '#22c55e' : running ? 'var(--accent)' : '#f87171', animation: running ? 'pulse 1s ease-in-out infinite' : 'none' }} />
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{done ? 'Completed' : running ? 'Running' : 'Stopped'}</span>
          </div>
          <div ref={logRef} style={{ maxHeight: 180, overflowY: 'auto', padding: '10px 18px', background: 'rgba(0,0,0,0.7)' }}>
            {logs.map((l, i) => (
              <div key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: l.level === 'err' ? '#f87171' : l.level === 'ok' ? '#4ade80' : '#a3e635', marginBottom: 3 }}>
                <span style={{ color: 'rgba(255,255,255,0.25)', marginRight: 8 }}>{l.ts}</span>{l.text}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ScriptsPanel({ playerId }: { playerId: string }) {
  const now = () => new Date().toLocaleTimeString();
  const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

  const importSingle = async (ytId: string, name: string, log: (e: ScriptLog) => void) => {
    log({ ts: now(), text: `Creating playlist: "${name}"…`, level: 'info' });
    const created = await callPlaylistManager({ action: 'create', player_id: playerId, name }) as { playlist?: { id: string } };
    const playlistId = created?.playlist?.id;
    if (!playlistId) throw new Error('Server did not return playlist ID');
    log({ ts: now(), text: `✓ Created: ${playlistId}`, level: 'ok' });

    const ytUrl = `https://www.youtube.com/playlist?list=${ytId}`;
    log({ ts: now(), text: `Scraping YouTube: ${ytUrl}…`, level: 'info' });
    const result = await callPlaylistManager({ action: 'scrape', playlist_id: playlistId, url: ytUrl }) as { count?: number };
    log({ ts: now(), text: `✓ Imported ${result?.count ?? 0} videos.`, level: 'ok' });
  };

  const runImportSingle = async (input: string, log: (e: ScriptLog) => void) => {
    const [ytId, ...rest] = input.split('|').map(s => s.trim());
    const name = rest.join('|').trim() || `Playlist ${ytId}`;
    if (!ytId) throw new Error('No Playlist ID provided');
    await importSingle(ytId, name, log);
  };

  const runImportAll = async (_: string, log: (e: ScriptLog) => void) => {
    log({ ts: now(), text: `Starting import of ${PREDEFINED_PLAYLISTS.length} playlists…`, level: 'info' });
    let ok = 0, fail = 0;
    for (const { ytId, name } of PREDEFINED_PLAYLISTS) {
      try {
        log({ ts: now(), text: `Processing: ${name}`, level: 'info' });
        await importSingle(ytId, name, log);
        ok++;
        await delay(3000);
      } catch (e: unknown) {
        log({ ts: now(), text: `✗ ${name}: ${e instanceof Error ? e.message : String(e)}`, level: 'err' });
        fail++;
      }
    }
    log({ ts: now(), text: `Done. ${ok} succeeded, ${fail} failed.`, level: ok > 0 ? 'ok' : 'err' });
  };

  const runRetryFailed = async (_: string, log: (e: ScriptLog) => void) => {
    log({ ts: now(), text: 'Fetching existing playlists…', level: 'info' });
    const { data } = await supabase.from('playlists' as 'playlists').select('id,name').eq('player_id' as 'id', playerId);
    const rows = (data || []) as { id: string; name: string }[];
    const existingNames = new Set(rows.map(p => p.name));
    const toRetry = PREDEFINED_PLAYLISTS.filter(p => existingNames.has(p.name));
    if (toRetry.length === 0) { log({ ts: now(), text: 'No matching playlists found. Run "Import All" first.', level: 'err' }); return; }
    log({ ts: now(), text: `Found ${toRetry.length} playlist(s) to retry.`, level: 'info' });
    let ok = 0, fail = 0;
    for (const p of toRetry) {
      const row = rows.find(r => r.name === p.name);
      if (!row) { fail++; continue; }
      try {
        const ytUrl = `https://www.youtube.com/playlist?list=${p.ytId}`;
        log({ ts: now(), text: `Re-scraping: ${p.name}`, level: 'info' });
        const result = await callPlaylistManager({ action: 'scrape', playlist_id: row.id, url: ytUrl }) as { count?: number };
        log({ ts: now(), text: `✓ ${p.name}: ${result?.count ?? 0} videos`, level: 'ok' });
        ok++;
        await delay(3000);
      } catch (e: unknown) { log({ ts: now(), text: `✗ ${p.name}: ${e instanceof Error ? e.message : String(e)}`, level: 'err' }); fail++; }
    }
    log({ ts: now(), text: `Done. ${ok} succeeded, ${fail} failed.`, level: ok > 0 ? 'ok' : 'err' });
  };

  const runScrapeYtScraper = async (input: string, log: (e: ScriptLog) => void) => {
    const url = input.startsWith('http') ? input : `https://www.youtube.com/playlist?list=${input}`;
    log({ ts: now(), text: `Calling youtube-scraper for: ${url}`, level: 'info' });
    const data = await callYouTubeScraper({ url });
    log({ ts: now(), text: `✓ Scraped ${(data as { count?: number })?.count ?? '?'} items.`, level: 'ok' });
  };

  // deduplicate-all-playlists: remove items where the same media_item_id
  // appears more than once within the same playlist (keeps lowest position).
  const runDeduplicateAllPlaylists = async (_: string, log: (e: ScriptLog) => void) => {
    log({ ts: now(), text: 'Fetching playlists…', level: 'info' });
    const { data: playlists, error: plErr } = await supabase
      .from('playlists' as 'playlists')
      .select('id,name')
      .eq('player_id' as 'id', playerId);
    if (plErr) throw plErr;
    if (!playlists?.length) { log({ ts: now(), text: 'No playlists found.', level: 'err' }); return; }

    log({ ts: now(), text: `Checking ${playlists.length} playlist(s)…`, level: 'info' });
    let totalRemoved = 0;

    for (const playlist of (playlists as { id: string; name: string }[])) {
      const { data: items, error: itemErr } = await supabase
        .from('playlist_items' as 'playlist_items')
        .select('id,media_item_id,position')
        .eq('playlist_id' as 'id', playlist.id)
        .order('position' as 'id', { ascending: true });
      if (itemErr) { log({ ts: now(), text: `  ✗ ${playlist.name}: ${itemErr.message}`, level: 'err' }); continue; }

      const rows = (items || []) as { id: string; media_item_id: string; position: number }[];
      const seen = new Set<string>();
      const toDelete: string[] = [];
      for (const row of rows) {
        if (seen.has(row.media_item_id)) toDelete.push(row.id);
        else seen.add(row.media_item_id);
      }

      if (toDelete.length === 0) {
        log({ ts: now(), text: `  ✓ ${playlist.name}: no duplicates`, level: 'ok' });
        continue;
      }

      const { error: delErr } = await supabase
        .from('playlist_items' as 'playlist_items')
        .delete()
        .in('id' as 'id', toDelete);
      if (delErr) { log({ ts: now(), text: `  ✗ ${playlist.name}: ${delErr.message}`, level: 'err' }); continue; }

      // Re-sequence positions on the survivors to close the gaps.
      const survivors = rows.filter(r => !toDelete.includes(r.id));
      for (let i = 0; i < survivors.length; i++) {
        await supabase.from('playlist_items' as 'playlist_items').update({ position: i } as never).eq('id' as 'id', survivors[i].id);
      }

      log({ ts: now(), text: `  ✓ ${playlist.name}: removed ${toDelete.length} duplicate${toDelete.length === 1 ? '' : 's'}`, level: 'ok' });
      totalRemoved += toDelete.length;
    }

    log({ ts: now(), text: `Done. ${totalRemoved} total duplicate${totalRemoved === 1 ? '' : 's'} removed across all playlists.`, level: totalRemoved > 0 ? 'ok' : 'info' });
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <PanelHeader title="Functions & Scripts" subtitle="Invoke server-side operations via Supabase Edge Functions" />
      <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
        <ScriptCard icon="📥" name="import-single-playlist" category="Playlists"
          desc="Import a single YouTube playlist. Enter the YouTube Playlist ID, optionally followed by | and a name."
          input={{ label: 'YouTube Playlist ID | Name', placeholder: 'PLN9QqCogPsXJCgeL_iEgYnW6Rl_8nIUUH|Obie Playlist', required: true }}
          onRun={runImportSingle}
        />
        <ScriptCard icon="📦" name="import-all-playlists" category="Playlists"
          desc={`Import all ${PREDEFINED_PLAYLISTS.length} predefined Obie playlists from YouTube with a 3-second delay between each.`}
          onRun={runImportAll}
        />
        <ScriptCard icon="🔄" name="retry-failed-playlists" category="Playlists"
          desc="Re-scrape predefined playlists already in the database — useful when an import partially failed."
          onRun={runRetryFailed}
        />
        <ScriptCard icon="🧹" name="deduplicate-all-playlists" category="Playlists"
          desc="Remove duplicate tracks within each playlist (same video appearing more than once). Keeps the first occurrence (lowest position) and re-sequences positions."
          onRun={runDeduplicateAllPlaylists}
        />
        <ScriptCard icon="🔍" name="youtube-scraper" category="YouTube"
          desc="Directly invoke the youtube-scraper Edge Function with any YouTube playlist URL."
          input={{ label: 'YouTube URL or Playlist ID', placeholder: 'https://www.youtube.com/playlist?list=PL…', required: true }}
          onRun={runScrapeYtScraper}
        />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSOLE PREFERENCES PANEL
// ─────────────────────────────────────────────────────────────────────────────

function ConsolePrefsPanel({ prefs }: { prefs: Prefs }) {
  const { accent, setAccent, fsIdx, setFsIdx } = prefs;
  const [hexInput, setHexInput] = useState(accent.replace('#', ''));
  const [fsSaved,  setFsSaved]  = useState(false);
  const [colSaved, setColSaved] = useState(false);

  useEffect(() => { setHexInput(accent.replace('#', '')); }, [accent]);

  const applyHex = (hex: string) => { if (/^[0-9a-fA-F]{6}$/.test(hex)) setAccent('#' + hex); };

  const handleFontSize = (idx: number) => { setFsIdx(idx); setFsSaved(true); setTimeout(() => setFsSaved(false), 2000); };
  const handleColour   = (hex: string) => { setAccent(hex); setHexInput(hex.replace('#', '')); setColSaved(true); setTimeout(() => setColSaved(false), 2000); };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <PanelHeader title="Console Preferences" subtitle="Appearance settings — saved automatically to this browser" />
      <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
        <div style={{ maxWidth: 520 }}>

          {/* Font size */}
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.28)', marginBottom: 10, paddingBottom: 7, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>Text &amp; Display Size</div>
          <div style={{ padding: '16px 18px', borderRadius: 14, background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.07)', marginBottom: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 13, fontWeight: 500, color: '#e5e5e5', flex: 1 }}>
                Interface Text Size
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(255,255,255,0.28)', marginTop: 2 }}>Scales all text and layout proportionally</div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                {FS_SCALES.map((s, i) => (
                  <button key={i} onClick={() => handleFontSize(i)} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, padding: '7px 9px', borderRadius: 10, cursor: 'pointer',
                    border: `1px solid ${fsIdx === i ? 'var(--accent-border)' : 'rgba(255,255,255,0.09)'}`,
                    background: fsIdx === i ? 'var(--accent-dim)' : 'rgba(255,255,255,0.04)' }}>
                    <span style={{ fontFamily: 'var(--font-display)', fontSize: 10 + i * 2, lineHeight: 1, color: fsIdx === i ? 'var(--accent)' : 'rgba(255,255,255,0.5)' }}>Aa</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: 'rgba(255,255,255,0.3)' }}>{s.label}</span>
                  </button>
                ))}
              </div>
            </div>
            {fsSaved && <div style={{ marginTop: 10, fontFamily: 'var(--font-mono)', fontSize: 10, color: '#4ade80' }}>✓ Font size saved</div>}
          </div>

          {/* Accent colour */}
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.28)', marginBottom: 10, paddingBottom: 7, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>Theme Accent Colour</div>
          <div style={{ padding: '18px', borderRadius: 14, background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.07)', marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
              {/* Colour wheel */}
              <div style={{ position: 'relative', flexShrink: 0 }}>
                <div style={{ width: 52, height: 52, borderRadius: '50%', background: 'conic-gradient(hsl(0,100%,50%),hsl(60,100%,50%),hsl(120,100%,50%),hsl(180,100%,50%),hsl(240,100%,50%),hsl(300,100%,50%),hsl(360,100%,50%))', border: `3px solid ${accent}60`, cursor: 'pointer', position: 'relative', overflow: 'hidden' }}>
                  <input type="color" value={accent} onChange={e => { setAccent(e.target.value); setHexInput(e.target.value.replace('#','')); }} onBlur={e => handleColour(e.target.value)}
                    style={{ opacity: 0, position: 'absolute', inset: 0, width: '100%', height: '100%', cursor: 'pointer' }} />
                </div>
                <div style={{ position: 'absolute', bottom: -2, right: -2, width: 16, height: 16, borderRadius: '50%', background: accent, border: '2px solid #111', boxShadow: `0 0 8px ${accent}60` }} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 13, fontWeight: 500, color: '#e5e5e5' }}>Highlight Colour</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(255,255,255,0.28)', marginTop: 2 }}>Applied to nav active state, buttons, progress bars, and glows</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'rgba(255,255,255,0.3)' }}>#</span>
                  <input value={hexInput}
                    onChange={e => { const v = e.target.value.replace(/[^0-9a-fA-F]/g,'').slice(0,6); setHexInput(v); applyHex(v); }}
                    onBlur={() => { if (hexInput.length === 6) handleColour('#' + hexInput); }}
                    style={{ width: 90, padding: '5px 9px', borderRadius: 8, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', color: '#fff', fontFamily: 'var(--font-mono)', fontSize: 12, outline: 'none' }} />
                  <button onClick={() => handleColour('#f59e0b')} style={{ padding: '5px 10px', borderRadius: 8, background: 'rgba(255,255,255,0.07)', border: 'none', color: 'rgba(255,255,255,0.5)', cursor: 'pointer', fontFamily: 'var(--font-display)', fontSize: 11 }}>Reset</button>
                </div>
              </div>
              <div style={{ width: 40, height: 40, borderRadius: 10, background: accent, flexShrink: 0, border: '2px solid rgba(255,255,255,0.15)', boxShadow: `0 0 16px ${accent}60` }} />
            </div>

            {/* Preset swatches */}
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'rgba(255,255,255,0.28)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Quick Presets</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
              {PRESET_COLOURS.map(p => (
                <button key={p.hex} title={p.name} onClick={() => handleColour(p.hex)}
                  style={{ width: 30, height: 30, borderRadius: 8, background: p.hex, cursor: 'pointer',
                    border: `2px solid ${accent.toLowerCase() === p.hex.toLowerCase() ? '#fff' : 'transparent'}`,
                    transform: accent.toLowerCase() === p.hex.toLowerCase() ? 'scale(1.15)' : 'scale(1)', transition: 'transform 0.12s' }} />
              ))}
            </div>

            {/* Preview strip */}
            <div style={{ marginTop: 14, padding: '10px 14px', borderRadius: 10, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'rgba(255,255,255,0.28)', flexShrink: 0 }}>PREVIEW</span>
              <div style={{ width: 3, height: 16, borderRadius: 99, background: accent, flexShrink: 0 }} />
              <div style={{ padding: '2px 8px', borderRadius: 99, background: `${accent}25`, border: `1px solid ${accent}50`, fontFamily: 'var(--font-mono)', fontSize: 9, color: accent }}>● LIVE</div>
              <div style={{ flex: 1, height: 3, borderRadius: 99, background: `linear-gradient(90deg,${accent},${accent}40)` }} />
              <div style={{ padding: '4px 10px', borderRadius: 8, background: accent, fontFamily: 'var(--font-display)', fontSize: 10, fontWeight: 700, color: isLightColour(accent) ? '#000' : '#fff' }}>Save</div>
            </div>
            {colSaved && <div style={{ marginTop: 8, fontFamily: 'var(--font-mono)', fontSize: 10, color: '#4ade80' }}>✓ Colour saved</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LOGS PANEL
// ─────────────────────────────────────────────────────────────────────────────

function LogsPanel() {
  const [logs, setLogs]       = useState<SystemLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter]   = useState<'all' | 'info' | 'warn' | 'error'>('all');
  const [search, setSearch]   = useState('');

  useEffect(() => {
    const loadLogs = async () => {
      try {
        const { data } = await supabase.from('system_logs').select('*').order('timestamp', { ascending: false }).limit(200);
        setLogs((data as unknown as SystemLog[]) || []);
      } catch (error) {
        console.error(error);
      } finally {
        setLoading(false);
      }
    };
    loadLogs();
    setLoading(true);
    const channel = supabase.channel('system_logs:realtime');
    channel.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'system_logs' }, (payload: { new: SystemLog }) => {
      setLogs(prev => [payload.new, ...prev].slice(0, 200));
    }).subscribe();
    return () => { supabase.removeChannel(channel); };
  }, []);

  const filtered = logs.filter(l => {
    if (filter !== 'all' && l.severity !== filter) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!l.event?.toLowerCase().includes(q) && !JSON.stringify(l.payload).toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const lStyle = (s: string) => {
    if (s === 'error') return { bg: 'rgba(239,68,68,0.1)', color: '#f87171', border: 'rgba(239,68,68,0.2)' };
    if (s === 'warn')  return { bg: 'rgba(251,191,36,0.1)', color: '#fbbf24', border: 'rgba(251,191,36,0.2)' };
    return                   { bg: 'rgba(59,130,246,0.1)',  color: '#60a5fa', border: 'rgba(59,130,246,0.2)' };
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <PanelHeader title="System Logs" subtitle="Real-time event stream · last 200 entries"
        actions={<>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 11px', borderRadius: 9, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}>
            <span style={{ fontSize: 12 }}>🔍</span>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…"
              style={{ background: 'transparent', border: 'none', outline: 'none', color: '#fff', fontFamily: 'var(--font-mono)', fontSize: 11, width: 130 }} />
          </div>
          {(['all','info','warn','error'] as const).map(lv => {
            const s = lStyle(lv); const active = filter === lv;
            return (
              <button key={lv} onClick={() => setFilter(lv)} style={{ padding: '5px 10px', borderRadius: 8, cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 10, textTransform: 'uppercase',
                border: `1px solid ${active ? s.border : 'rgba(255,255,255,0.07)'}`,
                background: active ? s.bg : 'rgba(255,255,255,0.04)',
                color: active ? s.color : 'rgba(255,255,255,0.38)' }}>{lv}</button>
            );
          })}
        </>}
      />
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 24px' }}>
        {loading ? <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 40 }}><Spinner /></div>
          : filtered.length === 0 ? <div style={{ color: 'rgba(255,255,255,0.25)', fontFamily: 'var(--font-mono)', fontSize: 12, textAlign: 'center', paddingTop: 40 }}>No logs found</div>
          : filtered.map(log => {
              const s = lStyle(log.severity);
              return (
                <div key={log.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '9px 12px', borderRadius: 10, marginBottom: 4, background: 'rgba(255,255,255,0.018)', border: '1px solid rgba(255,255,255,0.04)' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(255,255,255,0.22)', flexShrink: 0, width: 60, paddingTop: 1 }}>{new Date(log.timestamp).toLocaleTimeString()}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, padding: '1px 6px', borderRadius: 5, flexShrink: 0, textTransform: 'uppercase', background: s.bg, color: s.color, border: `1px solid ${s.border}`, marginTop: 1 }}>{log.severity}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--accent)', flexShrink: 0, width: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{log.event}</span>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'rgba(255,255,255,0.55)', flex: 1, wordBreak: 'break-word' }}>
                    {log.payload?.action && <span>{log.payload.action}</span>}
                    {log.payload?.title  && <span> · {log.payload.title}</span>}
                    {log.payload?.details && <span> · {log.payload.details}</span>}
                    {!log.payload?.action && !log.payload?.title && log.payload && Object.keys(log.payload).length > 0 && (
                      <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: 10 }}>{JSON.stringify(log.payload)}</span>
                    )}
                  </div>
                </div>
              );
            })
        }
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ROOT APP
// ─────────────────────────────────────────────────────────────────────────────

function App() {
  const [user, setUser]         = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [resolvedPlayerId, setResolvedPlayerId] = useState<string | null>(null);
  const [resolvedJukeboxSlug, setResolvedJukeboxSlug] = useState<string | null>(null);
  const [availableJukeboxes, setAvailableJukeboxes] = useState<JukeboxSummary[]>([]);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [view, setView]         = useState<ViewId>('queue');
  const [queue, setQueue]       = useState<QueueItem[]>([]);
  const [status, setStatus]     = useState<PlayerStatus | null>(null);
  const [settings, setSettings] = useState<PlayerSettings | null>(null);
  const [isShuffling, setIsShuffling] = useState(false);
  const [isSkipping,  setIsSkipping]  = useState(false);
  const isSkippingRef = useRef(false);
  useEffect(() => { isSkippingRef.current = isSkipping; }, [isSkipping]);

  const prefs = usePrefs();

  // Auth
  useEffect(() => {
    getCurrentUser()
      .then(setUser)
      .catch((err) => {
        console.error('[Auth] Failed to fetch current user:', err);
        setUser(null);
      })
      .finally(() => setAuthLoading(false));
    const sub = subscribeToAuth(setUser);
    return () => sub.unsubscribe();
  }, []);

  // Resolve player_id for the authenticated user using URL slug when present.
  useEffect(() => {
    if (!user) {
      setResolvedPlayerId(null);
      setResolvedJukeboxSlug(null);
      setAvailableJukeboxes([]);
      setResolveError(null);
      return;
    }

    let cancelled = false;
    const resolve = async () => {
      try {
        const pathSlug = getPathJukeboxSlug();
        const myJukeboxes = await getMyJukeboxes();
        if (!cancelled) setAvailableJukeboxes(myJukeboxes);

        if (pathSlug) {
          const resolved = await resolveJukeboxSlug(pathSlug);
          if (!resolved) {
            throw new Error(`Jukebox "${pathSlug}" was not found.`);
          }

          const hasAccess = myJukeboxes.some((j) => j.player_id === resolved.player_id);
          if (!hasAccess) {
            throw new Error(`You do not have access to jukebox "${resolved.jukebox_slug}".`);
          }

          if (!cancelled) {
            setResolvedPlayerId(resolved.player_id);
            setResolvedJukeboxSlug(resolved.jukebox_slug);
            setResolveError(null);
          }

          if (pathSlug !== resolved.jukebox_slug) {
            window.history.replaceState({}, '', `/${resolved.jukebox_slug}`);
          }
          return;
        }

        if (myJukeboxes.length > 0) {
          const first = myJukeboxes[0];
          if (!cancelled) {
            setResolvedPlayerId(first.player_id);
            setResolvedJukeboxSlug(first.jukebox_slug);
            setResolveError(null);
          }
          window.history.replaceState({}, '', `/${first.jukebox_slug}`);
          return;
        }

        for (let attempt = 0; attempt < 5; attempt++) {
          const id = await getUserPlayerId();
          if (id) {
            if (!cancelled) {
              setResolvedPlayerId(id);
              setResolvedJukeboxSlug(null);
              setResolveError(null);
            }
            return;
          }
          await new Promise((res) => setTimeout(res, 200 * (attempt + 1)));
        }

        if (!cancelled) {
          setResolvedPlayerId(PLAYER_ID);
          setResolvedJukeboxSlug(null);
          setResolveError('No jukebox mapping found for your account; using legacy default player.');
        }
      } catch (err) {
        console.error('[Auth] Failed to resolve player id:', err);
        if (!cancelled) {
          setResolvedPlayerId(null);
          setResolvedJukeboxSlug(null);
          setResolveError(err instanceof Error ? err.message : 'Failed to resolve jukebox.');
        }
      }
    };

    resolve();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const activePlayerId = resolvedPlayerId;

  const handleSwitchJukebox = (slug: string) => {
    const normalized = normalizeJukeboxSlug(slug);
    if (!normalized) return;
    window.location.assign(`/${normalized}`);
  };

  // Realtime subscriptions — deps intentionally omit isSkipping; use ref to avoid subscription churn
  useEffect(() => {
    if (!user || !activePlayerId) return;
    const q  = subscribeToQueue(activePlayerId, setQueue);
    const s  = subscribeToPlayerStatus(activePlayerId, (ns) => {
      setStatus(ns);
      if (isSkippingRef.current && (ns.state === 'playing' || ns.state === 'loading')) setIsSkipping(false);
    });
    const ps = subscribeToPlayerSettings(activePlayerId, setSettings);
    return () => { q.unsubscribe(); s.unsubscribe(); ps.unsubscribe(); };
  }, [user, activePlayerId]);

  // ── Queue handlers ────────────────────────────────────────────────────────
  const handleRemove = async (queueId: string) => {
    // Optimistic update: remove immediately from local state.
    // Supabase Realtime DELETE events don't carry player_id (only primary key),
    // so the queue subscription filter never fires on DELETE — the UI would
    // otherwise show the stale item until the next unrelated change triggers a refetch.
    setQueue(prev => prev.filter(item => item.id !== queueId));
    try { await callQueueManager({ player_id: activePlayerId ?? PLAYER_ID, action: 'remove', queue_id: queueId }); }
    catch (e) { console.error(e); }
  };

  const handleReorder = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const normalQ = queue.filter(i => i.type === 'normal' && i.media_item_id !== status?.current_media_id && i.id);
    const oldIdx  = normalQ.findIndex(i => i.id === active.id);
    const newIdx  = normalQ.findIndex(i => i.id === over.id);
    const reordered = arrayMove(normalQ, oldIdx, newIdx);
    const priority  = queue.filter(i => i.type === 'priority');
    const current   = queue.filter(i => i.media_item_id === status?.current_media_id);
    setQueue([...current, ...priority, ...reordered]); // optimistic
    try {
      const ids = Array.from(new Set(reordered.map((i) => i.id).filter(Boolean))) as string[];
      await callQueueManager({ player_id: activePlayerId ?? PLAYER_ID, action: 'reorder', queue_ids: ids, type: 'normal' });
    } catch (e) { console.error(e); setQueue(queue); }
  };

  const handleShuffle = async () => {
    setIsShuffling(true);
    try {
      // Guard: don't bother calling the server if there's nothing to shuffle.
      // The server-side queue_shuffle RPC handles everything atomically under
      // pg_advisory_xact_lock, eliminating the 23505 duplicate-key race that
      // necessitated the previous client-side retry loop.
      const normalQ = queue.filter(i => i.type === 'normal' && i.media_item_id !== status?.current_media_id && i.id);
      if (normalQ.length <= 1) return;
      await callQueueManager({ player_id: activePlayerId ?? PLAYER_ID, action: 'shuffle', type: 'normal' });
    } catch (e) { console.error('[Shuffle] Failed:', e); }
    finally { setIsShuffling(false); }
  };

  const handlePlayPause = async () => {
    try {
      const newState = status?.state === 'playing' ? 'paused' : 'playing';
      await callPlayerControl({ player_id: activePlayerId ?? PLAYER_ID, state: newState, action: 'update' });
    } catch (e) { console.error(e); }
  };

  const handleSkip = async () => {
    if (isSkipping) return;
    setIsSkipping(true);
    try { await callPlayerControl({ player_id: activePlayerId ?? PLAYER_ID, state: 'idle', action: 'skip' }); }
    catch (e) { console.error(e); setIsSkipping(false); }
    setTimeout(() => setIsSkipping(false), 3000); // failsafe
  };

  // ── Render ────────────────────────────────────────────────────────────────
  if (authLoading) return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14 }}>
      <Spinner size={36} />
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted)' }}>Loading…</span>
    </div>
  );

  if (!user) return <LoginForm onSignIn={setUser} />;

  if (resolveError) return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, padding: 24 }}>
      <div style={{ maxWidth: 560, textAlign: 'center', color: '#fca5a5', fontFamily: 'var(--font-display)', fontSize: 18 }}>{resolveError}</div>
      <button
        onClick={() => { window.location.assign('/'); }}
        style={{ padding: '10px 16px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.06)', color: '#fff', cursor: 'pointer' }}
      >
        Choose Another Jukebox
      </button>
    </div>
  );

  if (!activePlayerId) return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14 }}>
      <Spinner size={36} />
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted)' }}>Resolving player…</span>
    </div>
  );

  const isQueueView     = view.startsWith('queue');
  const isPlaylistView  = view.startsWith('playlists');
  const isSettingsView  = view.startsWith('settings');
  const isScriptsView   = view === 'settings-scripts';

  return (
    <div style={{ width: '100%', height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg)' }}>
      {/* Stage */}
      <NowPlayingStage
        status={status}
        queue={queue}
        settings={settings}
        onPlayPause={handlePlayPause}
        onSkip={handleSkip}
        isSkipping={isSkipping}
        onRemove={handleRemove}
      />

      {/* Body */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <Sidebar
          view={view}
          setView={setView}
          queue={queue}
          user={user}
          onSignOut={() => signOut().catch(console.error)}
          jukeboxes={availableJukeboxes}
          activeJukeboxSlug={resolvedJukeboxSlug}
          onSwitchJukebox={handleSwitchJukebox}
        />

        <main style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
          {isQueueView && (
            <QueuePanel queue={queue} status={status}
              onRemove={handleRemove} onReorder={handleReorder}
              onShuffle={handleShuffle} isShuffling={isShuffling} />
          )}
          {isPlaylistView && <PlaylistsPanel view={view} playerId={activePlayerId} />}
          {isScriptsView  && <ScriptsPanel playerId={activePlayerId} />}
          {isSettingsView && !isScriptsView && <SettingsPanel view={view} settings={settings} prefs={prefs} playerId={activePlayerId} />}
          {view === 'logs' && <LogsPanel />}
        </main>
      </div>
    </div>
  );
}

export default App;
