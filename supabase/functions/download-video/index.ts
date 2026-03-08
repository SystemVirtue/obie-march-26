// Download Video Edge Function
// yt-dlp fallback for YouTube videos that cannot be embedded (errors 101 / 150).
//
// ⚠️  DEPLOYMENT NOTE: This function uses Deno.Command to shell out to yt-dlp.
//    Hosted Supabase Edge Functions run in a sandboxed Deno environment where
//    Deno.Command is not available.  Deploy this to a self-hosted Supabase
//    instance or a custom Docker image that has yt-dlp in PATH.
//
// Expected request body (POST):
//   { videoId: string, player_id?: string }
//
// On success, player_status is updated with:
//   { source: 'local', local_url: <publicUrl>, state: 'playing' }
// The Player app's realtime subscription fires and switches to the <video> element.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

const DEFAULT_PLAYER_ID = '00000000-0000-0000-0000-000000000001';

// Validate an 11-character YouTube video ID
const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

// ── Logging helpers ────────────────────────────────────────────────────────────
function makeLogger(videoId: string) {
  const pfx = `[download-video][${videoId}]`;
  const t0 = performance.now();
  const elapsed = () => `+${((performance.now() - t0) / 1000).toFixed(2)}s`;
  return {
    info:  (...a: unknown[]) => console.log(pfx, elapsed(), ...a),
    warn:  (...a: unknown[]) => console.warn(pfx, elapsed(), '⚠', ...a),
    error: (...a: unknown[]) => console.error(pfx, elapsed(), '✖', ...a),
    mark:  (label: string)   => { const t = performance.now(); return () => ((performance.now() - t) / 1000).toFixed(2) + 's'; },
    elapsed,
    pfx,
  };
}

// ── Human-readable byte size ────────────────────────────────────────────────────
function fmtBytes(n: number): string {
  if (n < 1024)       return `${n} B`;
  if (n < 1024 ** 2)  return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3)  return `${(n / 1024 ** 2).toFixed(2)} MB`;
  return `${(n / 1024 ** 3).toFixed(3)} GB`;
}

