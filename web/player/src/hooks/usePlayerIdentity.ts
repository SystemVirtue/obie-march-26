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
          // No local Player ID - create a new Player in Supabase
          const { data: newPlayer, error: createError } = await supabase
            .from('players')
            .insert({
              name: `Player_${Date.now()}`,
              status: 'online',
              jukebox_slug: `PLAYER_${Date.now().toString(36).toUpperCase()}`,
            })
            .select()
            .single();

          if (createError || !newPlayer) {
            console.error('Failed to create new player:', createError);
            // Fallback to prompt
            const entered = window.prompt('Enter Jukebox Name (e.g. OBIE):');
            candidateSlug = normalizeJukeboxSlug(entered);
          } else {
            candidateSlug = newPlayer.jukebox_slug;
            console.log('[PlayerIdentity] Created new player:', newPlayer.id, candidateSlug);
          }
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
