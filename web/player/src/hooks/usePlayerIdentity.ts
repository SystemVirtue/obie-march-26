import { useEffect, useState } from 'react';
import { supabase, resolveJukeboxSlug } from '@shared/supabase-client';
import { getPathJukeboxSlug, normalizeJukeboxSlug } from '@shared/jukebox-utils';

type UsePlayerIdentityArgs = {
  defaultPlayerId: string;
  storageKey: string;
};

export function usePlayerIdentity({ defaultPlayerId, storageKey }: UsePlayerIdentityArgs) {
  const [activePlayerId, setActivePlayerId] = useState<string | null>(null);
  const [identityReady, setIdentityReady] = useState(false);

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

        // Update last_refresh timestamp on initialization
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (supabase as any)
            .from('players')
            .update({ last_refresh: new Date().toISOString() })
            .eq('id', resolved.player_id);
        } catch (error) {
          console.error('[PlayerIdentity] Failed to update last_refresh:', error);
        }

        // Check if player is already active in another tab
        const { data } = await supabase
          .from('players')
          .select('last_seen, status')
          .eq('id', resolved.player_id)
          .single();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const playerStatus = data as any;

        const isAlreadyActive = playerStatus && 
          playerStatus.status === 'online' && 
          playerStatus.last_seen && 
          new Date(playerStatus.last_seen).getTime() > Date.now() - 60000; // Active within last 60 seconds

        if (isAlreadyActive && !cancelled) {
          const shouldProceed = window.confirm(
            'Player is already active in another tab. Are you sure you want to create a new Player?'
          );

          if (!shouldProceed) {
            // Cancel - close the tab
            window.close();
            return;
          }

          // Yes - proceed with creating a new player
          localStorage.removeItem(storageKey);
          const playerName = `Player_${Date.now()}`;
          const jukeboxSlug = `PLAYER_${Date.now().toString(36).toUpperCase()}`;
          
          const { data, error: createError } = await supabase.rpc('create_player' as any, {
            p_name: playerName,
            p_jukebox_slug: jukeboxSlug,
          } as any);

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const newPlayer = data as any;

          if (createError || !newPlayer) {
            console.error('Failed to create new player:', createError);
            alert('Failed to create new player. Please try again.');
            return;
          }

          candidateSlug = newPlayer.jukebox_slug;
          console.log('[PlayerIdentity] Created new player after confirmation:', newPlayer.id, candidateSlug);

          // Resolve the new player
          const newResolved = await resolveJukeboxSlug(candidateSlug);
          if (!newResolved) {
            alert(`Failed to resolve new player "${candidateSlug}".`);
            return;
          }

          if (!cancelled) {
            setActivePlayerId(newResolved.player_id);
          }

          localStorage.setItem(storageKey, newResolved.jukebox_slug);
          window.history.replaceState({}, '', `/${newResolved.jukebox_slug}`);
          return;
        }

        if (!cancelled) {
          setActivePlayerId(resolved.player_id);
        }

        localStorage.setItem(storageKey, resolved.jukebox_slug);
        if (pathSlug !== resolved.jukebox_slug) {
          window.history.replaceState({}, '', `/${resolved.jukebox_slug}`);
        }
      } catch (error) {
        console.error('Failed to resolve player jukebox identity:', error);
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

  return {
    activePlayerId,
    identityReady,
    playerId,
  };
}
