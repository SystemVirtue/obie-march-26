-- Migration: Drop priority_player_events table
-- This table is no longer needed since queue progression is now
-- server-controlled via complete_and_advance RPC without master/slave system.

DROP TABLE IF EXISTS priority_player_events;
