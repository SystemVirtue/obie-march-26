import { useState } from 'react';

export function Spinner({ size = 20 }: { size?: number }) {
  return (
    <div className="animate-spin rounded-full border-2 border-t-transparent inline-block"
      style={{ width: size, height: size, borderColor: 'var(--accent)', borderTopColor: 'transparent' }} />
  );
}

export function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
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

export function PanelHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
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

export function Btn({ onClick, children, variant = 'ghost', disabled, style: xs }: {
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

export function SaveBtn({ onSave, loading }: { onSave: () => Promise<void>; loading?: boolean }) {
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

export function SettingsRow({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) {
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
