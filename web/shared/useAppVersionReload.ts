import { useEffect } from 'react';
import { subscribeToAppVersion } from './supabase-client';

/**
 * Hook that listens for app version changes via Supabase Realtime.
 * When a new version is detected, reloads the page after a short delay.
 *
 * @param delayMs - Delay before reload (default 2000ms). Use longer delays
 *   for the Player to avoid interrupting active playback mid-transition.
 */
export function useAppVersionReload(delayMs = 2000) {
  useEffect(() => {
    const sub = subscribeToAppVersion((newVersion) => {
      console.log(`[AppVersion] New version detected (${newVersion}), reloading in ${delayMs}ms...`);
      setTimeout(() => {
        window.location.reload();
      }, delayMs);
    });

    return () => sub.unsubscribe();
  }, [delayMs]);
}
