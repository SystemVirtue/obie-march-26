-- Migration: Remove master/slave related RPC functions
-- These functions are no longer needed since queue progression is now
-- server-controlled via complete_and_advance RPC without master/slave system.

DROP FUNCTION IF EXISTS player_heartbeat(UUID);
DROP FUNCTION IF EXISTS claim_priority_player(UUID);
DROP FUNCTION IF EXISTS reset_priority_player_global();
