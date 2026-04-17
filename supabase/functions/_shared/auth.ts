// Shared auth validation for Edge Functions
//
// All edge functions call validateAuth() immediately after the OPTIONS preflight
// check.  This prevents unauthenticated internet callers from controlling
// playback, manipulating queues, or reading kiosk session data.
//
// Accepted tokens:
//   - SUPABASE_ANON_KEY  — sent by all three frontend apps (player, admin, kiosk)
//   - SUPABASE_SERVICE_ROLE_KEY — sent by server-to-server calls (r2-sync, crons)
//
// If neither matches, the request is rejected with 401.
import { corsHeaders } from './cors.ts';

export function validateAuth(req: Request): boolean {
  const authHeader = req.headers.get('Authorization') ?? '';
  const anonKey    = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

  // Must be a non-empty Bearer token matching one of our known keys.
  if (!authHeader.startsWith('Bearer ')) return false;
  const token = authHeader.slice('Bearer '.length);
  return token === anonKey || token === serviceKey;
}

export function unauthorizedResponse(): Response {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
