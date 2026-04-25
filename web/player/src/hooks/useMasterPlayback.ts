import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@shared/supabase-client';

const INSTANCE_KEY = 'obie_player_instance_id_v1';
const HEARTBEAT_MS = 8_000;
const STALE_MASTER_MS = 20_000;

export interface PlaybackControlRow {
  id: number;
  current_video_id: string | null;
  current_status: 'IDLE' | 'LOADING' | 'PLAYING' | 'PAUSED' | 'ENDED' | null;
  master_instance_id: string | null;
  master_last_seen: string;
  playback_position: number;
  last_updated: string;
}

export interface LocalPlaybackSnapshot {
  status: 'IDLE' | 'LOADING' | 'PLAYING' | 'PAUSED' | 'ENDED';
  currentVideoId: string | null;
  playbackPosition: number;
}

function loadOrCreateInstanceId(): string {
  const existing = localStorage.getItem(INSTANCE_KEY);
  if (existing) return existing;
  const created = crypto.randomUUID();
  localStorage.setItem(INSTANCE_KEY, created);
  return created;
}

export function useMasterPlayback(params: {
  enabled?: boolean;
  getSnapshot: () => LocalPlaybackSnapshot;
  onRemoteControl: (control: PlaybackControlRow) => void;
}) {
  const { enabled = false, getSnapshot, onRemoteControl } = params;
  const [instanceId, setInstanceId] = useState<string | null>(null);
  const [control, setControl] = useState<PlaybackControlRow | null>(null);
  const [isMaster, setIsMaster] = useState(!enabled);
  const isMasterRef = useRef(!enabled);
  const onRemoteControlRef = useRef(onRemoteControl);
  onRemoteControlRef.current = onRemoteControl;

  const claimMaster = useCallback(async (reason: string) => {
    if (!enabled) return true;
    if (!instanceId) return false;
    try {
      const { data, error } = await supabase.rpc('claim_playback_master', {
        p_instance_id: instanceId,
        p_reason: reason,
      } as any);
      if (error) throw error;
      return !!data;
    } catch (error) {
      console.warn('[MASTER] Failed to claim master role:', error);
      return false;
    }
  }, [enabled, instanceId]);

  const refreshControl = useCallback(async () => {
    if (!enabled) return null;
    const { data, error } = await supabase
      .from('playback_control')
      .select('*')
      .eq('id', 1)
      .single();
    if (error) {
      console.warn('[MASTER] Failed to load playback_control:', error);
      return null;
    }
    const row = data as any as PlaybackControlRow;
    setControl(row);
    setIsMaster(!!instanceId && row.master_instance_id === instanceId);
    isMasterRef.current = !!instanceId && row.master_instance_id === instanceId;
    return row;
  }, [enabled, instanceId]);

  const publishSnapshot = useCallback(async (snapshot: LocalPlaybackSnapshot) => {
    if (!enabled) return;
    if (!instanceId || !isMasterRef.current) return;
    const { error } = await (supabase as any)
      .from('playback_control')
      .update({
        current_video_id: snapshot.currentVideoId,
        current_status: snapshot.status,
        playback_position: snapshot.playbackPosition,
        master_last_seen: new Date().toISOString(),
        last_updated: new Date().toISOString(),
      } as any)
      .eq('id', 1)
      .eq('master_instance_id', instanceId);
    if (error) {
      console.warn('[MASTER] Failed to publish snapshot:', error);
    }
  }, [enabled, instanceId]);

  useEffect(() => {
    if (!enabled) {
      setIsMaster(true);
      isMasterRef.current = true;
      return;
    }
    const id = loadOrCreateInstanceId();
    setInstanceId(id);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    if (!instanceId) return;
    (async () => {
      await supabase.from('player_instances').upsert({
        instance_id: instanceId,
        connection_status: 'ONLINE',
        user_agent: navigator.userAgent,
        last_seen: new Date().toISOString(),
        last_heartbeat: new Date().toISOString(),
      } as any);
      await refreshControl();
      await claimMaster('initial_connect');
      await refreshControl();
    })();
  }, [enabled, instanceId, claimMaster, refreshControl]);

  useEffect(() => {
    if (!enabled) return;
    if (!instanceId) return;
    const channel = supabase
      .channel('playback-room', {
        config: {
          presence: { key: instanceId },
          broadcast: { self: true },
        },
      })
      .on('broadcast', { event: 'refresh_connections' }, ({ payload }) => {
        const requestId = payload?.requestId ?? null;
        const snapshot = getSnapshot();
        void channel.send({
          type: 'broadcast',
          event: 'player_state_response',
          payload: {
            requestId,
            instance_id: instanceId,
            is_master: isMasterRef.current,
            current_video_id: snapshot.currentVideoId,
            status: snapshot.status,
            playback_position: snapshot.playbackPosition,
            responded_at: new Date().toISOString(),
          },
        });
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await channel.track({
            instance_id: instanceId,
            user_agent: navigator.userAgent,
            connected_at: new Date().toISOString(),
          });
        }
      });

    return () => {
      void (supabase as any).from('player_instances')
        .update({
          connection_status: 'OFFLINE',
          is_master: false,
          last_seen: new Date().toISOString(),
        } as any)
        .eq('instance_id', instanceId);
      supabase.removeChannel(channel);
    };
  }, [enabled, instanceId, getSnapshot]);

  useEffect(() => {
    if (!enabled) return;
    const channel = supabase
      .channel('playback-control-updates')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'playback_control', filter: 'id=eq.1' },
        (payload) => {
          const row = payload.new as any as PlaybackControlRow;
          if (!row) return;
          setControl(row);
          const nextIsMaster = !!instanceId && row.master_instance_id === instanceId;
          setIsMaster(nextIsMaster);
          isMasterRef.current = nextIsMaster;
          if (!nextIsMaster) {
            onRemoteControlRef.current(row);
          }
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [enabled, instanceId]);

  useEffect(() => {
    if (!enabled) return;
    if (!instanceId) return;
    const tick = async () => {
      await supabase.from('player_instances').upsert({
        instance_id: instanceId,
        connection_status: 'ONLINE',
        is_master: isMasterRef.current,
        user_agent: navigator.userAgent,
        last_seen: new Date().toISOString(),
        last_heartbeat: new Date().toISOString(),
      } as any);

      if (isMasterRef.current) {
        await supabase.rpc('heartbeat_playback_master', { p_instance_id: instanceId } as any);
        return;
      }

      const row = control ?? await refreshControl();
      if (!row) return;
      const masterLastSeen = row.master_last_seen ? new Date(row.master_last_seen).getTime() : 0;
      const stale = !row.master_instance_id || (Date.now() - masterLastSeen) > STALE_MASTER_MS;
      if (stale) {
        await claimMaster('master_timeout');
        await refreshControl();
      }
    };

    void tick();
    const id = setInterval(() => { void tick(); }, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [enabled, instanceId, control, claimMaster, refreshControl]);

  const api = useMemo(() => ({
    instanceId,
    isMaster,
    control,
    publishSnapshot,
    forceClaimMaster: claimMaster,
  }), [instanceId, isMaster, control, publishSnapshot, claimMaster]);

  return api;
}
