// Shared YouTube scraper caller with JWT fallback for inter-function calls

function isLikelyJwt(token: string | null | undefined): token is string {
  if (!token) return false;
  return token.split('.').length === 3;
}

/**
 * Call the youtube-scraper edge function with auth fallback.
 * Tries the incoming Authorization header, then the service role key,
 * then the anon key, and finally no auth (for verify_jwt=false functions).
 */
export async function callYouTubeScraperWithFallback(params: {
  supabaseUrl: string;
  payload: Record<string, unknown>;
  incomingAuthorization: string | null;
  serviceRoleToken: string | null;
  anonJwt: string | null;
}): Promise<Response> {
  const { supabaseUrl, payload, incomingAuthorization, serviceRoleToken, anonJwt } = params;
  const endpoint = `${supabaseUrl}/functions/v1/youtube-scraper`;

  const authCandidates: (string | null)[] = [
    incomingAuthorization,
    isLikelyJwt(serviceRoleToken) ? `Bearer ${serviceRoleToken}` : null,
    isLikelyJwt(anonJwt) ? `Bearer ${anonJwt}` : null,
  ];

  const uniqueCandidates = Array.from(new Set(authCandidates.filter((v): v is string => Boolean(v))));
  // Final fallback with no Authorization header (verify_jwt=false functions)
  uniqueCandidates.push('');

  let lastResponse: Response | null = null;
  for (const authHeader of uniqueCandidates) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (anonJwt) headers['apikey'] = anonJwt;
    if (authHeader) headers['Authorization'] = authHeader;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (response.status !== 401) {
      return response;
    }

    lastResponse = response;
  }

  return lastResponse ?? new Response(JSON.stringify({ error: 'youtube-scraper auth failed' }), { status: 401 });
}
