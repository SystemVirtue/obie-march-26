import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@shared/supabase-client';

interface PlayerConnection {
  instance_id: string;
  player_id: string | null;
  connection_status: 'ONLINE' | 'OFFLINE' | 'STALE';
  is_master: boolean;
  last_seen: string;
  last_heartbeat: string;
  user_agent: string | null;
  connected_at: string;
  tab_id: string | null;
}

interface PlayerLog {
  id: number;
  timestamp: string;
  event_type: string;
  instance_id: string | null;
  player_id: string | null;
  message: string;
  details: any;
  severity: 'INFO' | 'WARN' | 'ERROR';
}

interface PlaybackControl {
  id: number;
  current_video_id: string | null;
  current_status: 'IDLE' | 'LOADING' | 'PLAYING' | 'PAUSED' | 'ENDED' | 'ERROR' | null;
  master_instance_id: string | null;
  master_last_seen: string;
  playback_position: number;
  last_updated: string;
  video_url: string | null;
  video_title: string | null;
  video_artist: string | null;
}

export function PlayerManagement() {
  const [connections, setConnections] = useState<PlayerConnection[]>([]);
  const [logs, setLogs] = useState<PlayerLog[]>([]);
  const [playbackControl, setPlaybackControl] = useState<PlaybackControl | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Fetch current state
  const fetchData = useCallback(async () => {
    // Get connections
    const { data: connectionsData } = await supabase
      .from('player_instances')
      .select('*')
      .order('last_seen', { ascending: false });

    if (connectionsData) {
      setConnections(connectionsData as PlayerConnection[]);
    }

    // Get playback control state
    const { data: controlData } = await supabase
      .from('playback_control')
      .select('*')
      .eq('id', 1)
      .single();

    if (controlData) {
      setPlaybackControl(controlData as PlaybackControl);
    }

    // Get recent logs
    const { data: logsData } = await supabase
      .from('player_logs')
      .select('*')
      .order('timestamp', { ascending: false })
      .limit(100);

    if (logsData) {
      setLogs(logsData as PlayerLog[]);
    }
  }, []);

  // Subscribe to realtime updates
  useEffect(() => {
    fetchData();

    const connectionsSub = supabase
      .channel('admin-connections')
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'player_instances'
      }, () => fetchData())
      .subscribe();

    const logsSub = supabase
      .channel('admin-logs')
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'player_logs'
      }, (payload) => {
        setLogs(prev => [payload.new as PlayerLog, ...prev].slice(0, 100));
      })
      .subscribe();

    const playbackSub = supabase
      .channel('admin-playback')
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'playback_control'
      }, () => fetchData())
      .subscribe();

    // Periodic refresh
    const interval = setInterval(fetchData, 5000);

    return () => {
      connectionsSub.unsubscribe();
      logsSub.unsubscribe();
      playbackSub.unsubscribe();
      clearInterval(interval);
    };
  }, [fetchData]);

  // Send refresh request to all players
  const handleRefreshAll = async () => {
    setRefreshing(true);

    // Log the request
    await supabase.rpc('request_player_refresh', {
      p_requester: 'admin-console',
      p_player_id: 'OBIE'
    } as any);

    // Broadcast to all players
    const channel = supabase.channel('playback-room:OBIE');
    channel.subscribe(async (status: string) => {
      if (status === 'SUBSCRIBED') {
        await channel.send({
          type: 'broadcast',
          event: 'refresh-request',
          payload: { requested_at: new Date().toISOString() }
        });
        channel.unsubscribe();
      }
    });

    setTimeout(() => {
      setRefreshing(false);
      fetchData();
    }, 3000);
  };

  // Force master assignment
  const handleForceMaster = async (instanceId: string) => {
    if (!confirm(`Force ${instanceId} to become master?`)) return;

    await supabase.rpc('force_master_instance', {
      p_instance_id: instanceId,
      p_message: 'admin_forced'
    } as any);

    fetchData();
  };

  // Cleanup stale connections
  const handleCleanupStale = async () => {
    const { data } = await supabase.rpc('cleanup_stale_connections');
    alert(`Cleaned up ${data} stale connections`);
    fetchData();
  };

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6">Player Connection Management</h1>

      {/* Control Bar */}
      <div className="flex gap-4 mb-6">
        <button
          onClick={handleRefreshAll}
          disabled={refreshing}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {refreshing ? 'Refreshing...' : '🔄 Refresh All Connections'}
        </button>

        <button
          onClick={handleCleanupStale}
          className="px-4 py-2 bg-orange-600 text-white rounded hover:bg-orange-700"
        >
          🧹 Cleanup Stale (&gt;30s)
        </button>

        <button
          onClick={fetchData}
          className="px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-700"
        >
          🔄 Reload Data
        </button>
      </div>

      {/* Current Master Status */}
      <div className="bg-gray-100 p-4 rounded-lg mb-6">
        <h2 className="font-semibold mb-2">Current Playback State</h2>
        {playbackControl ? (
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <strong>Master Instance:</strong>{' '}
              {playbackControl.master_instance_id || 'None'}
              {playbackControl.master_instance_id && (
                <span className="ml-2 px-2 py-1 bg-green-200 rounded text-xs">
                  MASTER
                </span>
              )}
            </div>
            <div>
              <strong>Status:</strong> {playbackControl.current_status}
            </div>
            <div>
              <strong>Last Seen:</strong>{' '}
              {playbackControl.master_last_seen
                ? new Date(playbackControl.master_last_seen).toLocaleString()
                : 'Never'}
            </div>
            <div>
              <strong>Current Video:</strong> {playbackControl.video_title || 'None'}
            </div>
          </div>
        ) : (
          <div>Loading...</div>
        )}
      </div>

      {/* Connections Table */}
      <div className="mb-8">
        <h2 className="text-xl font-semibold mb-4">
          Active Connections ({connections.filter(c => c.connection_status === 'ONLINE').length} online)
        </h2>

        <div className="overflow-x-auto">
          <table className="min-w-full border-collapse border border-gray-300">
            <thead className="bg-gray-50">
              <tr>
                <th className="border p-2">Status</th>
                <th className="border p-2">Instance ID</th>
                <th className="border p-2">Tab ID</th>
                <th className="border p-2">Last Seen</th>
                <th className="border p-2">Heartbeat</th>
                <th className="border p-2">Connected</th>
                <th className="border p-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {connections.map(conn => {
                const isStale = conn.last_heartbeat
                  ? new Date(conn.last_heartbeat).getTime() < Date.now() - 30000
                  : false;

                return (
                  <tr
                    key={conn.instance_id}
                    className={conn.is_master ? 'bg-green-100' : isStale ? 'bg-red-50' : ''}
                  >
                    <td className="border p-2">
                      {conn.is_master ? (
                        <span className="px-2 py-1 bg-green-500 text-white rounded text-xs font-bold">
                          MASTER
                        </span>
                      ) : (
                        <span className="px-2 py-1 bg-gray-300 rounded text-xs">
                          {conn.connection_status}
                        </span>
                      )}
                    </td>
                    <td className="border p-2 font-mono text-xs">
                      {conn.instance_id.substring(0, 8)}...
                    </td>
                    <td className="border p-2 font-mono text-xs">{conn.tab_id || '-'}</td>
                    <td className="border p-2 text-xs">
                      {new Date(conn.last_seen).toLocaleTimeString()}
                    </td>
                    <td className="border p-2 text-xs">
                      {conn.last_heartbeat
                        ? new Date(conn.last_heartbeat).toLocaleTimeString()
                        : 'Never'}
                    </td>
                    <td className="border p-2 text-xs">
                      {new Date(conn.connected_at).toLocaleString()}
                    </td>
                    <td className="border p-2">
                      {!conn.is_master && (
                        <button
                          onClick={() => handleForceMaster(conn.instance_id)}
                          className="px-2 py-1 bg-purple-600 text-white rounded text-xs hover:bg-purple-700"
                        >
                          Make Master
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Event Logs */}
      <div>
        <h2 className="text-xl font-semibold mb-4">Recent Event Logs</h2>

        <div className="bg-black text-green-400 font-mono text-sm p-4 rounded h-96 overflow-y-auto">
          {logs.map(log => (
            <div key={log.id} className="mb-2">
              <span className="text-gray-500">
                [{new Date(log.timestamp).toLocaleTimeString()}]
              </span>
              <span className={`ml-2 px-1 rounded ${log.severity === 'ERROR' ? 'bg-red-600 text-white' :
                log.severity === 'WARN' ? 'bg-yellow-600 text-black' :
                  'bg-blue-600 text-white'
                }`}>
                {log.event_type}
              </span>
              <span className="ml-2 text-white">{log.message}</span>
              {log.details && (
                <div className="ml-8 text-gray-400 text-xs">
                  {JSON.stringify(log.details)}
                </div>
              )}
            </div>
          ))}
          {logs.length === 0 && <div className="text-gray-500">No logs yet...</div>}
        </div>
      </div>
    </div>
  );
}
