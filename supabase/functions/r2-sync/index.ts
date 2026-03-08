// R2 Sync Edge Function
// Syncs Cloudflare R2 bucket file list into the r2_files table
// Uses S3-compatible API (ListObjectsV2) to enumerate bucket contents

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

// S3-compatible request signing for Cloudflare R2
async function signS3Request(
  method: string,
  url: string,
  headers: Record<string, string>,
  accessKeyId: string,
  secretAccessKey: string,
  region: string,
): Promise<Record<string, string>> {
  const urlObj = new URL(url);
  const date = new Date();
  const dateStamp = date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const shortDate = dateStamp.slice(0, 8);

  // Create canonical request
  const signedHeaders = Object.keys(headers).sort().join(';').toLowerCase();
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map(k => `${k.toLowerCase()}:${headers[k].trim()}`)
    .join('\n') + '\n';

  // Build canonical query string: sort params, URI-encode keys and values per SigV4 spec
  const canonicalQueryString = Array.from(urlObj.searchParams.entries())
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const canonicalRequest = [
    method,
    urlObj.pathname,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  // Create string to sign
  const scope = `${shortDate}/${region}/s3/aws4_request`;
  const encoder = new TextEncoder();

  const canonicalHash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(canonicalRequest)))
  ).map(b => b.toString(16).padStart(2, '0')).join('');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    dateStamp,
    scope,
    canonicalHash,
  ].join('\n');

  // Calculate signature
  async function hmacSha256(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
    const cryptoKey = await crypto.subtle.importKey(
      'raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
  }

  const kDate = await hmacSha256(encoder.encode('AWS4' + secretAccessKey), shortDate);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, 's3');
  const kSigning = await hmacSha256(kService, 'aws4_request');
  const signature = Array.from(
    new Uint8Array(await hmacSha256(kSigning, stringToSign))
  ).map(b => b.toString(16).padStart(2, '0')).join('');

  return {
    ...headers,
    'Authorization': `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

interface R2Object {
  key: string;
  lastModified: string;
  etag: string;
  size: number;
}

// Parse ListObjectsV2 XML response — collects ALL objects (videos + images)
function parseListObjectsV2(xml: string): { objects: R2Object[]; isTruncated: boolean; nextToken?: string } {
  const objects: R2Object[] = [];
  const contentRegex = /<Contents>([\s\S]*?)<\/Contents>/g;
  let match;

  while ((match = contentRegex.exec(xml)) !== null) {
    const content = match[1];
    const key = content.match(/<Key>(.*?)<\/Key>/)?.[1] || '';
    const lastModified = content.match(/<LastModified>(.*?)<\/LastModified>/)?.[1] || '';
    const etag = content.match(/<ETag>"?(.*?)"?<\/ETag>/)?.[1] || '';
    const size = parseInt(content.match(/<Size>(.*?)<\/Size>/)?.[1] || '0', 10);

    if (key) {
      objects.push({ key, lastModified, etag, size });
    }
  }

  const isTruncated = xml.includes('<IsTruncated>true</IsTruncated>');
  const nextToken = xml.match(/<NextContinuationToken>(.*?)<\/NextContinuationToken>/)?.[1];

  return { objects, isTruncated, nextToken };
}

const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'ogg', 'mkv', 'mov', 'avi']);
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp']);

function getExtension(key: string): string {
  return (key.split('.').pop() || '').toLowerCase();
}

function isVideoFile(key: string): boolean {
  return VIDEO_EXTENSIONS.has(getExtension(key));
}

function isImageFile(key: string): boolean {
  return IMAGE_EXTENSIONS.has(getExtension(key));
}

/** Returns the object key without its file extension */
function baseName(key: string): string {
  return key.replace(/\.[^.]+$/, '');
}

/** Extract YouTube video ID (11-char alphanumeric with _ and -) from a filename */
function extractYouTubeIdFromKey(key: string): string | null {
  const fileName = key.split('/').pop() || key;
  const nameNoExt = fileName.replace(/\.[^.]+$/, '');
  // Match patterns like: "Title [ID]", "Title (ID)", "Title - ID", "Title_ID", or just "ID"
  const patterns = [
    /\[([A-Za-z0-9_-]{11})\]\s*$/,          // [dQw4w9WgXcQ]
    /\(([A-Za-z0-9_-]{11})\)\s*$/,          // (dQw4w9WgXcQ)
    /[-_\s]([A-Za-z0-9_-]{11})\s*$/,        // - dQw4w9WgXcQ or _dQw4w9WgXcQ
    /^([A-Za-z0-9_-]{11})$/,                // dQw4w9WgXcQ (filename IS the ID)
  ];
  for (const pattern of patterns) {
    const match = nameNoExt.match(pattern);
    if (match) return match[1];
  }
  return null;
}

/**
 * Build a comprehensive thumbnail lookup for video keys.
 *
 * Matching strategies (in priority order):
 * 1. Exact base name — "Artist - Song.mp4" ↔ "Artist - Song.jpg"
 * 2. Thumbs subfolder — "Music/Song.mp4" ↔ "Music/Thumbs/Song.jpg" (case-insensitive "Thumbs")
 * 3. YouTube video ID — "Song [dQw4w9WgXcQ].mp4" ↔ "dQw4w9WgXcQ.jpg" (anywhere in bucket)
 */
function buildThumbnailLookup(
  videoObjects: R2Object[],
  imageObjects: R2Object[],
  publicUrl: string,
): Map<string, string> {
  const result = new Map<string, string>();

  // Strategy 1: Exact base name map (images keyed by full base path)
  const exactMap = new Map<string, string>();
  for (const img of imageObjects) {
    exactMap.set(baseName(img.key), `${publicUrl}/${img.key}`);
  }

  // Strategy 2: Thumbs subfolder map
  // Build: parentDir (lowercase) → Map<fileBaseName (lowercase), url>
  const thumbsFolderMap = new Map<string, Map<string, string>>();
  for (const img of imageObjects) {
    const parts = img.key.split('/');
    if (parts.length >= 2) {
      const folderName = parts[parts.length - 2];
      if (folderName.toLowerCase() === 'thumbs' || folderName.toLowerCase() === 'thumb') {
        // Parent of the Thumbs folder
        const parentDir = parts.slice(0, -2).join('/').toLowerCase();
        const imgBaseName = (parts[parts.length - 1].replace(/\.[^.]+$/, '')).toLowerCase();
        if (!thumbsFolderMap.has(parentDir)) {
          thumbsFolderMap.set(parentDir, new Map());
        }
        thumbsFolderMap.get(parentDir)!.set(imgBaseName, `${publicUrl}/${img.key}`);
      }
    }
  }

  // Strategy 3: YouTube ID map (images keyed by extracted YT ID)
  const ytIdImageMap = new Map<string, string>();
  for (const img of imageObjects) {
    const ytId = extractYouTubeIdFromKey(img.key);
    if (ytId) {
      ytIdImageMap.set(ytId, `${publicUrl}/${img.key}`);
    }
  }

  // Now resolve each video
  for (const video of videoObjects) {
    // Priority 1: Exact base name match
    const exactMatch = exactMap.get(baseName(video.key));
    if (exactMatch) {
      result.set(video.key, exactMatch);
      continue;
    }

    // Priority 2: Thumbs subfolder match
    const videoParts = video.key.split('/');
    const videoDir = videoParts.slice(0, -1).join('/').toLowerCase();
    const videoBaseName = (videoParts[videoParts.length - 1].replace(/\.[^.]+$/, '')).toLowerCase();
    const thumbsFolder = thumbsFolderMap.get(videoDir);
    if (thumbsFolder) {
      const thumbMatch = thumbsFolder.get(videoBaseName);
      if (thumbMatch) {
        result.set(video.key, thumbMatch);
        continue;
      }
    }

    // Priority 3: YouTube ID match
    const videoYtId = extractYouTubeIdFromKey(video.key);
    if (videoYtId) {
      const ytMatch = ytIdImageMap.get(videoYtId);
      if (ytMatch) {
        result.set(video.key, ytMatch);
        continue;
      }
    }
  }

  return result;
}

function getContentType(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase();
  const mimeTypes: Record<string, string> = {
    mp4: 'video/mp4',
    webm: 'video/webm',
    ogg: 'video/ogg',
    mkv: 'video/x-matroska',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo',
  };
  return mimeTypes[ext || ''] || 'video/mp4';
}

function extractTitleFromFilename(filename: string): { title: string; artist: string | null } {
  // Remove extension
  let name = filename.replace(/\.[^.]+$/, '');
  // Replace underscores with spaces
  name = name.replace(/_/g, ' ');

  // Strip common noise patterns from filenames
  const noisePatterns = [
    // Parenthesized junk: (Karaoke), (Official Video), (Lyric Video), etc.
    /\s*\((?:karaoke|official\s*(?:video|music\s*video|audio|lyric\s*video)?|lyric\s*video|lyrics?|hd|4k|1080p|720p|480p|360p|hq|uhd|remastered|live|acoustic|remix|extended|short|full\s*version|with\s*lyrics?|video\s*clip|music\s*video|visuali[sz]er|animated|ft\.?[^)]*|feat\.?[^)]*)\)\s*/gi,
    // Bracketed junk: [Official Video], [HD], [Karaoke], etc.
    /\s*\[(?:karaoke|official\s*(?:video|music\s*video|audio|lyric\s*video)?|lyric\s*video|lyrics?|hd|4k|1080p|720p|480p|360p|hq|uhd|remastered|live|acoustic|remix|extended|short|full\s*version|with\s*lyrics?|video\s*clip|music\s*video|visuali[sz]er|animated|ft\.?[^[\]]*|feat\.?[^[\]]*)\]\s*/gi,
    // YouTube video ID patterns (11 chars at end after space/dash/underscore)
    /\s*[-_]?\s*[A-Za-z0-9_-]{11}$/,
    // Trailing resolution tags
    /\s+(?:hd|hq|4k|1080p|720p|480p|360p|uhd)\s*$/gi,
    // "- Topic" suffix
    /\s*-\s*Topic\s*$/i,
  ];

  for (const pattern of noisePatterns) {
    pattern.lastIndex = 0;
    name = name.replace(pattern, '');
  }

  // Clean up residual whitespace and trailing punctuation
  name = name.replace(/\s{2,}/g, ' ').trim();
  name = name.replace(/\s*[-–—]\s*$/, '').trim();

  // Try to extract "Artist - Title" pattern (first dash separator only)
  const dashMatch = name.match(/^(.+?)\s*-\s*(.+)$/);
  if (dashMatch) {
    return { artist: dashMatch[1].trim(), title: dashMatch[2].trim() };
  }

  return { title: name.trim(), artist: null };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const body = await req.json();
    const { action } = body;

    if (action === 'sync') {
      const accessKeyId = Deno.env.get('CLOUDFLARE_R2_ACCESS_KEY_ID');
      const secretAccessKey = Deno.env.get('CLOUDFLARE_R2_SECRET_ACCESS_KEY');
      const endpoint = Deno.env.get('CLOUDFLARE_R2_ENDPOINT') || 'https://7eb14b8d9e89951be03360c3fde3cb42.r2.cloudflarestorage.com';
      const bucketName = body.bucket_name || Deno.env.get('CLOUDFLARE_R2_BUCKET_NAME') || 'djamms-v1';
      const publicUrl = body.public_url || Deno.env.get('CLOUDFLARE_R2_PUBLIC_URL') || `${endpoint}/${bucketName}`;

      if (!accessKeyId || !secretAccessKey) {
        return new Response(JSON.stringify({
          error: 'Missing R2 credentials. Set CLOUDFLARE_R2_ACCESS_KEY_ID and CLOUDFLARE_R2_SECRET_ACCESS_KEY.',
        }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // List all objects in the bucket using S3 ListObjectsV2
      const allObjects: R2Object[] = [];
      let continuationToken: string | undefined;

      do {
        const params = new URLSearchParams({ 'list-type': '2', 'max-keys': '1000' });
        if (continuationToken) params.set('continuation-token', continuationToken);

        const listUrl = `${endpoint}/${bucketName}?${params.toString()}`;
        const date = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

        const baseHeaders: Record<string, string> = {
          'host': new URL(endpoint).host,
          'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
          'x-amz-date': date,
        };

        const signedHeaders = await signS3Request(
          'GET', listUrl, baseHeaders, accessKeyId, secretAccessKey, 'auto',
        );

        const response = await fetch(listUrl, { headers: signedHeaders });
        if (!response.ok) {
          const errText = await response.text();
          console.error('R2 ListObjectsV2 failed:', response.status, errText);
          return new Response(JSON.stringify({
            error: `R2 API error: ${response.status}`,
            details: errText,
          }), {
            status: 502,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const xml = await response.text();
        const parsed = parseListObjectsV2(xml);
        allObjects.push(...parsed.objects);
        continuationToken = parsed.isTruncated ? parsed.nextToken : undefined;
      } while (continuationToken);

      // Separate videos and images from all bucket objects
      const videoObjects = allObjects.filter(o => isVideoFile(o.key));
      const imageObjects = allObjects.filter(o => isImageFile(o.key));

      console.log(`Found ${videoObjects.length} video files and ${imageObjects.length} image files in R2 bucket '${bucketName}'`);

      // Build comprehensive thumbnail lookup using multiple matching strategies:
      // 1. Exact base name match (Artist - Song.mp4 ↔ Artist - Song.jpg)
      // 2. Thumbs subfolder match (Music/Song.mp4 ↔ Music/Thumbs/Song.jpg)
      // 3. YouTube video ID match (Song [dQw4w9WgXcQ].mp4 ↔ dQw4w9WgXcQ.jpg)
      const thumbnailMap = buildThumbnailLookup(videoObjects, imageObjects, publicUrl);

      // Fetch all existing records for this bucket in one query
      const { data: existingFiles } = await supabase
        .from('r2_files')
        .select('id, object_key, etag, thumbnail')
        .eq('bucket_name', bucketName);

      const existingMap = new Map<string, { id: string; etag: string; thumbnail: string | null }>();
      for (const f of existingFiles ?? []) {
        existingMap.set(f.object_key, { id: f.id, etag: f.etag, thumbnail: f.thumbnail });
      }

      const toInsert: object[] = [];
      const toUpdate: { id: string; patch: object }[] = [];
      const bucketKeys = new Set(videoObjects.map(o => o.key));

      for (const obj of videoObjects) {
        const fileName = obj.key.split('/').pop() || obj.key;
        const { title, artist } = extractTitleFromFilename(fileName);
        const filePublicUrl = `${publicUrl}/${obj.key}`;
        const thumbnailUrl = thumbnailMap.get(obj.key) || null;
        const existing = existingMap.get(obj.key);

        if (existing) {
          if (existing.etag !== obj.etag || existing.thumbnail !== thumbnailUrl) {
            toUpdate.push({ id: existing.id, patch: {
              etag: obj.etag,
              size_bytes: obj.size,
              last_modified: obj.lastModified,
              public_url: filePublicUrl,
              thumbnail: thumbnailUrl,
              synced_at: new Date().toISOString(),
            }});
          }
        } else {
          toInsert.push({
            bucket_name: bucketName,
            object_key: obj.key,
            file_name: fileName,
            content_type: getContentType(obj.key),
            size_bytes: obj.size,
            etag: obj.etag,
            last_modified: obj.lastModified,
            public_url: filePublicUrl,
            title,
            artist,
            thumbnail: thumbnailUrl,
          });
        }
      }

      // Batch insert new records (chunks of 500)
      const CHUNK = 500;
      for (let i = 0; i < toInsert.length; i += CHUNK) {
        await supabase.from('r2_files').insert(toInsert.slice(i, i + CHUNK));
      }

      // Batch updates — upsert by id
      for (let i = 0; i < toUpdate.length; i += CHUNK) {
        const chunk = toUpdate.slice(i, i + CHUNK);
        await supabase.from('r2_files').upsert(
          chunk.map(u => ({ id: u.id, ...u.patch }))
        );
      }

      // Delete rows no longer in bucket
      const toDelete = (existingFiles ?? []).filter(f => !bucketKeys.has(f.object_key));
      let deletedCount = 0;
      for (let i = 0; i < toDelete.length; i += CHUNK) {
        await supabase.from('r2_files').delete().in('id', toDelete.slice(i, i + CHUNK).map(f => f.id));
        deletedCount += toDelete.slice(i, i + CHUNK).length;
      }

      const addedCount = toInsert.length;
      const updatedCount = toUpdate.length;

      return new Response(JSON.stringify({
        success: true,
        bucket: bucketName,
        total_videos: videoObjects.length,
        total_images: imageObjects.length,
        matched_thumbnails: thumbnailMap.size,
        unmatched_videos: videoObjects.length - thumbnailMap.size,
        added: addedCount,
        updated: updatedCount,
        deleted: deletedCount,
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'list') {
      // List cached R2 files from the database
      const bucketName = body.bucket_name || Deno.env.get('CLOUDFLARE_R2_BUCKET_NAME') || 'djamms-v1';
      const { data, error } = await supabase
        .from('r2_files')
        .select('*')
        .eq('bucket_name', bucketName)
        .order('title', { ascending: true });

      if (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ files: data }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('R2 sync error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
