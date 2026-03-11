-- 202603110001_drop_load_playlist_3arg.sql
--
-- Migration 20251109233222 re-created the 3-argument overload of load_playlist
-- (p_player_id, p_playlist_id, p_start_index) after migration 0041 had already
-- dropped it. This produced two functions matching the same 3-argument call:
--
--   load_playlist(uuid, uuid, int)                  ← from 20251109233222
--   load_playlist(uuid, uuid, int, boolean DEFAULT) ← from 0041
--
-- PostgreSQL raises error 42725 ("function ... is not unique") on any 3-arg
-- invocation because both candidates are equally valid. The player init RPC
-- call fails with this error on every startup.
--
-- Fix: drop the spurious 3-arg overload. The canonical 4-arg version (0041)
-- accepts p_skip_shuffle BOOLEAN DEFAULT FALSE, so existing 3-arg callers
-- continue to work without modification.

DROP FUNCTION IF EXISTS load_playlist(UUID, UUID, INT);
