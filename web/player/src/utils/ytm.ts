// YTM Desktop Companion API utilities

export const YTM_BASE = 'http://localhost:9863';
export const YTM_APP_ID = 'obie-jukebox';

export function getYtmToken(): string | null {
  return localStorage.getItem('ytm_auth_token');
}

export function saveYtmToken(token: string): void {
  localStorage.setItem('ytm_auth_token', token);
}

export async function ytmFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getYtmToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = token;
  return fetch(`${YTM_BASE}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers as Record<string, string> ?? {}) },
  });
}
