import { useState, useRef, useCallback } from 'react';
import {
  supabase,
  callPlaylistManager,
  callYouTubeScraper,
} from '@shared/supabase-client';
import { PREDEFINED_PLAYLISTS } from '../types';
import { Spinner, PanelHeader, Btn } from './ui';

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

export function ScriptsPanel({ playerId }: { playerId: string }) {
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
