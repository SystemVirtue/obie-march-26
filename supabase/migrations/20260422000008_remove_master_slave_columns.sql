-- Migration: Remove master/slave columns from players table
-- This removes the priority_player_id and priority_selection_pending columns
-- since queue progression is now server-controlled via complete_and_advance RPC.

-- Remove priority_player_id column
ALTER TABLE players DROP COLUMN IF EXISTS priority_player_id;

-- Remove priority_selection_pending column
ALTER TABLE players DROP COLUMN IF EXISTS priority_selection_pending;

-- Drop the index that was created for priority_player_id
DROP INDEX IF EXISTS idx_players_priority_player_id;
