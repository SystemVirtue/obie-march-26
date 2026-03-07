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

  const canonicalRequest = [
    method,
    urlObj.pathname,
    urlObj.search.replace('?', ''),
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

// Parse ListObjectsV2 XML response
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

    // Only include video files
    if (key && (key.endsWith('.mp4') || key.endsWith('.webm') || key.endsWith('.ogg') ||
        key.endsWith('.mkv') || key.endsWith('.mov') || key.endsWith('.avi'))) {
      objects.push({ key, lastModified, etag, size });
    }
  }

  const isTruncated = xml.includes('<IsTruncated>true</IsTruncated>');
  const nextToken = xml.match(/<NextContinuationToken>(.*?)<\/NextContinuationToken>/)?.[1];

  return { objects, isTruncated, nextToken };
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

      console.log(`Found ${allObjects.length} video files in R2 bucket '${bucketName}'`);

      // Upsert into r2_files
      let addedCount = 0;
      let updatedCount = 0;

      for (const obj of allObjects) {
        const fileName = obj.key.split('/').pop() || obj.key;
        const { title, artist } = extractTitleFromFilename(fileName);
        const filePublicUrl = `${publicUrl}/${obj.key}`;

        const { data: existing } = await supabase
          .from('r2_files')
          .select('id, etag')
          .eq('bucket_name', bucketName)
          .eq('object_key', obj.key)
          .single();

        if (existing) {
          if (existing.etag !== obj.etag) {
            await supabase.from('r2_files').update({
              etag: obj.etag,
              size_bytes: obj.size,
              last_modified: obj.lastModified,
              public_url: filePublicUrl,
              synced_at: new Date().toISOString(),
            }).eq('id', existing.id);
            updatedCount++;
          }
        } else {
          await supabase.from('r2_files').insert({
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
          });
          addedCount++;
        }
      }

      // Delete r2_files rows that no longer exist in the bucket
      const bucketKeys = allObjects.map(o => o.key);
      const { data: existingFiles } = await supabase
        .from('r2_files')
        .select('id, object_key')
        .eq('bucket_name', bucketName);

      let deletedCount = 0;
      if (existingFiles) {
        const toDelete = existingFiles.filter(f => !bucketKeys.includes(f.object_key));
        if (toDelete.length > 0) {
          await supabase.from('r2_files').delete().in('id', toDelete.map(f => f.id));
          deletedCount = toDelete.length;
        }
      }

      return new Response(JSON.stringify({
        success: true,
        bucket: bucketName,
        total_files: allObjects.length,
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
