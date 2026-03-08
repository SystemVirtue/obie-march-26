/**
 * Cleans a media title or artist string for display.
 *
 * R2 bucket filenames often contain noise like "(Karaoke)", "(Official Video)",
 * YouTube video IDs, resolution tags, etc. This function extracts just the
 * meaningful "Artist - Song" portion.
 *
 * Works on both title and artist fields — call separately for each.
 */

// Patterns to strip from titles (case-insensitive)
const NOISE_PATTERNS: RegExp[] = [
  // Parenthesized junk: (Karaoke), (Official Video), (Lyric Video), (HD), (4K), etc.
  /\s*\((?:karaoke|official\s*(?:video|music\s*video|audio|lyric\s*video)?|lyric\s*video|lyrics?|hd|4k|1080p|720p|480p|360p|hq|uhd|remastered|live|acoustic|remix|extended|short|full\s*version|with\s*lyrics?|video\s*clip|music\s*video|visuali[sz]er|animated|ft\.?[^)]*|feat\.?[^)]*)\)\s*/gi,
  // Bracketed junk: [Official Video], [HD], [Karaoke], [Lyrics], etc.
  /\s*\[(?:karaoke|official\s*(?:video|music\s*video|audio|lyric\s*video)?|lyric\s*video|lyrics?|hd|4k|1080p|720p|480p|360p|hq|uhd|remastered|live|acoustic|remix|extended|short|full\s*version|with\s*lyrics?|video\s*clip|music\s*video|visuali[sz]er|animated|ft\.?[^[\]]*|feat\.?[^[\]]*)\]\s*/gi,
  // YouTube video ID patterns (11 chars, typically at the end after a space/dash/underscore)
  /\s*[-_]?\s*[A-Za-z0-9_-]{11}$/,
  // Trailing resolution/format tags not in parens
  /\s+(?:hd|hq|4k|1080p|720p|480p|360p|uhd)\s*$/gi,
  // "- Topic" suffix from YouTube auto-generated channels
  /\s*-\s*Topic\s*$/i,
];

/**
 * Cleans a single display string (title or artist).
 * Strips noise patterns and trims whitespace.
 */
export function cleanDisplayText(text: string | null | undefined): string {
  if (!text) return '';
  let cleaned = text.trim();

  for (const pattern of NOISE_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    cleaned = cleaned.replace(pattern, '');
  }

  // Clean up any double spaces or trailing punctuation left behind
  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();
  cleaned = cleaned.replace(/\s*[-–—]\s*$/, '').trim();

  return cleaned;
}

/**
 * Parses a raw filename into clean { artist, title } for display.
 * Expects "Artist - Song Title (junk).ext" format.
 * If no " - " separator is found, returns the whole cleaned name as title.
 */
export function parseCleanTitle(raw: string | null | undefined): { title: string; artist: string } {
  if (!raw) return { title: '', artist: '' };

  // Remove file extension
  let name = raw.replace(/\.[^.]+$/, '');
  // Replace underscores with spaces
  name = name.replace(/_/g, ' ');

  // Try to split on first " - " to get Artist - Title
  const dashMatch = name.match(/^(.+?)\s*-\s*(.+)$/);
  if (dashMatch) {
    return {
      artist: cleanDisplayText(dashMatch[1]),
      title: cleanDisplayText(dashMatch[2]),
    };
  }

  return { title: cleanDisplayText(name), artist: '' };
}
