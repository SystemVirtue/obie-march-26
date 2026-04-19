/**
 * PriorityClaimModal — shown on slave players when the admin has triggered
 * "Reset Priority Player" and the system is waiting for a new master to be
 * explicitly confirmed by venue staff.
 *
 * The modal is a full-screen translucent overlay. It does NOT stop the video
 * from playing. It auto-dismisses after 60 s if the user takes no action
 * (stays as slave).
 */

import { useEffect, useRef, useState } from 'react';

const AUTO_DISMISS_S = 60;

type Props = {
  onClaim:   () => Promise<void>;
  onDecline: () => void;
};

export function PriorityClaimModal({ onClaim, onDecline }: Props) {
  const [claiming, setClaiming] = useState(false);
  const [countdown, setCountdown] = useState(AUTO_DISMISS_S);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Countdown timer — auto-dismiss when it hits 0
  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          clearInterval(intervalRef.current!);
          onDecline();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [onDecline]);

  const handleClaim = async () => {
    if (claiming) return;
    if (intervalRef.current) clearInterval(intervalRef.current);
    setClaiming(true);
    try {
      await onClaim();
    } catch (e) {
      console.error('[PriorityClaimModal] Claim failed:', e);
      setClaiming(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.75)',
        backdropFilter: 'blur(6px)',
        pointerEvents: 'auto',
      }}
    >
      <div
        style={{
          background: '#0e0e1a',
          border: '1px solid rgba(167,139,250,0.4)',
          borderRadius: 20,
          padding: '36px 40px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 20,
          minWidth: 340,
          maxWidth: 440,
          boxShadow: '0 32px 96px rgba(0,0,0,0.95), 0 0 0 1px rgba(167,139,250,0.15)',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Icon */}
        <div style={{ fontSize: 40, lineHeight: 1 }}>👑</div>

        {/* Heading */}
        <div
          style={{
            fontFamily: 'var(--font-display, system-ui)',
            fontSize: 20,
            fontWeight: 800,
            color: '#fff',
            letterSpacing: '-0.02em',
            textAlign: 'center',
            lineHeight: 1.25,
          }}
        >
          Set as MASTER / PRIORITY Player?
        </div>

        {/* Body */}
        <div
          style={{
            fontFamily: 'var(--font-mono, monospace)',
            fontSize: 12,
            color: 'rgba(255,255,255,0.55)',
            textAlign: 'center',
            lineHeight: 1.6,
            maxWidth: 320,
          }}
        >
          The admin has reset priority assignment. Only the MASTER player drives
          queue progression. Assign this screen as master, or stay as slave.
        </div>

        {/* Buttons */}
        <div style={{ display: 'flex', gap: 12, width: '100%' }}>
          <button
            onClick={handleClaim}
            disabled={claiming}
            style={{
              flex: 1,
              padding: '13px 0',
              borderRadius: 12,
              border: 'none',
              background: claiming ? 'rgba(167,139,250,0.4)' : '#7c3aed',
              color: '#fff',
              fontFamily: 'var(--font-display, system-ui)',
              fontSize: 14,
              fontWeight: 700,
              cursor: claiming ? 'default' : 'pointer',
              boxShadow: claiming ? 'none' : '0 4px 20px rgba(124,58,237,0.5)',
              transition: 'background 0.15s, box-shadow 0.15s',
            }}
          >
            {claiming ? '⏳ Setting...' : 'Yes — Set as MASTER'}
          </button>

          <button
            onClick={onDecline}
            disabled={claiming}
            style={{
              flex: 1,
              padding: '13px 0',
              borderRadius: 12,
              border: '1px solid rgba(255,255,255,0.15)',
              background: 'transparent',
              color: 'rgba(255,255,255,0.6)',
              fontFamily: 'var(--font-display, system-ui)',
              fontSize: 14,
              fontWeight: 500,
              cursor: claiming ? 'default' : 'pointer',
            }}
          >
            No — Stay as Slave
          </button>
        </div>

        {/* Countdown */}
        <div
          style={{
            fontFamily: 'var(--font-mono, monospace)',
            fontSize: 10,
            color: 'rgba(255,255,255,0.25)',
            letterSpacing: '0.06em',
          }}
        >
          Auto-dismisses in {countdown}s
        </div>
      </div>
    </div>
  );
}
