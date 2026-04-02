import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@shared/supabase-client';
import { Spinner, PanelHeader, Btn } from './ui';

interface TableStats {
  table_name: string;
  total_size_bytes: number;
  table_size_bytes: number;
  index_size_bytes: number;
  live_rows: number;
  dead_rows: number;
  seq_scan: number;
  seq_tup_read: number;
  idx_scan: number;
  idx_tup_fetch: number;
  inserts: number;
  updates: number;
  deletes: number;
  cache_hits: number;
  disk_reads: number;
  cache_hit_pct: number;
}

interface ConnectionStats {
  total: number;
  active: number;
  idle: number;
  idle_in_transaction: number;
}

interface DatabaseStats {
  size_bytes: number;
  cache_hit_ratio: number;
  index_cache_hit_ratio: number;
}

interface ReplicationSlot {
  slot_name: string;
  active: boolean;
  wal_lag_bytes: number;
}

interface TopQuery {
  calls: number;
  total_exec_time: number;
  mean_exec_time: number;
  rows: number;
  query_preview: string;
}

interface ServerMetrics {
  tables: TableStats[];
  connections: ConnectionStats;
  database: DatabaseStats;
  replication_slots: ReplicationSlot[];
  top_queries: TopQuery[];
  collected_at: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatMs(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${ms.toFixed(0)}ms`;
}

function cacheColor(pct: number): string {
  if (pct >= 99) return '#22c55e';
  if (pct >= 95) return '#eab308';
  return '#ef4444';
}

const card: React.CSSProperties = {
  background: 'var(--card)', borderRadius: 12,
  border: '1px solid var(--border)', padding: '16px 20px',
};

const statLabel: React.CSSProperties = {
  fontFamily: 'var(--font-mono)', fontSize: 9, color: 'rgba(255,255,255,0.4)',
  textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4,
};

const statValue: React.CSSProperties = {
  fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700, color: '#fff',
};

export function ServerPanel() {
  const [metrics, setMetrics] = useState<ServerMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchMetrics = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: rpcError } = await supabase.rpc('get_server_metrics');
      if (rpcError) throw rpcError;
      setMetrics(data as ServerMetrics);
      setLastRefresh(new Date());
    } catch (err: any) {
      setError(err.message || 'Failed to load metrics');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchMetrics(); }, [fetchMetrics]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const id = setInterval(fetchMetrics, 30_000);
    return () => clearInterval(id);
  }, [fetchMetrics]);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <PanelHeader title="Server" subtitle={
        lastRefresh
          ? `Supabase database metrics \u00b7 refreshed ${lastRefresh.toLocaleTimeString()}`
          : 'Supabase database metrics'
      } actions={
        <Btn onClick={fetchMetrics} disabled={loading} variant="ghost">
          {loading ? 'Loading...' : 'Refresh'}
        </Btn>
      } />

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>
        {loading && !metrics && (
          <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 60 }}>
            <Spinner />
          </div>
        )}

        {error && (
          <div style={{ ...card, borderColor: 'rgba(239,68,68,0.3)', color: '#f87171', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
            {error}
          </div>
        )}

        {metrics && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {/* Overview Cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
              <div style={card}>
                <div style={statLabel}>Database Size</div>
                <div style={statValue}>{formatBytes(metrics.database.size_bytes)}</div>
              </div>
              <div style={card}>
                <div style={statLabel}>Cache Hit Ratio</div>
                <div style={{ ...statValue, color: cacheColor(metrics.database.cache_hit_ratio) }}>
                  {metrics.database.cache_hit_ratio}%
                </div>
              </div>
              <div style={card}>
                <div style={statLabel}>Index Cache Hit</div>
                <div style={{ ...statValue, color: cacheColor(metrics.database.index_cache_hit_ratio) }}>
                  {metrics.database.index_cache_hit_ratio}%
                </div>
              </div>
              <div style={card}>
                <div style={statLabel}>Connections</div>
                <div style={statValue}>{metrics.connections.total}</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'rgba(255,255,255,0.35)', marginTop: 2 }}>
                  {metrics.connections.active} active / {metrics.connections.idle} idle
                </div>
              </div>
            </div>

            {/* Replication / Realtime */}
            {metrics.replication_slots.length > 0 && (
              <div style={card}>
                <div style={{ ...statLabel, marginBottom: 10 }}>Realtime Replication Slots</div>
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  {metrics.replication_slots.map(slot => (
                    <div key={slot.slot_name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: slot.active ? '#22c55e' : '#ef4444' }} />
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>
                        {slot.slot_name.replace('supabase_realtime_', '').replace('_v2_80_2', '')}
                      </span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>
                        lag: {formatBytes(slot.wal_lag_bytes)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Table Stats */}
            <div style={card}>
              <div style={{ ...statLabel, marginBottom: 12 }}>Table Statistics</div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border)' }}>
                      {['Table', 'Size', 'Rows', 'Dead', 'Seq Scans', 'Idx Scans', 'Ins/Upd/Del', 'Cache'].map(h => (
                        <th key={h} style={{ padding: '6px 8px', textAlign: 'left', color: 'rgba(255,255,255,0.35)', fontSize: 9, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.tables.map(t => (
                      <tr key={t.table_name} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                        <td style={{ padding: '6px 8px', color: '#fff', fontWeight: 500 }}>{t.table_name}</td>
                        <td style={{ padding: '6px 8px', color: 'rgba(255,255,255,0.6)' }}>{formatBytes(t.total_size_bytes)}</td>
                        <td style={{ padding: '6px 8px', color: 'rgba(255,255,255,0.6)' }}>{formatNumber(t.live_rows)}</td>
                        <td style={{ padding: '6px 8px', color: t.dead_rows > 100 ? '#eab308' : 'rgba(255,255,255,0.3)' }}>{formatNumber(t.dead_rows)}</td>
                        <td style={{ padding: '6px 8px', color: t.seq_scan > 10000 ? '#ef4444' : 'rgba(255,255,255,0.5)' }}>{formatNumber(t.seq_scan)}</td>
                        <td style={{ padding: '6px 8px', color: 'rgba(255,255,255,0.5)' }}>{formatNumber(t.idx_scan)}</td>
                        <td style={{ padding: '6px 8px', color: 'rgba(255,255,255,0.4)', fontSize: 10 }}>
                          {formatNumber(t.inserts)}/{formatNumber(t.updates)}/{formatNumber(t.deletes)}
                        </td>
                        <td style={{ padding: '6px 8px', color: cacheColor(t.cache_hit_pct), fontWeight: 600 }}>{t.cache_hit_pct}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Top Queries */}
            {metrics.top_queries.length > 0 && (
              <div style={card}>
                <div style={{ ...statLabel, marginBottom: 12 }}>Top Queries by Total Time</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {metrics.top_queries.map((q, i) => (
                    <div key={i} style={{ padding: '8px 10px', background: 'rgba(255,255,255,0.02)', borderRadius: 8, border: '1px solid rgba(255,255,255,0.04)' }}>
                      <div style={{ display: 'flex', gap: 12, marginBottom: 4, flexWrap: 'wrap' }}>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--accent)' }}>
                          {formatMs(q.total_exec_time)} total
                        </span>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>
                          {formatNumber(q.calls)} calls
                        </span>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>
                          {formatMs(q.mean_exec_time)} avg
                        </span>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>
                          {formatNumber(q.rows)} rows
                        </span>
                      </div>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(255,255,255,0.5)', wordBreak: 'break-all', lineHeight: 1.4 }}>
                        {q.query_preview}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
