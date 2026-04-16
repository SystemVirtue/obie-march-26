-- Migration: Add player online/offline event logging
-- Date: 2026-04-16
-- Purpose: Log when players come online or go offline for better observability

-- Create trigger function: Log when player comes online/offline
CREATE OR REPLACE FUNCTION log_player_status_change()
RETURNS TRIGGER AS $$
BEGIN
  -- Only log if status actually changed
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO system_logs (player_id, event, severity, payload, source)
    VALUES (
      NEW.id,
      CASE 
        WHEN NEW.status = 'online' THEN 'player_online'
        WHEN NEW.status = 'offline' THEN 'player_offline'
        ELSE 'player_status_changed'
      END,
      'info',
      jsonb_build_object(
        'old_status', OLD.status,
        'new_status', NEW.status,
        'last_heartbeat', NEW.last_heartbeat,
        'session_id', NEW.priority_player_id
      ),
      'system'
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Attach trigger to players table
DROP TRIGGER IF EXISTS trigger_log_player_status_change ON players;
CREATE TRIGGER trigger_log_player_status_change
AFTER UPDATE ON players
FOR EACH ROW
EXECUTE FUNCTION log_player_status_change();
