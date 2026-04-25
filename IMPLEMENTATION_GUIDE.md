# Simplified Master/Player Architecture - Implementation Guide

## Overview
Clean, reliable real-time video player system with single master + multiple passive viewers pattern and automatic failover.

---

## 1. DATABASE SCHEMA (SQL)

```sql
-- ============================================================
-- 1. PLAYBACK CONTROL (Single source of truth)
-- ============================================================
CREATE TABLE IF NOT EXISTS playback_control (
  id INTEGER PRIMARY KEY DEFAULT 1,
  player_id UUID REFERENCES players(id),
  current_video_id UUID REFERENCES queue(id),
  current_status TEXT CHECK (current_status IN ('IDLE', 'LOADING', 'PLAYING', 'PAUSED', 'ENDED', 'ERROR')),
  master_instance_id UUID,
  master_last_seen TIMESTAMPTZ DEFAULT NOW(),
  playback_position FLOAT DEFAULT 0,
  last_updated TIMESTAMPTZ DEFAULT NOW(),
  video_url TEXT,
  video_title TEXT,
  video_artist TEXT,
  version INTEGER DEFAULT 0
);

-- Initialize with default row
INSERT INTO playback_control (id, player_id, current_status) 
VALUES (1, 'OBIE', 'IDLE')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- 2. PLAYER CONNECTIONS (For admin visibility + debugging)
-- ============================================================
CREATE TABLE IF NOT EXISTS player_connections (
  instance_id UUID PRIMARY KEY,
  player_id UUID REFERENCES players(id),
  connection_status TEXT CHECK (connection_status IN ('ONLINE', 'OFFLINE', 'STALE')) DEFAULT 'ONLINE',
  is_master BOOLEAN DEFAULT FALSE,
  last_seen TIMESTAMPTZ DEFAULT NOW(),
  last_heartbeat TIMESTAMPTZ,
  user_agent TEXT,
  ip_address INET,
  connected_at TIMESTAMPTZ DEFAULT NOW(),
  disconnected_at TIMESTAMPTZ,
  tab_id TEXT,
  viewport_width INTEGER,
  viewport_height INTEGER
);

-- ============================================================
-- 3. PLAYER LOGS (For admin console logging)
-- ============================================================
CREATE TABLE IF NOT EXISTS player_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  event_type TEXT NOT NULL, -- 'MASTER_CLAIMED', 'MASTER_RELEASED', 'HEARTBEAT', 'ERROR', 'STATE_CHANGE', 'REFRESH_REQUEST', 'REFRESH_RESPONSE'
  instance_id UUID REFERENCES player_connections(instance_id),
  player_id UUID REFERENCES players(id),
  message TEXT NOT NULL,
  details JSONB,
  severity TEXT CHECK (severity IN ('INFO', 'WARN', 'ERROR')) DEFAULT 'INFO'
);

-- Index for faster log queries
CREATE INDEX idx_player_logs_timestamp ON player_logs(timestamp DESC);
CREATE INDEX idx_player_logs_event_type ON player_logs(event_type);
CREATE INDEX idx_player_logs_instance_id ON player_logs(instance_id);

-- ============================================================
-- 4. ENABLE REALTIME
-- ============================================================
ALTER TABLE playback_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_logs ENABLE ROW LEVEL SECURITY;

-- Enable realtime for all tables
ALTER PUBLICATION supabase_realtime ADD TABLE playback_control;
ALTER PUBLICATION supabase_realtime ADD TABLE player_connections;

-- ============================================================
-- 5. RLS POLICIES
-- ============================================================
CREATE POLICY "Allow all playback_control access" 
  ON playback_control FOR ALL 
  USING (true) 
  WITH CHECK (true);

CREATE POLICY "Allow all player_connections access" 
  ON player_connections FOR ALL 
  USING (true) 
  WITH CHECK (true);

CREATE POLICY "Allow all player_logs access" 
  ON player_logs FOR ALL 
  USING (true) 
  WITH CHECK (true);

-- ============================================================
-- 6. FUNCTIONS FOR MASTER MANAGEMENT
-- ============================================================

-- Function to claim master role (atomic)
CREATE OR REPLACE FUNCTION claim_master_role(
  p_instance_id UUID,
  p_player_id UUID,
  p_user_agent TEXT,
  p_ip_address INET,
  p_tab_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  current_master UUID;
  last_seen TIMESTAMPTZ;
  claim_success BOOLEAN := FALSE;
BEGIN
  -- Get current master info
  SELECT master_instance_id, master_last_seen 
  INTO current_master, last_seen
  FROM playback_control 
  WHERE id = 1;

  -- Check if master is stale (>20 seconds) or no master exists
  IF current_master IS NULL OR 
     last_seen < NOW() - INTERVAL '20 seconds' THEN
    
    -- Try to claim master role (optimistic concurrency)
    UPDATE playback_control 
    SET master_instance_id = p_instance_id,
        master_last_seen = NOW(),
        version = version + 1
    WHERE id = 1 
      AND (master_instance_id = current_master OR current_master IS NULL);
    
    IF FOUND THEN
      claim_success := TRUE;
      
      -- Update player_connections
      INSERT INTO player_connections (
        instance_id, player_id, is_master, user_agent, 
        ip_address, last_seen, last_heartbeat, tab_id
      )
      VALUES (
        p_instance_id, p_player_id, TRUE, p_user_agent,
        p_ip_address, NOW(), NOW(), p_tab_id
      )
      ON CONFLICT (instance_id) 
      DO UPDATE SET 
        is_master = TRUE,
        last_seen = NOW(),
        last_heartbeat = NOW(),
        connection_status = 'ONLINE';
      
      -- Log the event
      INSERT INTO player_logs (
        event_type, instance_id, player_id, message, details, severity
      )
      VALUES (
        'MASTER_CLAIMED',
        p_instance_id,
        p_player_id,
        format('Instance %s claimed master role (previous master was %s)', 
               p_instance_id, COALESCE(current_master::TEXT, 'none')),
        jsonb_build_object(
          'previous_master', current_master,
          'previous_master_last_seen', last_seen,
          'reason', CASE 
            WHEN current_master IS NULL THEN 'no_previous_master'
            WHEN last_seen < NOW() - INTERVAL '20 seconds' THEN 'master_stale'
            ELSE 'race_won'
          END
        ),
        'INFO'
      );
    END IF;
  END IF;

  RETURN claim_success;
END;
$$;

-- Function for master heartbeat
CREATE OR REPLACE FUNCTION master_heartbeat(
  p_instance_id UUID,
  p_player_id UUID,
  p_status TEXT DEFAULT NULL,
  p_position FLOAT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  is_current_master BOOLEAN;
BEGIN
  -- Verify this instance is the current master
  SELECT master_instance_id = p_instance_id 
  INTO is_current_master
  FROM playback_control 
  WHERE id = 1;

  IF is_current_master THEN
    UPDATE playback_control 
    SET master_last_seen = NOW(),
        last_updated = NOW(),
        current_status = COALESCE(p_status, current_status),
        playback_position = COALESCE(p_position, playback_position)
    WHERE id = 1;

    UPDATE player_connections 
    SET last_heartbeat = NOW(),
        last_seen = NOW()
    WHERE instance_id = p_instance_id;

    -- Log heartbeat periodically (every 10th call) to avoid spam
    IF random() < 0.1 THEN
      INSERT INTO player_logs (
        event_type, instance_id, player_id, message, details
      )
      VALUES (
        'HEARTBEAT',
        p_instance_id,
        p_player_id,
        'Master heartbeat received',
        jsonb_build_object('status', p_status, 'position', p_position)
      );
    END IF;

    RETURN TRUE;
  ELSE
    -- This instance is no longer master - log it
    INSERT INTO player_logs (
      event_type, instance_id, player_id, message, details, severity
    )
    VALUES (
      'ERROR',
      p_instance_id,
      p_player_id,
      'Heartbeat rejected - instance is not current master',
      jsonb_build_object(
        'current_master', (SELECT master_instance_id FROM playback_control WHERE id = 1)
      ),
      'WARN'
    );

    -- Update connection to show it's no longer master
    UPDATE player_connections 
    SET is_master = FALSE
    WHERE instance_id = p_instance_id;

    RETURN FALSE;
  END IF;
END;
$$;

-- Function to release master role (graceful shutdown)
CREATE OR REPLACE FUNCTION release_master_role(p_instance_id UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE playback_control 
  SET master_instance_id = NULL,
      master_last_seen = NULL,
      version = version + 1
  WHERE id = 1 AND master_instance_id = p_instance_id;

  IF FOUND THEN
    UPDATE player_connections 
    SET is_master = FALSE,
        disconnected_at = NOW(),
        connection_status = 'OFFLINE'
    WHERE instance_id = p_instance_id;

    INSERT INTO player_logs (
      event_type, instance_id, message, details
    )
    VALUES (
      'MASTER_RELEASED',
      p_instance_id,
      'Master role released gracefully',
      jsonb_build_object('reason', 'graceful_shutdown')
    );
  END IF;
END;
$$;

-- Function to force master reassignment (admin override)
CREATE OR REPLACE FUNCTION force_master_assignment(
  p_instance_id UUID,
  p_admin_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  old_master UUID;
BEGIN
  SELECT master_instance_id INTO old_master FROM playback_control WHERE id = 1;

  UPDATE playback_control 
  SET master_instance_id = p_instance_id,
      master_last_seen = NOW(),
      version = version + 1
  WHERE id = 1;

  UPDATE player_connections SET is_master = FALSE WHERE is_master = TRUE;
  UPDATE player_connections SET is_master = TRUE WHERE instance_id = p_instance_id;

  INSERT INTO player_logs (
    event_type, instance_id, message, details, severity
  )
  VALUES (
    'MASTER_CLAIMED',
    p_instance_id,
    format('Admin %s forced master assignment', p_admin_id),
    jsonb_build_object(
      'previous_master', old_master,
      'forced_by', p_admin_id,
      'reason', 'admin_override'
    ),
    'WARN'
  );

  RETURN TRUE;
END;
$$;

-- Function to mark stale connections offline
CREATE OR REPLACE FUNCTION cleanup_stale_connections()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  stale_count INTEGER;
BEGIN
  UPDATE player_connections 
  SET connection_status = 'STALE',
      is_master = FALSE
  WHERE last_heartbeat < NOW() - INTERVAL '30 seconds'
    AND connection_status = 'ONLINE';

  GET DIAGNOSTICS stale_count = ROW_COUNT;

  -- Also clear master if it's stale
  UPDATE playback_control 
  SET master_instance_id = NULL,
      master_last_seen = NULL
  WHERE id = 1 
    AND master_last_seen < NOW() - INTERVAL '30 seconds';

  RETURN stale_count;
END;
$$;

-- Function for admin refresh request (broadcast to all)
CREATE OR REPLACE FUNCTION request_player_refresh(
  p_requester TEXT,
  p_player_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO player_logs (
    event_type, player_id, message, details
  )
  VALUES (
    'REFRESH_REQUEST',
    p_player_id,
    format('Admin refresh requested by %s', p_requester),
    jsonb_build_object('requested_by', p_requester, 'timestamp', NOW())
  );
END;
$$;

-- Function to log player state response
CREATE OR REPLACE FUNCTION log_player_response(
  p_instance_id UUID,
  p_player_id UUID,
  p_state JSONB
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO player_logs (
    event_type, instance_id, player_id, message, details
  )
  VALUES (
    'REFRESH_RESPONSE',
    p_instance_id,
    p_player_id,
    'Player responded to refresh request',
    jsonb_build_object('state', p_state, 'responded_at', NOW())
  );

  UPDATE player_connections 
  SET last_seen = NOW()
  WHERE instance_id = p_instance_id;
END;
$$;
```

