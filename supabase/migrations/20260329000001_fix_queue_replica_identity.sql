-- The previous migration (20260328000004) dropped queue_player_id_id_key which
-- was the index used for REPLICA IDENTITY USING INDEX. This left the queue table
-- unable to process DELETEs since Realtime publishes deletes.
-- Restore REPLICA IDENTITY using DEFAULT (primary key) which has lower WAL
-- overhead than FULL while still allowing DELETE events to be published.
ALTER TABLE public.queue REPLICA IDENTITY DEFAULT;
