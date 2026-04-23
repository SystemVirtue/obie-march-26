import { useState, useEffect, useCallback } from 'react';
import { supabase, type Player, type PlayerStatus } from '@shared/supabase-client';
import { PanelHeader, Btn } from './ui';

interface PlayerWithStatus extends Player {
  player_status?: PlayerStatus | null;
  healthStatus: 'online' | 'waiting' | 'offline';
}

export function PlayerInstances() {
  const [players, setPlayers] = useState<PlayerWithStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInactive, setShowInactive] = useState(true);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);

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
      </div>
    </div>
  );
}
