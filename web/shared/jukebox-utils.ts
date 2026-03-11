// Shared jukebox slug utilities
// Used by admin, player, and kiosk apps

/**
 * Normalize a raw slug string into a canonical jukebox slug format.
 * Uppercased, underscores for spaces, alphanumeric + underscore + hyphen only.
 */
export function normalizeJukeboxSlug(raw: string | null | undefined): string {
  return (raw || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_')
    .replace(/[^A-Z0-9_-]/g, '')
    .replace(/_+/g, '_')
    .replace(/-+/g, '-')
    .replace(/^[_-]+|[_-]+$/g, '');
}

/**
 * Extract the jukebox slug from the first path segment of the current URL.
 */
export function getPathJukeboxSlug(): string {
  const firstPathPart = window.location.pathname.split('/').filter(Boolean)[0] || '';
  return normalizeJukeboxSlug(firstPathPart);
}
