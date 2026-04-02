-- Performance indexes identified from pg_stat_statements analysis
-- These are additive-only (CREATE INDEX IF NOT EXISTS) and safe for production.

-- queue.player_id: used by every queue fetch (service_role + authenticated)
-- Index advisor: startup cost drops 624 → 615 on queue queries
CREATE INDEX IF NOT EXISTS idx_queue_player_id ON public.queue USING btree (player_id);

-- system_logs.timestamp: used by ORDER BY timestamp DESC queries
-- Index advisor: startup cost drops 996 → 94 (10x improvement)
CREATE INDEX IF NOT EXISTS idx_system_logs_timestamp ON public.system_logs USING btree ("timestamp" DESC);
