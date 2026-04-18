-- Migration: Enhance system_logs schema for better traceability
-- Date: 2026-04-16
-- Purpose: Add source, request_id, user_id, kiosk_session_id for better audit trail

-- Add new columns for better traceability
ALTER TABLE system_logs ADD COLUMN source TEXT CHECK (source IN ('edge', 'client', 'kiosk', 'system'));
ALTER TABLE system_logs ADD COLUMN request_id UUID;  -- For correlating related operations
ALTER TABLE system_logs ADD COLUMN user_id UUID;      -- Admin user who triggered action
ALTER TABLE system_logs ADD COLUMN kiosk_session_id UUID; -- Kiosk session that triggered action

-- Add indexes for efficient filtering
CREATE INDEX idx_system_logs_source ON system_logs(source);
CREATE INDEX idx_system_logs_request_id ON system_logs(request_id);
CREATE INDEX idx_system_logs_by_user_date ON system_logs(user_id, timestamp DESC);

-- Update existing logs to mark them as "edge" source (conservative)
UPDATE system_logs SET source = 'edge' WHERE source IS NULL;

ALTER TABLE system_logs ALTER COLUMN source SET NOT NULL;
