import { useState, useEffect } from 'react';
import {
  supabase,
  getTotalCredits,
  updateAllCredits,
  callPlayerControl,
  subscribeToTable,
  type PlayerSettings,
} from '@shared/supabase-client';
import type { ViewId, Prefs } from '../types';
import { Spinner, Toggle, PanelHeader, Btn, SaveBtn, SettingsRow } from './ui';
import { ConsolePrefsPanel } from './ConsolePrefsPanel';

export function SettingsPanel({ view, settings, prefs, playerId }: { view: ViewId; settings: PlayerSettings | null; prefs: Prefs; playerId: string }) {
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
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
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
