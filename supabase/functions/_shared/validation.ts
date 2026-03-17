const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateUUID(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function validateRequired(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  return value !== null && value !== undefined;
}

export function validateYouTubeUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const parsed = new URL(value);
    const allowedHosts = new Set([
      'www.youtube.com',
      'youtube.com',
      'youtu.be',
      'music.youtube.com',
    ]);
    return allowedHosts.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}
