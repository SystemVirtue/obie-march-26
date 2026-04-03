-- Fix get_server_metrics() to gracefully handle missing pg_stat_statements extension.
-- The previous version queried pg_stat_statements directly in a single SELECT,
-- which caused the entire function to fail on Supabase instances without the extension.
-- This version builds the result incrementally and wraps the pg_stat_statements
-- query in an exception handler.

CREATE OR REPLACE FUNCTION public.get_server_metrics()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
  v_top_queries jsonb := '[]'::jsonb;
BEGIN
  -- Try to fetch top queries from pg_stat_statements (may not be available)
  BEGIN
    SELECT COALESCE(jsonb_agg(row_to_json(q)::jsonb ORDER BY q.total_exec_time DESC), '[]'::jsonb)
    INTO v_top_queries
    FROM (
      SELECT
        calls,
        round(total_exec_time::numeric, 0) AS total_exec_time,
        round(mean_exec_time::numeric, 1) AS mean_exec_time,
        rows,
        left(query, 120) AS query_preview
      FROM pg_stat_statements
      WHERE query NOT LIKE '%pg_stat%'
        AND query NOT LIKE '%set_config%'
      ORDER BY total_exec_time DESC
      LIMIT 10
    ) q;
  EXCEPTION WHEN undefined_table OR insufficient_privilege THEN
    v_top_queries := '[]'::jsonb;
  END;

  SELECT jsonb_build_object(
    'tables', (
      SELECT jsonb_agg(row_to_json(t)::jsonb ORDER BY t.total_size_bytes DESC)
      FROM (
        SELECT
          s.relname AS table_name,
          pg_total_relation_size(s.schemaname || '.' || s.relname) AS total_size_bytes,
          pg_relation_size(s.schemaname || '.' || s.relname) AS table_size_bytes,
          pg_indexes_size(s.schemaname || '.' || s.relname) AS index_size_bytes,
          s.n_live_tup AS live_rows,
          s.n_dead_tup AS dead_rows,
          s.seq_scan,
          s.seq_tup_read,
          s.idx_scan,
          s.idx_tup_fetch,
          s.n_tup_ins AS inserts,
          s.n_tup_upd AS updates,
          s.n_tup_del AS deletes,
          COALESCE(io.heap_blks_hit, 0) AS cache_hits,
          COALESCE(io.heap_blks_read, 0) AS disk_reads,
          CASE WHEN (COALESCE(io.heap_blks_hit, 0) + COALESCE(io.heap_blks_read, 0)) > 0
            THEN round(100.0 * io.heap_blks_hit / (io.heap_blks_hit + io.heap_blks_read), 1)
            ELSE 100.0 END AS cache_hit_pct
        FROM pg_stat_user_tables s
        LEFT JOIN pg_statio_user_tables io ON s.relid = io.relid
        WHERE s.schemaname = 'public'
      ) t
    ),
    'connections', (
      SELECT jsonb_build_object(
        'total', count(*),
        'active', count(*) FILTER (WHERE state = 'active'),
        'idle', count(*) FILTER (WHERE state = 'idle'),
        'idle_in_transaction', count(*) FILTER (WHERE state = 'idle in transaction')
      )
      FROM pg_stat_activity
    ),
    'database', (
      SELECT jsonb_build_object(
        'size_bytes', pg_database_size(current_database()),
        'cache_hit_ratio', (
          SELECT round(100.0 * sum(heap_blks_hit) / NULLIF(sum(heap_blks_hit) + sum(heap_blks_read), 0), 2)
          FROM pg_statio_user_tables
        ),
        'index_cache_hit_ratio', (
          SELECT round(100.0 * sum(idx_blks_hit) / NULLIF(sum(idx_blks_hit) + sum(idx_blks_read), 0), 2)
          FROM pg_statio_user_tables
        )
      )
    ),
    'replication_slots', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'slot_name', slot_name,
        'active', active,
        'wal_lag_bytes', pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)
      )), '[]'::jsonb)
      FROM pg_replication_slots
    ),
    'top_queries', v_top_queries,
    'collected_at', now()
  ) INTO result;

  RETURN result;
END;
$$;
