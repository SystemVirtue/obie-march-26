import { useEffect, useState } from 'react';
import { resolveJukeboxSlug } from '@shared/supabase-client';
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
