import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase, type Player, type PlayerStatus } from '@shared/supabase-client';
import { PanelHeader, Btn } from './ui';

interface PlayerWithStatus extends Player {
  player_status?: PlayerStatus | null;
  healthStatus: 'online' | 'waiting' | 'offline';
}

interface RealtimePlayerInstance {
  instance_id: string;
  connection_status: 'ONLINE' | 'OFFLINE';
  is_master: boolean;
  last_seen: string;
  user_agent: string | null;
  connected_at: string;
  last_heartbeat: string | null;
}

interface PlaybackControl {
  id: number;
  current_video_id: string | null;
  current_status: 'IDLE' | 'LOADING' | 'PLAYING' | 'PAUSED' | 'ENDED' | null;
  master_instance_id: string | null;
  master_last_seen: string;
  playback_position: number;
  last_updated: string;
}

interface PlayerLog {
  id: number;
  timestamp: string;
  event_type: string;
  instance_id: string | null;
  message: string;
  details: Record<string, any>;
}

export function PlayerInstances() {
  const [players, setPlayers] = useState<PlayerWithStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInactive, setShowInactive] = useState(true);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [realtimePlayers, setRealtimePlayers] = useState<RealtimePlayerInstance[]>([]);
  const [playbackControl, setPlaybackControl] = useState<PlaybackControl | null>(null);
  const [refreshResponses, setRefreshResponses] = useState<Record<string, any>>({});
  const [recentLogs, setRecentLogs] = useState<PlayerLog[]>([]);

  const playbackRoomChannelRef = useRef<any>(null);

  const fetchPlayers = useCallback(async () => {
    setLoading(true);
    try {
      const { data: playersData, error: playersError } = await supabase
        .from('players')
        .select('*')
        .order('priority', { ascending: true });

      if (playersError) throw playersError;

      const { data: statusData } = await supabase
        .from('player_status')
        .select('*');

      const statusMap = new Map(statusData?.map((s: any) => [s.player_id, s]) || []);

      const now = Date.now();
      const playersWithStatus = (playersData || []).map((player: any) => {
        const lastHeartbeat = player.last_seen || player.last_heartbeat;
        const lastSeenTime = lastHeartbeat ? new Date(lastHeartbeat).getTime() : 0;
        const timeSinceHeartbeat = now - lastSeenTime;

        let healthStatus: 'online' | 'waiting' | 'offline';
        if (timeSinceHeartbeat < 30000) {
          healthStatus = 'online';
        } else if (timeSinceHeartbeat < 60000) {
          healthStatus = 'waiting';
        } else {
          healthStatus = 'offline';
        }

        return {
          ...player,
          player_status: statusMap.get(player.id) || null,
          healthStatus,
        };
      });

      setPlayers(playersWithStatus);
    } catch (error) {
      console.error('[PlayerInstances] Failed to fetch players:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPlayers();
  }, [fetchPlayers]);

  const fetchRealtimeData = useCallback(async () => {
    const [{ data: controlData }, { data: instanceData }, { data: logData }] = await Promise.all([
      supabase.from('playback_control').select('*').eq('id', 1).maybeSingle(),
      supabase.from('player_instances').select('*').order('last_seen', { ascending: false }),
      supabase.from('player_logs').select('*').order('timestamp', { ascending: false }).limit(50),
    ]);
    setPlaybackControl((controlData ?? null) as any);
    setRealtimePlayers(((instanceData ?? []) as any[]).map((row) => row as RealtimePlayerInstance));
    setRecentLogs(((logData ?? []) as any[]).map((row) => row as PlayerLog));
  }, []);

  useEffect(() => {
    fetchRealtimeData().catch(console.error);

    const dbChannel = supabase
      .channel('admin-players-db')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'playback_control', filter: 'id=eq.1' }, () => {
        fetchRealtimeData().catch(console.error);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'player_instances' }, () => {
        fetchRealtimeData().catch(console.error);
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'player_logs' }, (payload: any) => {
        setRecentLogs((prev) => [payload.new as PlayerLog, ...prev].slice(0, 100));
      })
      .subscribe();

    const roomChannel = supabase
      .channel('playback-room-admin', { config: { broadcast: { self: true } } })
      .on('broadcast', { event: 'player_state_response' }, ({ payload }) => {
        const instanceId = String(payload?.instance_id ?? '');
        if (!instanceId) return;
        setRefreshResponses((prev) => ({ ...prev, [instanceId]: payload }));
      })
      .subscribe();
    playbackRoomChannelRef.current = roomChannel;

    return () => {
      supabase.removeChannel(dbChannel);
      supabase.removeChannel(roomChannel);
    };
  }, [fetchRealtimeData]);

  const handleRefreshConnections = async () => {
    const requestId = crypto.randomUUID();
    setRefreshResponses({});
    if (playbackRoomChannelRef.current) {
      await playbackRoomChannelRef.current.send({
        type: 'broadcast',
        event: 'refresh_connections',
        payload: { requestId, requested_at: new Date().toISOString() },
      });
    }
    setTimeout(() => fetchRealtimeData().catch(console.error), 1000);
  };

  const forceMaster = async (instanceId: string) => {
    try {
      await supabase.rpc('force_master_instance', {
        p_instance_id: instanceId,
        p_message: 'admin_manual_override',
      } as any);
      await fetchRealtimeData();
    } catch (error) {
      console.error('[PlayerInstances] Failed to force master:', error);
    }
  };

  const handleIdentify = async (player: PlayerWithStatus) => {
    const displayName = player.player_name_tag || `Player_${player.priority}`;
    try {
      await supabase.rpc('identify_player', {
        p_player_id: player.id,
        p_display_name: displayName,
      } as any);
    } catch (error) {
      console.error('[PlayerInstances] Failed to identify player:', error);
    }
  };

  const handleDelete = async (playerId: string) => {
    if (!confirm('Are you sure you want to delete this player instance?')) return;

    setDeleting(playerId);
    try {
      await supabase.rpc('delete_player_instance', {
        p_player_id: playerId,
      } as any);
      await fetchPlayers();
    } catch (error) {
      console.error('[PlayerInstances] Failed to delete player:', error);
    } finally {
      setDeleting(null);
    }
  };

  const handleDeleteInactive = async () => {
    if (!confirm('Are you sure you want to delete all inactive players (offline > 60s)?')) return;

    try {
      await supabase.rpc('delete_inactive_players', {
        p_offline_threshold_seconds: 60,
      } as any);
      await fetchPlayers();
    } catch (error) {
      console.error('[PlayerInstances] Failed to delete inactive players:', error);
    }
  };

  const handleSaveName = async (playerId: string) => {
    try {
      await (supabase as any)
        .from('players')
        .update({ player_name_tag: editValue || null })
        .eq('id', playerId);
      await fetchPlayers();
      setEditingName(null);
      setEditValue('');
    } catch (error) {
      console.error('[PlayerInstances] Failed to update player name:', error);
    }
  };

  const handleReorder = async (dragIndex: number, dropIndex: number) => {
    const newPlayers = [...players];
    const [draggedPlayer] = newPlayers.splice(dragIndex, 1);
    newPlayers.splice(dropIndex, 0, draggedPlayer);

    const playerIds = newPlayers.map(p => p.id);
    const newPriorities = newPlayers.map((_, i) => i + 1);

    try {
      await supabase.rpc('reorder_players', {
        p_player_ids: playerIds,
        p_priorities: newPriorities,
      } as any);
      await fetchPlayers();
    } catch (error) {
      console.error('[PlayerInstances] Failed to reorder players:', error);
    }
  };

  const filteredPlayers = showInactive
    ? players
    : players.filter(p => p.healthStatus === 'online' || p.healthStatus === 'waiting');

  const formatDate = (dateString: string | null) => {
    if (!dateString) return 'N/A';
    const date = new Date(dateString);
    const day = date.getDate();
    const month = date.toLocaleString('en-US', { month: 'short' });
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const seconds = date.getSeconds().toString().padStart(2, '0');
    return `${day} ${month} - ${hours}:${minutes}:${seconds}`;
  };

  const getHealthDisplay = (health: 'online' | 'waiting' | 'offline') => {
    switch (health) {
      case 'online':
        return <span>❤️ ONLINE</span>;
      case 'waiting':
        return <span>♡ Waiting...</span>;
      case 'offline':
        return <span>💀 OFFLINE</span>;
    }
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <PanelHeader title="PLAYER INSTANCES" subtitle="Manage connected player instances" />

      <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--border)', display: 'grid', gap: 8 }}>
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.75)' }}>
          <strong>Master:</strong> {playbackControl?.master_instance_id ?? 'none'} · <strong>Status:</strong> {playbackControl?.current_status ?? 'IDLE'}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Btn variant="accent" onClick={handleRefreshConnections}>REFRESH ALL CONNECTIONS</Btn>
          <Btn variant="ghost" onClick={() => fetchRealtimeData().catch(console.error)}>RELOAD MASTER DATA</Btn>
        </div>
      </div>

      {/* Action buttons */}
      <div style={{ padding: '16px 24px', display: 'flex', gap: 8, borderBottom: '1px solid var(--border)' }}>
        <Btn
          variant="ghost"
          onClick={() => setShowInactive(!showInactive)}
        >
          {showInactive ? 'HIDE INACTIVE' : 'SHOW INACTIVE'}
        </Btn>
        <Btn
          variant="danger"
          onClick={handleDeleteInactive}
        >
          DELETE INACTIVE
        </Btn>
        <Btn
          variant="accent"
          onClick={fetchPlayers}
          disabled={loading}
        >
          REFRESH
        </Btn>
      </div>

      {/* Table */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
        <div style={{ marginBottom: 24 }}>
          <h3 style={{ margin: '0 0 8px', fontSize: 13, color: 'rgba(255,255,255,0.85)' }}>Realtime Instances</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left' }}>
                <th style={{ padding: '8px' }}>Instance ID</th>
                <th style={{ padding: '8px' }}>Master</th>
                <th style={{ padding: '8px' }}>Connection</th>
                <th style={{ padding: '8px' }}>Last Seen</th>
                <th style={{ padding: '8px' }}>State Response</th>
                <th style={{ padding: '8px' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {realtimePlayers.map((row) => (
                <tr key={row.instance_id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  <td style={{ padding: '8px' }}>{row.instance_id}</td>
                  <td style={{ padding: '8px' }}>{row.is_master ? '✅' : '—'}</td>
                  <td style={{ padding: '8px' }}>{row.connection_status}</td>
                  <td style={{ padding: '8px' }}>{formatDate(row.last_seen)}</td>
                  <td style={{ padding: '8px' }}>{refreshResponses[row.instance_id]?.status ?? '-'}</td>
                  <td style={{ padding: '8px' }}>
                    <Btn variant="ghost" onClick={() => forceMaster(row.instance_id)}>FORCE MASTER</Btn>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.5)', padding: 40 }}>Loading...</div>
        ) : filteredPlayers.length === 0 ? (
          <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.5)', padding: 40 }}>
            {showInactive ? 'No player instances found' : 'No active players found'}
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left' }}>
                <th style={{ padding: '12px 8px', color: 'rgba(255,255,255,0.5)', fontWeight: 500, width: 60 }}>Priority</th>
                <th style={{ padding: '12px 8px', color: 'rgba(255,255,255,0.5)', fontWeight: 500 }}>Player Name Tag</th>
                <th style={{ padding: '12px 8px', color: 'rgba(255,255,255,0.5)', fontWeight: 500 }}>Player ID</th>
                <th style={{ padding: '12px 8px', color: 'rgba(255,255,255,0.5)', fontWeight: 500 }}>Health Status</th>
                <th style={{ padding: '12px 8px', color: 'rgba(255,255,255,0.5)', fontWeight: 500 }}>Player State</th>
                <th style={{ padding: '12px 8px', color: 'rgba(255,255,255,0.5)', fontWeight: 500 }}>Created At</th>
                <th style={{ padding: '12px 8px', color: 'rgba(255,255,255,0.5)', fontWeight: 500 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredPlayers.map((player, index) => (
                <tr
                  key={player.id}
                  style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}
                >
                  <td style={{ padding: '12px 8px', color: '#e5e7eb' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span
                        style={{ cursor: 'grab', color: 'rgba(255,255,255,0.3)', fontSize: 16 }}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData('dragIndex', index.toString());
                        }}
                        onDragOver={(e) => {
                          e.preventDefault();
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          const dragIndex = parseInt(e.dataTransfer.getData('dragIndex'));
                          handleReorder(dragIndex, index);
                        }}
                      >
                        ⋮⋮
                      </span>
                      <span>{player.priority}</span>
                    </div>
                  </td>
                  <td style={{ padding: '12px 8px', color: '#e5e7eb' }}>
                    {editingName === player.id ? (
                      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        <input
                          type="text"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleSaveName(player.id);
                            if (e.key === 'Escape') {
                              setEditingName(null);
                              setEditValue('');
                            }
                          }}
                          autoFocus
                          style={{
                            padding: '4px 8px',
                            borderRadius: 4,
                            background: '#111',
                            border: '1px solid rgba(255,255,255,0.2)',
                            color: '#fff',
                            fontSize: 11,
                            fontFamily: 'var(--font-mono)',
                          }}
                        />
                        <button
                          onClick={() => handleSaveName(player.id)}
                          style={{ padding: '4px 8px', background: 'var(--accent)', border: 'none', borderRadius: 4, color: '#000', fontSize: 10, cursor: 'pointer' }}
                        >
                          ✓
                        </button>
                      </div>
                    ) : (
                      <div
                        style={{ display: 'flex', alignItems: 'center', gap: 4 }}
                        onMouseEnter={() => {
                          if (!editingName) {
                            setEditValue(player.player_name_tag || '');
                          }
                        }}
                      >
                        <span>{player.player_name_tag || `Player_${player.priority}`}</span>
                        <button
                          onClick={() => {
                            setEditingName(player.id);
                            setEditValue(player.player_name_tag || '');
                          }}
                          style={{
                            opacity: 0,
                            padding: '2px 6px',
                            background: 'rgba(255,255,255,0.1)',
                            border: 'none',
                            borderRadius: 3,
                            color: 'rgba(255,255,255,0.6)',
                            fontSize: 9,
                            cursor: 'pointer',
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
                          onMouseLeave={(e) => (e.currentTarget.style.opacity = '0')}
                        >
                          Edit
                        </button>
                      </div>
                    )}
                  </td>
                  <td style={{ padding: '12px 8px', color: 'rgba(255,255,255,0.5)', fontFamily: 'var(--font-mono)', fontSize: 10 }}>
                    {player.id.slice(0, 8)}...
                  </td>
                  <td style={{ padding: '12px 8px', color: '#e5e7eb' }}>
                    {getHealthDisplay(player.healthStatus)}
                  </td>
                  <td style={{ padding: '12px 8px', color: '#e5e7eb' }}>
                    {player.player_status?.state || 'Unknown'}
                  </td>
                  <td style={{ padding: '12px 8px', color: 'rgba(255,255,255,0.5)', fontFamily: 'var(--font-mono)', fontSize: 10 }}>
                    {formatDate(player.created_at)}
                  </td>
                  <td style={{ padding: '12px 8px' }}>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button
                        onClick={() => handleIdentify(player)}
                        style={{
                          padding: '4px 8px',
                          background: 'rgba(59,130,246,0.15)',
                          border: '1px solid rgba(59,130,246,0.3)',
                          borderRadius: 4,
                          color: '#60a5fa',
                          fontSize: 10,
                          cursor: 'pointer',
                        }}
                      >
                        Identify
                      </button>
                      <button
                        onClick={() => handleDelete(player.id)}
                        disabled={deleting === player.id}
                        style={{
                          padding: '4px 8px',
                          background: 'rgba(239,68,68,0.15)',
                          border: '1px solid rgba(239,68,68,0.3)',
                          borderRadius: 4,
                          color: '#f87171',
                          fontSize: 10,
                          cursor: 'pointer',
                          opacity: deleting === player.id ? 0.5 : 1,
                        }}
                      >
                        {deleting === player.id ? '...' : 'Delete'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div style={{ marginTop: 24 }}>
          <h3 style={{ margin: '0 0 8px', fontSize: 13, color: 'rgba(255,255,255,0.85)' }}>Master Election Logs</h3>
          <div style={{ maxHeight: 240, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
            {recentLogs.map((log) => (
              <div key={log.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', padding: '8px 10px', fontSize: 12 }}>
                <div><strong>{new Date(log.timestamp).toLocaleTimeString()}</strong> · {log.event_type} · {log.instance_id ?? 'n/a'}</div>
                <div style={{ opacity: 0.85 }}>{log.message}</div>
              </div>
            ))}
            {!recentLogs.length && <div style={{ padding: 10, opacity: 0.7 }}>No player logs yet.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
