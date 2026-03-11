import { useState, useEffect } from 'react';
import { supabase } from '@shared/supabase-client';
import type { SystemLog } from '../types';
import { Spinner, PanelHeader } from './ui';

export function LogsPanel() {
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
