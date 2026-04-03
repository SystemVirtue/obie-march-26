import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@shared/supabase-client';
import type { SystemLog } from '../types';
import { Spinner, PanelHeader } from './ui';

type LogTab = 'system' | 'kiosk-credits';

interface CreditMetrics {
  today: number;
  last7: number;
  last30: number;
  allTime: number;
}

function KioskCreditsTab() {
  const [coinMetrics, setCoinMetrics] = useState<CreditMetrics | null>(null);
  const [adminMetrics, setAdminMetrics] = useState<CreditMetrics | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchMetrics = useCallback(async () => {
    setLoading(true);
    try {
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const last7Start = new Date(now.getTime() - 7 * 86400000).toISOString();
      const last30Start = new Date(now.getTime() - 30 * 86400000).toISOString();

      // Fetch all credit_deposit and credit_clear logs
      const { data: deposits } = await supabase
        .from('system_logs')
        .select('event, payload, timestamp')
        .in('event', ['credit_deposit', 'credit_clear'])
        .order('timestamp', { ascending: false })
        .limit(5000);

      const logs = (deposits as unknown as { event: string; payload: any; timestamp: string }[]) || [];

      // Calculate coin acceptor metrics (physical coins only)
      const coinLogs = logs.filter(l => l.event === 'credit_deposit' && l.payload?.source === 'coin_acceptor');
      const sumAmount = (items: typeof coinLogs) => items.reduce((sum, l) => sum + (Number(l.payload?.amount) || 0), 0);

      setCoinMetrics({
        today: sumAmount(coinLogs.filter(l => l.timestamp >= todayStart)),
        last7: sumAmount(coinLogs.filter(l => l.timestamp >= last7Start)),
        last30: sumAmount(coinLogs.filter(l => l.timestamp >= last30Start)),
        allTime: sumAmount(coinLogs),
      });

      // Calculate admin virtual credits (deposits MINUS clears)
      const adminDeposits = logs.filter(l => l.event === 'credit_deposit' && l.payload?.source === 'admin');
      const adminClears = logs.filter(l => l.event === 'credit_clear' && l.payload?.source === 'admin');

      const netAdmin = (items: typeof adminDeposits, clears: typeof adminClears) => {
        const added = items.reduce((sum, l) => sum + (Number(l.payload?.amount) || 0), 0);
        const cleared = clears.reduce((sum, l) => sum + (Number(l.payload?.previous_balance) || 0), 0);
        return added - cleared;
      };

      setAdminMetrics({
        today: netAdmin(
          adminDeposits.filter(l => l.timestamp >= todayStart),
          adminClears.filter(l => l.timestamp >= todayStart)
        ),
        last7: netAdmin(
          adminDeposits.filter(l => l.timestamp >= last7Start),
          adminClears.filter(l => l.timestamp >= last7Start)
        ),
        last30: netAdmin(
          adminDeposits.filter(l => l.timestamp >= last30Start),
          adminClears.filter(l => l.timestamp >= last30Start)
        ),
        allTime: netAdmin(adminDeposits, adminClears),
      });
    } catch (err) {
      console.error('Failed to fetch credit metrics:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchMetrics(); }, [fetchMetrics]);

  const periods = ['Today', 'Last 7 Days', 'Last 30 Days', 'All Time'] as const;
  const getValues = (m: CreditMetrics | null) => m ? [m.today, m.last7, m.last30, m.allTime] : [0, 0, 0, 0];

  const card: React.CSSProperties = {
    borderRadius: 14, padding: '18px 20px',
    background: 'rgba(255,255,255,0.025)', border: '1px solid var(--border)',
  };
  const metricLabel: React.CSSProperties = {
    fontFamily: 'var(--font-mono)', fontSize: 9, color: 'rgba(255,255,255,0.4)',
    textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4,
  };
  const metricValue: React.CSSProperties = {
    fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700, color: '#fff',
  };

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 60 }}><Spinner /></div>;

  return (
    <div style={{ padding: '16px 24px', display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Physical Coin Deposits */}
      <div style={card}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 600, color: '#fff', marginBottom: 16 }}>
          Physical Coin Deposits (via Coin Acceptor)
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          {periods.map((label, i) => (
            <div key={label}>
              <div style={metricLabel}>{label}</div>
              <div style={{ ...metricValue, color: '#22c55e' }}>{getValues(coinMetrics)[i]}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(255,255,255,0.3)', marginTop: 2 }}>credits</div>
            </div>
          ))}
        </div>
      </div>

      {/* Admin Virtual Credits */}
      <div style={card}>
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 600, color: '#fff', marginBottom: 4 }}>
          Admin Console Virtual Credits
        </div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(255,255,255,0.35)', marginBottom: 16 }}>
          Net credits (+1/+3 deposits minus cleared balances)
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          {periods.map((label, i) => {
            const val = getValues(adminMetrics)[i];
            return (
              <div key={label}>
                <div style={metricLabel}>{label}</div>
                <div style={{ ...metricValue, color: val >= 0 ? '#60a5fa' : '#f87171' }}>{val}</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(255,255,255,0.3)', marginTop: 2 }}>credits</div>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ textAlign: 'center' }}>
        <button onClick={fetchMetrics} style={{ padding: '7px 16px', borderRadius: 9, border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.5)', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
          Refresh Metrics
        </button>
      </div>
    </div>
  );
}

export function LogsPanel() {
  const [tab, setTab] = useState<LogTab>('system');
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

  const tabStyle = (active: boolean): React.CSSProperties => ({
    padding: '6px 14px', borderRadius: 8, cursor: 'pointer',
    fontFamily: 'var(--font-display)', fontSize: 12, fontWeight: 500, border: 'none',
    background: active ? 'var(--accent-dim)' : 'rgba(255,255,255,0.04)',
    color: active ? 'var(--accent)' : 'rgba(255,255,255,0.38)',
  });

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <PanelHeader
        title={tab === 'system' ? 'System Logs' : 'Kiosk Credits'}
        subtitle={tab === 'system' ? 'Real-time event stream · last 200 entries' : 'Credit deposit tracking and metrics'}
        actions={<>
          {/* Tab switcher */}
          <div style={{ display: 'flex', gap: 4, marginRight: 8 }}>
            <button onClick={() => setTab('system')} style={tabStyle(tab === 'system')}>System Logs</button>
            <button onClick={() => setTab('kiosk-credits')} style={tabStyle(tab === 'kiosk-credits')}>Kiosk Credits</button>
          </div>
          {tab === 'system' && <>
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
        </>}
      />

      {tab === 'kiosk-credits' ? (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <KioskCreditsTab />
        </div>
      ) : (
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
      )}
    </div>
  );
}
