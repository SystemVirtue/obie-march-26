// Shared error logging helpers for edge functions
// Centralized persistent error logging to system_logs table

export interface SystemLogEntry {
  player_id?: string;
  event: string;
  severity: 'debug' | 'info' | 'warn' | 'error';
  payload?: Record<string, any>;
  source?: 'edge' | 'client' | 'kiosk' | 'system';
  request_id?: string;
  user_id?: string;
  kiosk_session_id?: string;
}

/**
 * Log an error persistently to system_logs table
 * Called from Edge Functions to create audit trail
 */
export async function logEdgeError(
  supabase: any,
  error: Error | string,
  context: {
    location: string;  // e.g. "kiosk-handler:search"
    player_id?: string;
    request_id?: string;
    kiosk_session_id?: string;
    details?: Record<string, any>;
  }
): Promise<void> {
  try {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;

    await supabase.from('system_logs').insert({
      player_id: context.player_id || null,
      event: `edge_error:${context.location}`,
      severity: 'error',
      payload: {
        message,
        stack,
        ...context.details
      },
      source: 'edge',
      request_id: context.request_id,
      kiosk_session_id: context.kiosk_session_id
    });
  } catch (logErr) {
    console.error('[error-logger] Failed to persist error log:', logErr);
  }
}

/**
 * Log an info-level event (player status, health check, etc)
 */
export async function logEvent(
  supabase: any,
  event: string,
  context: {
    player_id?: string;
    severity?: 'debug' | 'info' | 'warn';
    payload?: Record<string, any>;
    request_id?: string;
    kiosk_session_id?: string;
  } = {}
): Promise<void> {
  try {
    await supabase.from('system_logs').insert({
      player_id: context.player_id || null,
      event,
      severity: context.severity || 'info',
      payload: context.payload || {},
      source: 'edge',
      request_id: context.request_id,
      kiosk_session_id: context.kiosk_session_id
    });
  } catch (err) {
    console.error('[error-logger] Failed to persist event log:', err);
  }
}
