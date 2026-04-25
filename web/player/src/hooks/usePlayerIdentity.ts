import { useEffect, useState } from 'react';
import { resolveJukeboxSlug } from '@shared/supabase-client';
import { getPathJukeboxSlug, normalizeJukeboxSlug } from '@shared/jukebox-utils';

type UsePlayerIdentityArgs = {
  defaultPlayerId: string;
};

export function usePlayerIdentity({ defaultPlayerId: _defaultPlayerId }: UsePlayerIdentityArgs) {
  const [activePlayerId, setActivePlayerId] = useState<string | null>(null);
  const [activeJukeboxSlug, setActiveJukeboxSlug] = useState<string | null>(null);
  const [identityReady, setIdentityReady] = useState(false);

  const playerId = activePlayerId || null;

  useEffect(() => {
    let cancelled = false;

    const resolveIdentity = async () => {
      try {
        const pathSlug = getPathJukeboxSlug();
        if (!pathSlug) {
          if (!cancelled) {
            setActivePlayerId(null);
            setActiveJukeboxSlug(null);
          }
          return;
        }

        const resolved = await resolveJukeboxSlug(pathSlug);
        if (!resolved) {
          alert(`Jukebox "${pathSlug}" was not found.`);
          if (!cancelled) {
            setActivePlayerId(null);
            setActiveJukeboxSlug(null);
          }
          return;
        }

        if (!cancelled) {
          setActivePlayerId(resolved.player_id);
          setActiveJukeboxSlug(resolved.jukebox_slug);
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
    const handlePopState = () => {
      resolveIdentity();
    };
    window.addEventListener('popstate', handlePopState);
    return () => {
      cancelled = true;
      window.removeEventListener('popstate', handlePopState);
    };
  }, []);

  const navigateToJukebox = (rawSlug: string) => {
    const slug = normalizeJukeboxSlug(rawSlug);
    if (!slug) return;
    if (slug === activeJukeboxSlug) return;
    window.history.pushState({}, '', `/${slug}`);
    setIdentityReady(false);
    setActivePlayerId(null);
    setActiveJukeboxSlug(null);
    // Trigger resolver via popstate-compatible path.
    window.dispatchEvent(new PopStateEvent('popstate'));
  };

  return {
    activePlayerId,
    activeJukeboxSlug,
    identityReady,
    playerId,
    navigateToJukebox,
  };
}