---

## 2. PLAYER PAGE (/player) - React Implementation

```typescript
// web/player/src/hooks/useMasterPlayer.ts
import { useEffect, useRef, useState, useCallback } from 'react';
import { supabase } from '@shared/supabase-client';
import { v4 as uuidv4 } from 'uuid';

const HEARTBEAT_INTERVAL = 8000; // 8 seconds
const MASTER_TIMEOUT = 20000; // 20 seconds

interface PlaybackState {
  current_video_id: string | null;
  current_status: 'IDLE' | 'LOADING' | 'PLAYING' | 'PAUSED' | 'ENDED' | 'ERROR';
  master_instance_id: string | null;
  master_last_seen: string | null;
  playback_position: number;
  video_url: string | null;
  video_title: string | null;
  video_artist: string | null;
}

export function useMasterPlayer(playerId: string = 'OBIE') {
  const [instanceId] = useState(() => {
    const stored = localStorage.getItem('player_instance_id');
    if (stored) return stored;
    const newId = uuidv4();
    localStorage.setItem('player_instance_id', newId);
    return newId;
  });

  const [isMaster, setIsMaster] = useState(false);
  const [playbackState, setPlaybackState] = useState<PlaybackState | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'online' | 'offline'>('connecting');
  
  const channelRef = useRef<any>(null);
  const heartbeatIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const tabIdRef = useRef<string>(Math.random().toString(36).substring(2, 15));

  // Check if we should claim master role
  const tryClaimMaster = useCallback(async () => {
    try {
      const { data, error } = await supabase.rpc('claim_master_role', {
        p_instance_id: instanceId,
        p_player_id: playerId,
        p_user_agent: navigator.userAgent,
        p_ip_address: null, // Will be set by server
        p_tab_id: tabIdRef.current
      });

      if (error) {
        console.error('Failed to claim master:', error);
        return false;
      }

      if (data) {
        setIsMaster(true);
        console.log('✅ Became master player');
      }
      return data;
    } catch (err) {
      console.error('Error claiming master:', err);
      return false;
    }
  }, [instanceId, playerId]);

  // Send heartbeat (only if master)
  const sendHeartbeat = useCallback(async () => {
    if (!isMaster) return;

    try {
      const video = document.querySelector('video');
      const position = video?.currentTime || 0;
      const status = video?.paused ? 'PAUSED' : 
                    video?.ended ? 'ENDED' : 
                    video?.readyState >= 3 ? 'PLAYING' : 'LOADING';

      const { data } = await supabase.rpc('master_heartbeat', {
        p_instance_id: instanceId,
        p_player_id: playerId,
        p_status: status,
        p_position: position
      });

      if (!data) {
        // Lost master role
        setIsMaster(false);
        console.log('🔄 Lost master role, becoming viewer');
      }
    } catch (err) {
      console.error('Heartbeat failed:', err);
    }
  }, [isMaster, instanceId, playerId]);

  // Handle video end (only master advances queue)
  const handleVideoEnd = useCallback(async () => {
    if (!isMaster) {
      console.log('Video ended but not master - ignoring');
      return;
    }

    console.log('🎬 Master detected video end - advancing queue');
    
    try {
      // Call your existing queue advancement RPC
      const { error } = await supabase.rpc('complete_and_advance', {
        p_queue_id: playbackState?.current_video_id
      });

      if (error) {
        console.error('Failed to advance queue:', error);
      }
    } catch (err) {
      console.error('Error advancing queue:', err);
    }
  }, [isMaster, playbackState?.current_video_id]);

  // Setup presence channel and realtime subscriptions
  useEffect(() => {
    // 1. Setup Presence channel for connection tracking
    const channel = supabase.channel(`playback-room:${playerId}`, {
      config: {
        presence: {
          key: instanceId,
        },
      },
    });

    channelRef.current = channel;

    // 2. Handle presence sync (for detecting other players)
    channel.on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState();
      console.log('Presence state:', Object.keys(state).length, 'players connected');
    });

    // 3. Handle broadcast messages (for admin refresh requests)
    channel.on('broadcast', { event: 'refresh-request' }, async () => {
      console.log('Received refresh request from admin');
      
      // Respond with current state
      const video = document.querySelector('video');
      await supabase.rpc('log_player_response', {
        p_instance_id: instanceId,
        p_player_id: playerId,
        p_state: {
          is_master: isMaster,
          current_video_id: playbackState?.current_video_id,
          status: playbackState?.current_status,
          current_time: video?.currentTime,
          paused: video?.paused,
          ended: video?.ended,
          ready_state: video?.readyState
        }
      });
    });

    // 4. Subscribe to channel
    channel.subscribe(async (status: string) => {
      if (status === 'SUBSCRIBED') {
        setConnectionStatus('online');
        
        // Track presence
        await channel.track({
          online_at: new Date().toISOString(),
          instance_id: instanceId,
          is_master: false, // Will be updated after claim
        });

        // Try to claim master on connect
        await tryClaimMaster();
      }
    });

    // 5. Subscribe to playback_control changes
    const playbackSubscription = supabase
      .channel(`playback-control:${playerId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'playback_control',
          filter: `player_id=eq.${playerId}`,
        },
        (payload: any) => {
          console.log('Playback state changed:', payload.new);
          setPlaybackState(payload.new);

          // Check if we should try to claim master (if current master is stale)
          if (payload.new.master_instance_id) {
            const lastSeen = new Date(payload.new.master_last_seen);
            const isStale = Date.now() - lastSeen.getTime() > MASTER_TIMEOUT;
            
            if (isStale) {
              console.log('Master is stale - attempting to claim');
              tryClaimMaster();
            } else if (payload.new.master_instance_id === instanceId) {
              setIsMaster(true);
            } else {
              setIsMaster(false);
            }
          } else {
            // No master - try to claim
            tryClaimMaster();
          }
        }
      )
      .subscribe();

    // Cleanup
    return () => {
      channel.unsubscribe();
      playbackSubscription.unsubscribe();
      
      // Release master role gracefully
      if (isMaster) {
        supabase.rpc('release_master_role', { p_instance_id: instanceId });
      }
    };
  }, [instanceId, playerId, tryClaimMaster]);

  // Start heartbeat when becoming master
  useEffect(() => {
    if (isMaster) {
      console.log('Starting master heartbeat');
      heartbeatIntervalRef.current = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
    } else {
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }
    }

    return () => {
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
      }
    };
  }, [isMaster, sendHeartbeat]);

  // Handle page unload gracefully
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (isMaster) {
        supabase.rpc('release_master_role', { p_instance_id: instanceId });
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isMaster, instanceId]);

  return {
    instanceId,
    isMaster,
    playbackState,
    connectionStatus,
    handleVideoEnd,
  };
}
```

```tsx
// web/player/src/components/Player.tsx
import React, { useRef, useEffect } from 'react';
import { useMasterPlayer } from '../hooks/useMasterPlayer';
import Hls from 'hls.js';

