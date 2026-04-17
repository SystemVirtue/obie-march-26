// Shared auth validation for Edge Functions
//
// All edge functions call validateAuth() immediately after the OPTIONS preflight
// check.  This prevents unauthenticated internet callers from controlling
// playback, manipulating queues, or reading kiosk session data.
//
// Two distinct calling patterns exist in this project:
//
//   1. supabase.functions.invoke() — used by the admin frontend (web/admin/src/lib/supabaseClient.ts)
//      Sends: apikey: <anon-key>  +  Authorization: Bearer <user-session-JWT>
//      The user-session JWT is project-signed and valid, but is NOT the anon key,
//      so matching only on the Bearer token would reject all logged-in admin requests.
//
//   2. Manual fetch() — used by player and kiosk (web/shared/supabase-client.ts invokeEdgeFunction)
//      Sends: apikey: <anon-key>  +  Authorization: Bearer <anon-key>
//
//   3. Server-to-server — r2-sync, crons
//      Sends: Authorization: Bearer <service-role-key>
//
// Strategy: accept the request if EITHER:
//   a) The `apikey` header equals the project anon key  (covers patterns 1 + 2)
//   b) The `Authorization` Bearer token equals the service role key  (pattern 3)
//
// This correctly rejects requests with no project key at all (e.g. raw curl
// without the apikey header) while accepting all legitimate frontend callers.
import { corsHeaders } from './cors.ts';

export function validateAuth(req: Request): boolean {
  const anonKey    = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

  // Pattern 1 & 2: any call that carries our project anon key in the apikey header.
  // This covers both supabase.functions.invoke() (admin) and manual fetch (player/kiosk).
  const apiKey = req.headers.get('apikey') ?? '';
  const authHeader = req.headers.get('Authorization') ?? '';

  // DEBUG: log what we received (remove after diagnosis)
  console.log('[validateAuth] apikey present:', !!apiKey, 'apikey matches:', anonKey ? apiKey === anonKey : 'no-anonKey');
  console.log('[validateAuth] auth header prefix:', authHeader.slice(0, 20), 'anonKey set:', !!anonKey, 'serviceKey set:', !!serviceKey);

  if (anonKey && apiKey === anonKey) return true;

  // Pattern 3: server-to-server with service role Bearer token.
  if (serviceKey && authHeader === `Bearer ${serviceKey}`) return true;

  // Also accept anon key as a Bearer token (belt-and-suspenders for the manual fetch path).
  if (anonKey && authHeader === `Bearer ${anonKey}`) return true;

  return false;
}

export function unauthorizedResponse(): Response {
  return new Response(JSON.stringify({ error: 'Unauthorized' }), {
    status: 401,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
