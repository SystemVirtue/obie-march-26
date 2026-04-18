-- Fix log_event function which references a non-existent "source" column on system_logs.
-- The source value belongs inside the payload JSONB, not as a separate column.
-- Drop the broken 5-param overload first to avoid ambiguity errors.
DROP FUNCTION IF EXISTS public.log_event(uuid, text, text, jsonb, text);

CREATE OR REPLACE FUNCTION public.log_event(
  p_player_id UUID,
  p_event     TEXT,
  p_severity  TEXT DEFAULT 'info',
  p_payload   JSONB DEFAULT '{}'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO system_logs (player_id, event, severity, payload)
  VALUES (p_player_id, p_event, p_severity, p_payload);
END;
$$;