export function Player() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { isMaster, playbackState, connectionStatus, handleVideoEnd } = useMasterPlayer('OBIE');

  // Load and play video when it changes
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playbackState?.video_url) return;

    // Check if URL is HLS
    if (playbackState.video_url.endsWith('.m3u8') && Hls.isSupported()) {
      const hls = new Hls();
      hls.loadSource(playbackState.video_url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play();
      });

      return () => {
        hls.destroy();
      };
    } else {
      // Direct video URL (R2, etc.)
      video.src = playbackState.video_url;
      video.play();
    }
  }, [playbackState?.video_url]);

  // Handle video events
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    video.addEventListener('ended', handleVideoEnd);
    return () => video.removeEventListener('ended', handleVideoEnd);
  }, [handleVideoEnd]);

  return (
    <div className="player-container" style={{ position: 'relative', width: '100vw', height: '100vh' }}>
      {/* Status indicator */}
      <div style={{
        position: 'absolute',
        top: 20,
        right: 20,
        zIndex: 100,
        padding: '10px 20px',
        borderRadius: 8,
        background: isMaster ? 'rgba(0, 255, 0, 0.8)' : 'rgba(255, 165, 0, 0.8)',
        color: 'black',
        fontWeight: 'bold',
        fontFamily: 'sans-serif',
      }}>
        {isMaster ? '🎬 MASTER PLAYER' : '👁️ VIEWER'}
        <br />
        <small>{connectionStatus}</small>
      </div>

      {/* Now playing overlay (for master or if title exists) */}
      {playbackState?.video_title && (
        <div style={{
          position: 'absolute',
          bottom: 100,
          left: 20,
          zIndex: 100,
          padding: '15px 25px',
          borderRadius: 8,
          background: 'rgba(0, 0, 0, 0.7)',
          color: 'white',
          fontFamily: 'sans-serif',
        }}>
          <div style={{ fontSize: 24, fontWeight: 'bold' }}>
            {playbackState.video_title}
          </div>
          {playbackState.video_artist && (
            <div style={{ fontSize: 18, opacity: 0.8 }}>
              {playbackState.video_artist}
            </div>
          )}
          <div style={{ fontSize: 14, marginTop: 8, opacity: 0.6 }}>
            Status: {playbackState.current_status}
          </div>
        </div>
      )}

      {/* Video element */}
      <video
        ref={videoRef}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          background: 'black',
        }}
        controls={isMaster} // Only show controls for master
        muted={!isMaster} // Mute viewers (optional - depends on your use case)
        playsInline
      />
    </div>
  );
}
```

---

## 3. ADMIN CONSOLE - Player Connections & Logs

```tsx
// web/admin/src/pages/PlayerManagement.tsx
import React, { useEffect, useState, useCallback } from 'react';
import { supabase } from '@shared/supabase-client';

