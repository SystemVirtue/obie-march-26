-- Increase player_heartbeat() offline threshold from 10 s to 45 s.
-- With 30-second heartbeat intervals from the player app, the original 10-second
-- threshold could falsely mark a slow-heartbeating jukebox offline before its
-- next beat arrived, and in multi-jukebox setups would race between devices.
CREATE OR REPLACE FUNCTION player_heartbeat(
  p_player_id UUID
)
RETURNS void AS $$
BEGIN
  UPDATE players
  SET
    status = 'online',
    last_heartbeat = NOW(),
    updated_at = NOW()
  WHERE id = p_player_id;

  -- Mark offline if no heartbeat in 45 seconds (supports 30 s client interval)
  UPDATE players
  SET status = 'offline'
  WHERE id != p_player_id
    AND status = 'online'
    AND last_heartbeat < NOW() - INTERVAL '45 seconds';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
