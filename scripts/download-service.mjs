#!/usr/bin/env node
/**
 * download-service.mjs
 *
 * Local companion service for the Obie Player.
 * Runs yt-dlp on this machine (no Supabase sandbox restrictions),
 * uploads the result to Supabase Storage, and flips player_status to
 * source='local' so the Player's Realtime subscription switches from
 * the YouTube iframe to a native <video> element.
 *
 * Prerequisites:
 *   yt-dlp   in PATH  (brew install yt-dlp  |  pip install yt-dlp)
 *   ffmpeg   in PATH  (brew install ffmpeg)
 *
 * Usage:
 *   node scripts/download-service.mjs
 *
 * Env vars (auto-loaded from .env at repo root, then web/player/.env):
 *   VITE_SUPABASE_URL         — project URL
 *   VITE_SUPABASE_SERVICE_KEY — service role JWT
 *   DOWNLOAD_SERVICE_PORT     — override default port 3742 (optional)
 */

import http      from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, unlinkSync, statSync } from 'node:fs';
import { tmpdir }                              from 'node:os';
import { join, dirname }                       from 'node:path';
import { fileURLToPath }                       from 'node:url';

// ── Bootstrap env vars ───────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot  = join(__dirname, '..');

/** Minimal .env parser — does not override existing shell variables */
function parseEnvFile(filepath) {
  try {
    const lines = readFileSync(filepath, 'utf8').split('\n');
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      const key = t.slice(0, eq).trim();
      let   val = t.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch { /* file absent — rely on shell env */ }
}

parseEnvFile(join(repoRoot, '.env'));
parseEnvFile(join(repoRoot, 'web', 'player', '.env'));

// ── Config ───────────────────────────────────────────────────────────────────
const PORT           = parseInt(process.env.DOWNLOAD_SERVICE_PORT ?? '3742', 10);
const SUPABASE_URL   = process.env.VITE_SUPABASE_URL ?? '';
const SERVICE_KEY    = process.env.VITE_SUPABASE_SERVICE_ROLE_KEY
                    ?? process.env.VITE_SUPABASE_SERVICE_KEY
                    ?? process.env.SUPABASE_SERVICE_ROLE_KEY
                    ?? '';
const DEFAULT_PLAYER = '00000000-0000-0000-0000-000000000001';
const YOUTUBE_ID_RE  = /^[A-Za-z0-9_-]{11}$/;
const BUCKET         = 'downloads';

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('[download-service] ✖ Missing required env vars.');
  console.error('[download-service]   Set VITE_SUPABASE_URL + VITE_SUPABASE_SERVICE_KEY in .env or shell.');
  process.exit(1);
}

// ── Supabase client ──────────────────────────────────────────────────────────
const { createClient } = await import('@supabase/supabase-js');
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

// ── Logging + helpers ────────────────────────────────────────────────────────
function fmtBytes(n) {
  if (n < 1024)        return `${n} B`;
  if (n < 1024 ** 2)   return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3)   return `${(n / 1024 ** 2).toFixed(2)} MB`;
  return `${(n / 1024 ** 3).toFixed(3)} GB`;
}

