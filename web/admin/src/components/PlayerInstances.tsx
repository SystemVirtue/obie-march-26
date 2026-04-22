import { useState, useEffect, useCallback } from 'react';
import { supabase, subscribeToTable, type Player, type PlayerStatus } from '@shared/supabase-client';
import { PanelHeader, Btn, Spinner } from './ui';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface PlayerInstancesProps {
  jukeboxes: { player_id: string; jukebox_slug: string }[];
}

type HealthStatus = 'online' | 'waiting' | 'offline';

function getHealthStatus(lastSeen: string | null): HealthStatus {
  if (!lastSeen) return 'offline';
  const now = new Date().getTime();
  const lastSeenTime = new Date(lastSeen).getTime();
  const diff = (now - lastSeenTime) / 1000; // seconds

  if (diff <= 30) return 'online';
  if (diff <= 60) return 'waiting';
  return 'offline';
}

function formatHealthStatus(status: HealthStatus): string {
  switch (status) {
    case 'online': return '❤️ Online';
    case 'waiting': return '🤍 Waiting...';
    case 'offline': return '💀 Offline';
  }
}

function formatTimestamp(dateStr: string | null): string {
  if (!dateStr) return 'N/A';
  const date = new Date(dateStr);
  const day = date.getDate();
  const month = date.toLocaleString('en-US', { month: 'short' });
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${day} ${month}   ${hours}:${minutes}:${seconds}`;
}

// Sortable row component
function SortableRow({ player, status, onIdentify, onDelete, onEditName }: {
  player: Player;
  status: PlayerStatus | null;
  onIdentify: (player: Player) => void;
  onDelete: (player: Player) => void;
  onEditName: (player: Player) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: player.id });
  const healthStatus = getHealthStatus(player.last_seen || player.last_heartbeat);
  const [hovered, setHovered] = useState(false);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const displayName = player.player_name_tag || `Player_${player.priority || '?'}`;

  return (
    <div
      ref={setNodeRef}
      style={style}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="sortable-row"
    >
      <div style={{
        display: 'grid', gridTemplateColumns: '50px 1fr 1fr 1fr 1fr 1fr 120px', gap: 8, padding: '10px 12px',
        background: hovered ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.03)',
        borderBottom: '1px solid rgba(255,255,255,0.05)', alignItems: 'center'
      }}>

        {/* Priority / Drag Handle */}
        <div {...attributes} {...listeners} style={{ cursor: 'grab', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontSize: 16, opacity: 0.6 }}>⋮⋮</span>
        </div>

        {/* Player Name Tag */}
        <div style={{ position: 'relative' }}>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 13, color: '#fff' }}>{displayName}</span>
          {hovered && (
            <button
              onClick={() => onEditName(player)}
              style={{
                position: 'absolute', left: '100%', top: '50%', transform: 'translateY(-50%) translateX(8px)',
                padding: '2px 8px', fontSize: 10, background: 'rgba(59,130,246,0.2)', border: '1px solid rgba(59,130,246,0.3)',
                color: '#60a5fa', borderRadius: 4, cursor: 'pointer', whiteSpace: 'nowrap'
              }}
            >
              Edit Name
            </button>
          )}
        </div>

        {/* Player ID */}
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>
          {player.id.slice(0, 8)}...
        </div>

        {/* Health Status */}
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: healthStatus === 'online' ? '#4ade80' : healthStatus === 'waiting' ? '#fbbf24' : '#6b7280' }}>
          {formatHealthStatus(healthStatus)}
        </div>

        {/* Player State */}
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>
          {status?.state || 'Unknown'}
        </div>

        {/* Last Refresh Time */}
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>
          {formatTimestamp(player.last_refresh)}
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            onClick={() => onIdentify(player)}
            style={{
              padding: '4px 10px', fontSize: 11, background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.3)',
              color: '#4ade80', borderRadius: 6, cursor: 'pointer', fontFamily: 'var(--font-display)'
            }}
          >
            Identify
          </button>
          <button
            onClick={() => onDelete(player)}
            style={{
              padding: '4px 10px', fontSize: 11, background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)',
              color: '#f87171', borderRadius: 6, cursor: 'pointer', fontFamily: 'var(--font-display)'
            }}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

export function PlayerInstances({ jukeboxes }: PlayerInstancesProps) {
  const [players, setPlayers] = useState<Player[]>([]);
  const [statuses, setStatuses] = useState<Record<string, PlayerStatus>>({});
  const [showInactive, setShowInactive] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editingPlayer, setEditingPlayer] = useState<Player | null>(null);
  const [editingName, setEditingName] = useState('');

  const playerIds = jukeboxes.map(j => j.player_id);
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // Fetch players
  const fetchPlayers = useCallback(async () => {
    if (!playerIds.length) {
      setPlayers([]);
      setLoading(false);
      return;
    }

    try {
      const { data, error } = await supabase
        .from('players')
        .select('*')
        .in('id', playerIds)
        .order('priority', { ascending: true });

      if (error) throw error;
      setPlayers(data || []);
    } catch (error) {
      console.error('[PlayerInstances] Failed to fetch players:', error);
    } finally {
      setLoading(false);
    }
  }, [playerIds]);

  // Fetch player statuses
  const fetchStatuses = useCallback(async () => {
    if (!playerIds.length) return;

    try {
      const { data, error } = await supabase
        .from('player_status')
        .select('*')
        .in('player_id', playerIds);

      if (error) throw error;

      const statusMap: Record<string, PlayerStatus> = {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (data || []).forEach((s: any) => {
        statusMap[s.player_id] = s as PlayerStatus;
      });
      setStatuses(statusMap);
    } catch (error) {
      console.error('[PlayerInstances] Failed to fetch statuses:', error);
    }
  }, [playerIds]);

  // Subscribe to players table
  useEffect(() => {
    fetchPlayers();
    fetchStatuses();

    const sub = subscribeToTable('players', { column: 'id', value: playerIds[0] }, () => {
      fetchPlayers();
    });

    return () => sub.unsubscribe();
  }, [playerIds, fetchPlayers, fetchStatuses]);

  // Subscribe to player_status table
  useEffect(() => {
    const subs = playerIds.map(pid =>
      subscribeToTable('player_status', { column: 'player_id', value: pid }, fetchStatuses)
    );
    return () => subs.forEach(s => s.unsubscribe());
  }, [playerIds, fetchStatuses]);

  // Auto-refresh interval (15 seconds when enabled)
  useEffect(() => {
    if (!autoRefresh) return;

    const interval = setInterval(() => {
      fetchPlayers();
      fetchStatuses();
    }, 15000); // 15 seconds

    return () => clearInterval(interval);
  }, [autoRefresh, fetchPlayers, fetchStatuses]);

  // Handle drag end for reordering
  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = players.findIndex(p => p.id === active.id);
    const newIndex = players.findIndex(p => p.id === over.id);

    const reordered = arrayMove(players, oldIndex, newIndex);
    setPlayers(reordered);

    // Update priorities in database
    try {
      for (let i = 0; i < reordered.length; i++) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (supabase as any)
          .from('players')
          .update({ priority: i + 1 })
          .eq('id', reordered[i].id);
      }
    } catch (error) {
      console.error('[PlayerInstances] Failed to update priorities:', error);
      fetchPlayers(); // Revert on error
    }
  };

  // Handle identify
  const handleIdentify = async (player: Player) => {
    const displayName = player.player_name_tag || `Player_${player.priority || '?'}`;
    try {
      // Set identify_tag to trigger overlay on player screen
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabase as any)
        .from('players')
        .update({ identify_tag: displayName })
        .eq('id', player.id);

      console.log('[PlayerInstances] Identify player:', displayName);

      // Clear identify_tag after 5 seconds
      setTimeout(async () => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (supabase as any)
            .from('players')
            .update({ identify_tag: null })
            .eq('id', player.id);
        } catch (error) {
          console.error('[PlayerInstances] Failed to clear identify_tag:', error);
        }
      }, 5000);
    } catch (error) {
      console.error('[PlayerInstances] Failed to set identify_tag:', error);
    }
  };

  // Handle delete
  const handleDelete = async (player: Player) => {
    if (!confirm(`Are you sure you want to delete player "${player.player_name_tag || player.name}"?`)) return;

    try {
      await supabase.from('players').delete().eq('id', player.id);
      setPlayers(prev => prev.filter(p => p.id !== player.id));
    } catch (error) {
      console.error('[PlayerInstances] Failed to delete player:', error);
    }
  };

  // Handle edit name
  const handleEditName = (player: Player) => {
    setEditingPlayer(player);
    setEditingName(player.player_name_tag || `Player_${player.priority || '?'}`);
  };

  // Save name
  const handleSaveName = async () => {
    if (!editingPlayer) return;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabase as any)
        .from('players')
        .update({ player_name_tag: editingName })
        .eq('id', editingPlayer.id);

      setPlayers(prev => prev.map(p =>
        p.id === editingPlayer.id ? { ...p, player_name_tag: editingName as string } : p
      ));
      setEditingPlayer(null);
      setEditingName('');
    } catch (error) {
      console.error('[PlayerInstances] Failed to update name:', error);
    }
  };

  // Delete inactive
  const handleDeleteInactive = async () => {
    const inactivePlayers = players.filter(p => getHealthStatus(p.last_seen || p.last_heartbeat) === 'offline');
    if (!inactivePlayers.length) {
      alert('No inactive players to delete.');
      return;
    }

    if (!confirm(`Are you sure you want to delete ${inactivePlayers.length} inactive player(s)?`)) return;

    try {
      for (const player of inactivePlayers) {
        await supabase.from('players').delete().eq('id', player.id);
      }
      setPlayers(prev => prev.filter(p => getHealthStatus(p.last_seen || p.last_heartbeat) !== 'offline'));
    } catch (error) {
      console.error('[PlayerInstances] Failed to delete inactive players:', error);
    }
  };

  // Filter players based on showInactive
  const filteredPlayers = showInactive
    ? players
    : players.filter(p => getHealthStatus(p.last_seen || p.last_heartbeat) !== 'offline');

  if (loading) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spinner />
      </div>
    );
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <PanelHeader title="Player Instances" subtitle="Manage connected player devices" />

      {/* Action Buttons */}
      <div style={{ padding: '16px 24px', display: 'flex', gap: 12, borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
        <Btn
          variant={showInactive ? 'accent' : 'ghost'}
          onClick={() => setShowInactive(!showInactive)}
        >
          {showInactive ? 'Hide Inactive' : 'Show Inactive'}
        </Btn>
        <Btn variant="danger" onClick={handleDeleteInactive}>
          Delete Inactive
        </Btn>
        <Btn
          variant={autoRefresh ? 'accent' : 'ghost'}
          onClick={() => setAutoRefresh(!autoRefresh)}
        >
          Auto-Refresh: {autoRefresh ? 'ON' : 'OFF'}
        </Btn>
      </div>

      {/* Table */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 24px 24px 24px' }}>
        {/* Headers */}
        <div style={{
          display: 'grid', gridTemplateColumns: '50px 1fr 1fr 1fr 1fr 1fr 120px', gap: 8,
          padding: '12px 12px', borderBottom: '1px solid rgba(255,255,255,0.1)',
          background: 'rgba(255,255,255,0.02)', alignItems: 'center'
        }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            Priority
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            Player Name
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            Player ID
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            Health Status
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            Player State
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            Last Refresh
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            Actions
          </div>
        </div>

        {/* Rows */}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={players.map(p => p.id)} strategy={verticalListSortingStrategy}>
            {filteredPlayers.map(player => (
              <SortableRow
                key={player.id}
                player={player}
                status={statuses[player.id] || null}
                onIdentify={handleIdentify}
                onDelete={handleDelete}
                onEditName={handleEditName}
              />
            ))}
          </SortableContext>
        </DndContext>

        {filteredPlayers.length === 0 && (
          <div style={{ padding: '40px', textAlign: 'center', color: 'rgba(255,255,255,0.3)', fontFamily: 'var(--font-display)' }}>
            {showInactive ? 'No players found' : 'No active players found'}
          </div>
        )}
      </div>

      {/* Edit Name Modal */}
      {editingPlayer && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex',
          alignItems: 'center', justifyContent: 'center', zIndex: 1000
        }}>
          <div style={{
            background: '#111', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12,
            padding: 24, width: 400, maxWidth: '90%'
          }}>
            <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 16, color: '#fff', marginBottom: 16 }}>
              Edit Player Name
            </h3>
            <input
              type="text"
              value={editingName}
              onChange={(e) => setEditingName(e.target.value)}
              style={{
                width: '100%', padding: '10px 14px', borderRadius: 8, background: '#0d0d0d',
                border: '1px solid rgba(255,255,255,0.1)', color: '#fff', fontFamily: 'var(--font-mono)',
                fontSize: 14, marginBottom: 16, outline: 'none'
              }}
              placeholder="Enter player name"
              autoFocus
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Btn variant="ghost" onClick={() => { setEditingPlayer(null); setEditingName(''); }}>
                Cancel
              </Btn>
              <Btn variant="accent" onClick={handleSaveName}>
                Save
              </Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
