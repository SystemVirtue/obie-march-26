import { useEffect, useState } from 'react';
import { resolveJukeboxSlug } from '@shared/supabase-client';
import { getPathJukeboxSlug } from '@shared/jukebox-utils';

type UsePlayerIdentityArgs = {
  defaultPlayerId: string;
};

export function usePlayerIdentity({ defaultPlayerId }: UsePlayerIdentityArgs) {
  const [activePlayerId, setActivePlayerId] = useState<string | null>(null);
  const [identityReady, setIdentityReady] = useState(false);

  const playerId = activePlayerId || defaultPlayerId;

  useEffect(() => {
    let cancelled = false;

    const resolveIdentity = async () => {
      try {
        const pathSlug = getPathJukeboxSlug();
        let candidateSlug = pathSlug;

        if (!candidateSlug) {
          return;
        }

        const resolved = await resolveJukeboxSlug(candidateSlug);
        if (!resolved) {
          alert(`Jukebox "${candidateSlug}" was not found.`);
          return;
        }

        if (!cancelled) {
          setActivePlayerId(resolved.player_id);
        }

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
  }, []);

  return {
    activePlayerId,
    identityReady,
    playerId,
  };
}
