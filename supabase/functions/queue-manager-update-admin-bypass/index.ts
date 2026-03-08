import { decode } from "https://deno.land/std@0.170.0/encoding/base64.ts";
Deno.serve(async (req: Request) => {
  try {
    const { method } = req;
    if (method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });

    const body = await req.json().catch(() => null);
    if (!body) return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });

    const { player_id, action, queue_id } = body;
    if (!player_id || !action) return new Response(JSON.stringify({ error: 'Missing fields' }), { status: 400 });

    // Helper: parse JWT payload without verification (we only read claims)
    const parseJwt = (token = '') => {
      try {
        const parts = token.split('.');
        if (parts.length < 2) return null;
        const payload = parts[1];
        // Add padding
        const pad = payload.length % 4;
        const padded = payload + (pad ? '='.repeat(4 - pad) : '');
        const decoded = new TextDecoder().decode(decode(padded));
        return JSON.parse(decoded);
      } catch (e) {
        return null;
      }
    };

    const authHeader = req.headers.get('authorization') || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    const claims = parseJwt(token) || {};
    const isAdmin = (claims.role === 'admin');

    // Also allow service role bypass if the raw Authorization header exactly matches the service role
    const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const usingServiceRole = serviceRole && authHeader === `Bearer ${serviceRole}`;

    // If not admin or service role, enforce online check
    if (!isAdmin && !usingServiceRole) {
      // Query player status from the DB using Supabase REST? Instead, attempt to read from internal API if available.
      // For safety in this example, return an instruction for existing flow.
      return new Response(JSON.stringify({ error: 'Not authorized to bypass offline check' }), { status: 403 });
    }

    // Proceed with remove/reorder action bypassing online check
    if (action === 'remove') {
      // Implement your removal logic here — for example publish to realtime or call database
      // Placeholder: return success with intent
      return new Response(JSON.stringify({ ok: true, message: 'Remove executed bypassing online check', player_id, queue_id }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (action === 'reorder') {
      return new Response(JSON.stringify({ ok: true, message: 'Reorder executed bypassing online check', player_id, queue_id }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400 });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: 'Internal error' }), { status: 500 });
  }
});