interface PlayerConnection {
  instance_id: string;
  player_id: string;
  connection_status: 'ONLINE' | 'OFFLINE' | 'STALE';
  is_master: boolean;
  last_seen: string;
  last_heartbeat: string;
  user_agent: string;
  connected_at: string;
  tab_id: string;
}

interface PlayerLog {
  id: string;
  timestamp: string;
  event_type: string;
  instance_id: string;
  player_id: string;
  message: string;
  details: any;
  severity: 'INFO' | 'WARN' | 'ERROR';
}

export function PlayerManagement() {
  const [connections, setConnections] = useState<PlayerConnection[]>([]);
  const [logs, setLogs] = useState<PlayerLog[]>([]);
  const [playbackControl, setPlaybackControl] = useState<any>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedPlayer, setSelectedPlayer] = useState<string | null>(null);

  // Fetch current state
  const fetchData = useCallback(async () => {
    // Get connections
    const { data: connectionsData } = await supabase
      .from('player_connections')
      .select('*')
      .order('last_seen', { ascending: false });

    if (connectionsData) {
      setConnections(connectionsData);
    }

    // Get playback control state
    const { data: controlData } = await supabase
      .from('playback_control')
      .select('*')
      .eq('id', 1)
      .single();

    if (controlData) {
      setPlaybackControl(controlData);
    }

    // Get recent logs
    const { data: logsData } = await supabase
      .from('player_logs')
      .select('*')
      .order('timestamp', { ascending: false })
      .limit(100);

    if (logsData) {
      setLogs(logsData);
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
        table: 'player_connections'
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
    });

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

    await supabase.rpc('force_master_assignment', {
      p_instance_id: instanceId,
      p_admin_id: 'admin-console'
    });

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
          🧹 Cleanup Stale (>30s)
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
                const isStale = new Date(conn.last_heartbeat).getTime() < Date.now() - 30000;
                
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
                    <td className="border p-2 font-mono text-xs">{conn.tab_id}</td>
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
              <span className={`ml-2 px-1 rounded ${
                log.severity === 'ERROR' ? 'bg-red-600 text-white' :
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
```

---

## Summary of Architecture

### Key Principles:
1. **Single Master Row**: `playback_control` table is the single source of truth
2. **Presence + Heartbeat**: Presence for connection tracking, heartbeat for master liveness
3. **Stale Detection**: 20-second timeout for automatic failover
4. **Admin Override**: Manual master assignment capability
5. **Comprehensive Logging**: All master changes and errors logged to `player_logs`
6. **Refresh on Demand**: Admin can poll all connections via broadcast

### Flow:
1. Player loads → generates `instance_id` → joins Presence channel
2. Tries to claim master (if no master or current master is stale)
3. Master sends heartbeat every 8 seconds
4. All players watch `playback_control` for video/state changes
5. Only master sends `ENDED` event → advances queue
6. If master dies, next heartbeat check triggers failover
7. Admin console shows all connections + logs + can force master

This eliminates complexity while maintaining reliability and observability.
