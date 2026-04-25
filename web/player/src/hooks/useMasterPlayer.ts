import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../../../shared/supabase-client';

const HEARTBEAT_INTERVAL = 8000; // 8 seconds
const MASTER_TIMEOUT = 20000; // 20 seconds

interface PlaybackState {
  current_video_id: string | null;
  current_status: 'IDLE' | 'LOADING' | 'PLAYING' | 'PAUSED' | 'ENDED' | 'ERROR' | null;
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
    const newId = crypto.randomUUID();
    localStorage.setItem('player_instance_id', newId);
    return newId;
  });

  const [isMaster, setIsMaster] = useState(false);
  const [playbackState, setPlaybackState] = useState<PlaybackState | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'online' | 'offline'>('connecting');
  
  const channelRef = useRef<any>(null);
  const heartbeatIntervalRef = useRef<number | null>(null);
  const tabIdRef = useRef<string>(Math.random().toString(36).substring(2, 15));

  // Check if we should claim master role
  const tryClaimMaster = useCallback(async () => {
    try {
      const { data, error } = await supabase.rpc('claim_playback_master', {
        p_instance_id: instanceId,
        p_player_id: playerId,
        p_user_agent: navigator.userAgent,
        p_ip_address: null, // Will be set by server
        p_tab_id: tabIdRef.current,
        p_reason: 'initial_claim'
      } as any);

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
                    (video?.readyState && video.readyState >= 3) ? 'PLAYING' : 'LOADING';

      const { data } = await supabase.rpc('heartbeat_playback_master', {
        p_instance_id: instanceId,
        p_player_id: playerId,
        p_status: status,
        p_position: position
      } as any);

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
      // Call the existing complete_and_advance RPC
      const { error } = await supabase.rpc('complete_and_advance', {
        p_queue_id: playbackState?.current_video_id
      } as any);

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
      } as any);
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
        supabase.rpc('release_master_role', { p_instance_id: instanceId } as any);
      }
    };
  }, [instanceId, playerId, tryClaimMaster, isMaster, playbackState]);

  // Start heartbeat when becoming master
  useEffect(() => {
    if (isMaster) {
      console.log('Starting master heartbeat');
      heartbeatIntervalRef.current = window.setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
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
        supabase.rpc('release_master_role', { p_instance_id: instanceId } as any);
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