Deno.serve(async (req: Request): Promise<Response> => {
  // ── CORS preflight ──────────────────────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  let tmpFile: string | null = null;

  try {
    // ── Env vars ──────────────────────────────────────────────────────────────
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !serviceKey) {
      console.error('[download-video] Misconfiguration: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');
      return new Response(
        JSON.stringify({ error: 'Server misconfiguration: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── Parse body ────────────────────────────────────────────────────────────
    const body = await req.json() as { videoId?: string; player_id?: string };
    const { videoId, player_id = DEFAULT_PLAYER_ID } = body;

    if (!videoId || !YOUTUBE_ID_RE.test(videoId)) {
      console.error('[download-video] Invalid videoId:', videoId);
      return new Response(
        JSON.stringify({ error: 'videoId is required and must be a valid 11-character YouTube ID' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const log = makeLogger(videoId);
    const supabase = createClient(supabaseUrl, serviceKey);

    log.info('══ REQUEST ══════════════════════════════════════════');
    log.info(`videoId=${videoId}  player_id=${player_id}`);
    log.info(`supabaseUrl=${supabaseUrl}`);

    // ── Signal "loading" to the Player immediately ────────────────────────────
    log.info('Setting player_status → loading...');
    const { error: loadingErr } = await supabase
      .from('player_status')
      .update({ state: 'loading', last_updated: new Date().toISOString() })
      .eq('player_id', player_id);

    if (loadingErr) {
      log.warn('Failed to set loading state:', loadingErr.message, '(continuing)');
    } else {
      log.info('player_status.state = loading  ✓');
    }

    // ── Run yt-dlp ────────────────────────────────────────────────────────────
    tmpFile = `/tmp/${videoId}-${Date.now()}.mp4`;
    const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;

    const ytdlpArgs = [
      '--format',              'bestvideo[height<=480]+bestaudio/best',
      '--merge-output-format', 'mp4',
      '--output',              tmpFile,
      '--no-playlist',
      '--newline',             // one progress line per stdout flush — parseable
      '--progress',
      ytUrl,
    ];

    log.info('══ YT-DLP ════════════════════════════════════════════');
    log.info(`cmd: yt-dlp ${ytdlpArgs.join(' ')}`);
    log.info(`output file: ${tmpFile}`);

    const dlTimer = log.mark('yt-dlp');
    const ytdlpProc = new Deno.Command('yt-dlp', {
      args: ytdlpArgs,
      stdout: 'piped',
      stderr: 'piped',
    });

    const { code, stdout, stderr } = await ytdlpProc.output();
    const dlDuration = dlTimer();

    const stdoutText = new TextDecoder().decode(stdout).trim();
    const stderrText = new TextDecoder().decode(stderr).trim();

    log.info(`yt-dlp exit code: ${code}  (took ${dlDuration})`);

    if (stdoutText) {
      // Log last 20 lines of progress output to avoid flooding logs
      const lines = stdoutText.split('\n');
      const tail  = lines.slice(-20).join('\n');
      log.info(`yt-dlp stdout (last ${Math.min(lines.length, 20)} of ${lines.length} lines):\n${tail}`);
    }

    if (stderrText) {
      const logFn = code === 0 ? log.info : log.error;
      logFn(`yt-dlp stderr:\n${stderrText.slice(0, 1200)}`);
    }

    if (code !== 0) {
      throw new Error(`yt-dlp exited with code ${code}: ${stderrText.slice(0, 400)}`);
    }

    // ── File stat ─────────────────────────────────────────────────────────────
    let fileSizeBytes = 0;
    try {
      const stat = await Deno.stat(tmpFile);
      fileSizeBytes = stat.size;
      log.info(`Downloaded file size: ${fmtBytes(fileSizeBytes)}`);
    } catch (statErr) {
      log.warn('Could not stat temp file:', statErr);
    }

    // ── Read file ─────────────────────────────────────────────────────────────
    log.info('══ STORAGE ═══════════════════════════════════════════');
    log.info('Reading file into memory...');
    const readTimer = log.mark('read');
    const fileData  = await Deno.readFile(tmpFile);
    log.info(`File read: ${fmtBytes(fileData.byteLength)} (took ${readTimer()})`);

    const storageName = `${videoId}-${Date.now()}.mp4`;
    log.info(`Uploading to bucket='downloads'  path='${storageName}'  size=${fmtBytes(fileData.byteLength)}`);

    // ── Upload to Storage ─────────────────────────────────────────────────────
    const uploadTimer = log.mark('upload');
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('downloads')
      .upload(storageName, fileData, { contentType: 'video/mp4', upsert: true });
    const uploadDuration = uploadTimer();

    // Clean up temp file right after reading — regardless of upload result
    await Deno.remove(tmpFile).catch((e) =>
      log.warn('Failed to remove temp file:', e),
    );
    tmpFile = null;
    log.info('Temp file cleaned up');

    if (uploadError) {
      log.error(`Storage upload FAILED (took ${uploadDuration}):`, uploadError.message);
      throw uploadError;
    }

    log.info(`Storage upload OK  (took ${uploadDuration})`);
    log.info(`Storage path: ${uploadData?.path ?? storageName}`);
    log.info(`Storage fullPath: ${(uploadData as any)?.fullPath ?? '(unavailable)'}`);

    // ── Get public URL ────────────────────────────────────────────────────────
    const { data: { publicUrl } } = supabase.storage
      .from('downloads')
      .getPublicUrl(storageName);

    log.info(`Public URL: ${publicUrl}`);

    // ── Update player_status: switch to local source ──────────────────────────
    log.info('══ PLAYER STATUS ══════════════════════════════════════');
    log.info(`Updating player_status for player_id=${player_id}:`);
    log.info(`  source=local  state=playing  local_url=${publicUrl}`);

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
    log.info(`══ DONE  total=${log.elapsed()} ═══════════════════════════`);

    return new Response(
      JSON.stringify({ success: true, publicUrl, fileSizeBytes, storageName }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[download-video] ✖ Unhandled error:', msg);

    // Best-effort cleanup of temp file on error
    if (tmpFile) {
      await Deno.remove(tmpFile).catch(() => { /* ignore */ });
    }

    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
