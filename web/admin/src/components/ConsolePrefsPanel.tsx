import { useState, useEffect } from 'react';
import type { Prefs } from '../types';
import { FS_SCALES, PRESET_COLOURS, isLightColour } from '../types';
import { PanelHeader } from './ui';

export function ConsolePrefsPanel({ prefs }: { prefs: Prefs }) {
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
