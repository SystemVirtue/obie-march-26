import { useEffect, useRef, useState } from 'react';
import {
  subscribeToKioskSession,
  subscribeToPlayerSettings,
  subscribeToQueue,
  subscribeToPlayerStatus,
  callKioskHandler,
  resolveJukeboxSlug,
  type KioskSession,
  type PlayerSettings,
  type QueueItem,
  type PlayerStatus,
} from '../../../shared/supabase-client';
import { normalizeJukeboxSlug, getPathJukeboxSlug } from '../../../shared/jukebox-utils';

type UseKioskSessionArgs = {
  defaultPlayerId: string;
  storageKey: string;
};

export function useKioskSession({ defaultPlayerId, storageKey }: UseKioskSessionArgs) {
  const [activePlayerId, setActivePlayerId] = useState<string | null>(null);
  const [activeJukeboxSlug, setActiveJukeboxSlug] = useState<string | null>(null);
  const [identityReady, setIdentityReady] = useState(false);
  const [session, setSession] = useState<KioskSession | null>(null);
  const [settings, setSettings] = useState<PlayerSettings | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [playerStatus, setPlayerStatus] = useState<PlayerStatus | null>(null);
  const playerStatusRef = useRef<PlayerStatus | null>(null);

  const playerId = activePlayerId || defaultPlayerId;

  useEffect(() => {
    let cancelled = false;

    const resolveIdentity = async () => {
      try {
        const pathSlug = getPathJukeboxSlug();
        const rememberedSlug = normalizeJukeboxSlug(localStorage.getItem(storageKey));
        let candidateSlug = pathSlug || rememberedSlug;

        if (!candidateSlug) {
          const entered = window.prompt('Enter Jukebox Name (e.g. OBIE):');
          candidateSlug = normalizeJukeboxSlug(entered);
        }

        if (!candidateSlug) {
          return;
        }

        const resolved = await resolveJukeboxSlug(candidateSlug);
        if (!resolved) {
          alert(`Jukebox "${candidateSlug}" was not found.`);
          localStorage.removeItem(storageKey);
          return;
        }

        if (!cancelled) {
          setActivePlayerId(resolved.player_id);
          setActiveJukeboxSlug(resolved.jukebox_slug);
        }

        localStorage.setItem(storageKey, resolved.jukebox_slug);
        if (pathSlug !== resolved.jukebox_slug) {
          window.history.replaceState({}, '', `/${resolved.jukebox_slug}`);
        }
      } catch (error) {
        console.error('Failed to resolve kiosk jukebox identity:', error);
      } finally {
        if (!cancelled) {
          setIdentityReady(true);
        }
      }
    };

    resolveIdentity();
    return () => {
      cancelled = true;
    };
  }, [storageKey]);

  useEffect(() => {
    if (!identityReady || !activePlayerId) return;

    const initSession = async () => {
      try {
        const { session: newSession } = await callKioskHandler({
          player_id: playerId,
          action: 'init',
        });
        setSession(newSession);
      } catch (error) {
        console.error('Failed to initialize session:', error);
      }
    };

    initSession();
  }, [identityReady, activePlayerId, playerId]);

  useEffect(() => {
    playerStatusRef.current = playerStatus;
  }, [playerStatus]);

  useEffect(() => {
    if (!identityReady || !activePlayerId) return;
    if (!session) return;

    // Subscribe only to the current session — credits shown must match what
    // kiosk_request_enqueue checks (per-session, not pooled across all sessions).
    const sub = subscribeToKioskSession(session.session_id, (s) => {
      setSession(s);
    });

    return () => {
      sub.unsubscribe();
    };
  }, [identityReady, activePlayerId, playerId, session?.session_id]);

  useEffect(() => {
    if (!identityReady || !activePlayerId) return;
    const sub = subscribeToPlayerSettings(playerId, setSettings);
    return () => sub.unsubscribe();
  }, [identityReady, activePlayerId, playerId]);

  useEffect(() => {
    if (!identityReady || !activePlayerId) return;
    const sub = subscribeToPlayerStatus(playerId, (s) => setPlayerStatus(s));
    return () => sub.unsubscribe();
  }, [identityReady, activePlayerId, playerId]);

  useEffect(() => {
    if (!identityReady || !activePlayerId) return;
    const sub = subscribeToQueue(playerId, (items) => {
      const currentPlayerStatus = playerStatusRef.current;
      const currentMediaId = currentPlayerStatus?.current_media_id || currentPlayerStatus?.current_media?.id || null;

      let upcomingItems = items;
      if (currentMediaId) {
        upcomingItems = items.filter((item) => item.media_item_id !== currentMediaId);
      }

      const priorityItems = upcomingItems.filter((item) => item.type === 'priority');
      const normalItems = upcomingItems.filter((item) => item.type === 'normal');

      const maxMarqueeItems = 5;
      const prioritySliced = priorityItems.slice(0, maxMarqueeItems);
      const remainingSlots = Math.max(0, maxMarqueeItems - prioritySliced.length);
      const normalSliced = normalItems.slice(0, remainingSlots);

      setQueue([...prioritySliced, ...normalSliced]);
    });
    return () => sub.unsubscribe();
  }, [identityReady, activePlayerId, playerId]);

  return {
    activePlayerId,
    activeJukeboxSlug,
    identityReady,
    playerId,
    session,
    settings,
    playerStatus,
    queue,
    setSession,
  };
}
