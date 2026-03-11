// Shared JSON response helpers for Edge Functions
import { corsHeaders } from './cors.ts';

const JSON_HEADERS = { ...corsHeaders, 'Content-Type': 'application/json' };

export function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

export function errorResponse(message: string, status = 400) {
  return new Response(JSON.stringify({ error: message }), { status, headers: JSON_HEADERS });
}