function makeLogger(videoId) {
  const pfx = `[download-service][${videoId}]`;
  const t0   = performance.now();
  const el   = () => `+${((performance.now() - t0) / 1000).toFixed(2)}s`;
  const mark = () => { const ts = performance.now(); return () => ((performance.now() - ts) / 1000).toFixed(2) + 's'; };
  return {
    info:  (...a) => console.log(pfx, el(), ...a),
    warn:  (...a) => console.warn(pfx, el(), '⚠', ...a),
    error: (...a) => console.error(pfx, el(), '✖', ...a),
    el, mark,
  };
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

function sendJson(res, status, body) {
  res.writeHead(status, { ...CORS, 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data',  c => { buf += c; });
    req.on('end',   () => { try { resolve(JSON.parse(buf || '{}')); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

/** Spawn yt-dlp and stream its output to console in real time */
function runYtdlp(videoId, outFile, log) {
  return new Promise((resolve, reject) => {
    const args = [
      '--format',              'bestvideo[height<=480]+bestaudio/best',
      '--merge-output-format', 'mp4',
      '--output',              outFile,
      '--no-playlist',
      '--newline',
      '--progress',
      `https://www.youtube.com/watch?v=${videoId}`,
    ];

    log.info('══ YT-DLP ═════════════════════════════════════════════');
    log.info(`cmd: yt-dlp ${args.join(' ')}`);
    log.info(`output: ${outFile}`);

    const proc = spawn('yt-dlp', args);
    const stderrChunks = [];

    proc.stdout.on('data', data => {
      for (const line of data.toString().split('\n')) {
        const t = line.trim();
        if (t) log.info(t);
      }
    });

    proc.stderr.on('data', data => {
      stderrChunks.push(data.toString());
      for (const line of data.toString().split('\n')) {
        const t = line.trim();
        if (t) log.warn(t);
      }
    });

    proc.on('error', err => reject(new Error(`yt-dlp not found or failed to start: ${err.message}\nIs yt-dlp in PATH?`)));

    proc.on('close', code => {
      log.info(`yt-dlp exit code: ${code}`);
      if (code === 0) {
        resolve();
      } else {
        const stderrText = stderrChunks.join('').slice(0, 600);
        reject(new Error(`yt-dlp exited with code ${code}:\n${stderrText}`));
      }
    });
  });
}

// ── In-flight dedup guard ────────────────────────────────────────────────────
const inFlight = new Set();

// ── /download handler ────────────────────────────────────────────────────────
async function handleDownload(req, res) {
  let body;
  try   { body = await readBody(req); }
  catch { sendJson(res, 400, { error: 'Invalid request body — expected JSON' }); return; }

  const { videoId, player_id = DEFAULT_PLAYER } = body ?? {};

  if (!videoId || !YOUTUBE_ID_RE.test(videoId)) {
    sendJson(res, 400, { error: 'videoId must be a valid 11-character YouTube ID' });
    return;
  }

  if (inFlight.has(videoId)) {
    console.log(`[download-service] ${videoId}: already in flight — returning 409`);
    sendJson(res, 409, { error: `Download already in progress for ${videoId}` });
    return;
  }

  const log = makeLogger(videoId);
  inFlight.add(videoId);

  log.info('══ REQUEST ════════════════════════════════════════════');
  log.info(`videoId=${videoId}  player_id=${player_id}`);

  // Signal 'loading' to the Player immediately so the UI can show a spinner
  const { error: loadingErr } = await supabase
    .from('player_status')
    .update({ state: 'loading', last_updated: new Date().toISOString() })
    .eq('player_id', player_id);

  if (loadingErr) {
    log.warn('Failed to set loading state:', loadingErr.message, '(continuing)');
  } else {
    log.info('player_status.state = loading  ✓');
  }

  const tmpFile = join(tmpdir(), `obie-${videoId}-${Date.now()}.mp4`);
  let   fileSizeBytes = 0;

  try {
    // ── yt-dlp ───────────────────────────────────────────────────────────────
    const dlTimer = log.mark();
    await runYtdlp(videoId, tmpFile, log);
    log.info(`yt-dlp download complete  took=${dlTimer()}`);

    // ── File stat ─────────────────────────────────────────────────────────────
    try {
      fileSizeBytes = statSync(tmpFile).size;
      log.info(`Downloaded file size: ${fmtBytes(fileSizeBytes)}`);
    } catch (e) {
      log.warn('Could not stat temp file:', e.message);
    }

    // ── Read + upload to Supabase Storage ────────────────────────────────────
    log.info('══ STORAGE ════════════════════════════════════════════');
    const readTimer = log.mark();
    const fileData  = readFileSync(tmpFile);
    log.info(`File read: ${fmtBytes(fileData.byteLength)}  took=${readTimer()}`);

    const storageName = `${videoId}-${Date.now()}.mp4`;
    log.info(`Uploading  bucket='${BUCKET}'  path='${storageName}'  size=${fmtBytes(fileData.byteLength)}`);

    const uploadTimer = log.mark();
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(storageName, fileData, { contentType: 'video/mp4', upsert: true });

    // Clean up tmp file immediately — regardless of upload success
    try { unlinkSync(tmpFile); log.info('Temp file cleaned up'); }
    catch (e) { log.warn('Failed to remove temp file:', e.message); }

    if (uploadError) {
      log.error(`Storage upload FAILED  took=${uploadTimer()}:`, uploadError.message);
      throw uploadError;
    }

    log.info(`Storage upload OK  took=${uploadTimer()}`);
    log.info(`Storage path: ${uploadData?.path ?? storageName}`);

    // ── Public URL ────────────────────────────────────────────────────────────
    const { data: { publicUrl } } = supabase.storage.from(BUCKET).getPublicUrl(storageName);
    log.info(`Public URL: ${publicUrl}`);

    // ── Update player_status → source='local' ────────────────────────────────
    log.info('══ PLAYER STATUS ══════════════════════════════════════');
    log.info(`source=local  state=playing  local_url=${publicUrl}`);

    const { error: updateError } = await supabase
      .from('player_status')
      .update({
        source:       'local',
        local_url:    publicUrl,
        state:        'playing',
        last_updated: new Date().toISOString(),
      })
      .eq('player_id', player_id);

    if (updateError) {
      log.error('player_status update FAILED:', updateError.message);
      throw updateError;
    }

    log.info('player_status updated  ✓  — Realtime will fire to Player client');
    log.info(`══ DONE  total=${log.el()} ═══════════════════════════════`);

    sendJson(res, 200, { success: true, publicUrl, fileSizeBytes, storageName });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Unhandled error:', msg);
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
    sendJson(res, 500, { error: msg });
  } finally {
    inFlight.delete(videoId);
  }
}

// ── HTTP server ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  // Health / status
  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, { ok: true, inFlight: [...inFlight], supabaseUrl: SUPABASE_URL, bucket: BUCKET });
    return;
  }

  // Download
  if (req.method === 'POST' && req.url === '/download') {
    await handleDownload(req, res);
    return;
  }

  sendJson(res, 404, { error: 'Not found. Use POST /download { videoId, player_id? }' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n[download-service] ✓ Listening on http://127.0.0.1:${PORT}`);
  console.log(`[download-service]   Supabase: ${SUPABASE_URL}`);
  console.log(`[download-service]   Bucket:   ${BUCKET}`);
  console.log(`[download-service]   Ready — POST /download { videoId, player_id? }\n`);
});

server.on('error', err => {
  console.error('[download-service] ✖ Server error:', err.message);
  process.exit(1);
});
