import { useState } from 'react';
import { cleanDisplayText } from '../../../shared/media-utils';
import type { PlayerStatus, QueueItem, PlayerSettings } from '../types';
import { fmtDuration } from '../types';
import { Spinner } from './ui';

export function NowPlayingStage({ status, queue, settings, onPlayPause, onSkip, isSkipping, onRemove }: {
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
