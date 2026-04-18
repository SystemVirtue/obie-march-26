-- Migration: Add reset_priority_player flag to prevent priority reassignment
-- Date: 2026-04-18
-- Purpose: When user clicks "Reset Priority Player", set flag to TRUE
--          This flag prevents ANY priority reassignment until flag is explicitly reset

-- Add the reset_priority_player flag column to players table
ALTER TABLE public.players
ADD COLUMN reset_priority_player BOOLEAN NOT NULL DEFAULT FALSE;

-- When flag is TRUE, no player can be assigned priority
-- Flag is set to FALSE only when explicitly resetting via admin action
-- This prevents the continuous MASTER/SLAVE toggle from heartbeat race conditions

COMMENT ON COLUMN public.players.reset_priority_player IS 
'When TRUE, prevents reassignment of priority_player_id. Set TRUE when user clicks Reset. Set FALSE only via admin reset action.';
