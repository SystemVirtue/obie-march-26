#!/bin/bash
# Obie Jukebox v2 - Phase 4 Logging Implementation Deployment Package
# This script serves as the definitive deployment guide for the Phase 4 implementation
# Generated: April 16, 2026

set -e

DEPLOYMENT_DIR="phase4-deployment"
PACKAGE_VERSION="1.0.0"

echo "======================================================================"
echo "OBIE JUKEBOX V2 - PHASE 4 LOGGING IMPLEMENTATION"
echo "Deployment Package v${PACKAGE_VERSION}"
echo "======================================================================"
echo

# Function to verify prerequisites
verify_prerequisites() {
  echo "Verifying deployment prerequisites..."
  
  if ! command -v supabase &> /dev/null; then
    echo "ERROR: Supabase CLI not found. Please install it first."
    exit 1
  fi
  
  echo "✓ Supabase CLI found"
  
  if [ -z "$SUPABASE_URL" ]; then
    echo "ERROR: SUPABASE_URL environment variable not set"
    exit 1
  fi
  
  echo "✓ SUPABASE_URL configured"
  
  if [ -z "$SUPABASE_SERVICE_ROLE_KEY" ]; then
    echo "WARNING: SUPABASE_SERVICE_ROLE_KEY not set (optional for this deployment)"
  else
    echo "✓ SUPABASE_SERVICE_ROLE_KEY configured"
  fi
  
  echo
}

# Function to show what will be deployed
show_deployment_plan() {
  echo "======================================================================"
  echo "DEPLOYMENT PLAN"
  echo "======================================================================"
  echo
  echo "This deployment will:"
  echo
  echo "PHASE 1 - Database Schema (Non-breaking, additive only):"
  echo "  • Add 4 new columns to system_logs table (all nullable)"
  echo "    - source (TEXT, one of: 'edge', 'client', 'kiosk', 'system')"
  echo "    - request_id (UUID, for correlating related events)"
  echo "    - user_id (UUID, for tracking admin actions)"
  echo "    - kiosk_session_id (UUID, for kiosk session tracking)"
  echo "  • Add 3 indexes for efficient event filtering"
  echo "  • Populate source='edge' for all existing records"
  echo "  • Enable source NOT NULL constraint"
  echo
  echo "PHASE 2 - Player Status Triggers (Low-risk logging only):"
  echo "  • Create trigger function log_player_status_change()"
  echo "  • Log player_online and player_offline events"
  echo "  • Only triggers on actual status changes (not every heartbeat)"
  echo "  • Uses AFTER UPDATE for safety"
  echo
  echo "PHASE 3 - Edge Function Updates (Additive logging only):"
  echo "  • player-control: Add admin_skip action logging"
  echo "  • queue-manager: Add error logging to catch handlers"
  echo "  • All logging is non-blocking (failures don't interrupt requests)"
  echo
  echo "OUTCOME:"
  echo "  • Event visibility increases from 1.5% to 50%"
  echo "  • Quota usage increases from 23% to 25-28%"
  echo "  • Zero breaking changes or API modifications"
  echo "  • Full backward compatibility maintained"
  echo
  echo "DEPLOYMENT EFFORT: 15-20 hours"
  echo "ROLLBACK RISK: MINIMAL (simple function redeployment)"
  echo
}

# Function to export details
export_package_contents() {
  echo "======================================================================"
  echo "PACKAGE CONTENTS"
  echo "======================================================================"
  echo
  echo "Documentation:"
  echo "  • AUDIT_PHASE1_FINDINGS.md - Codebase audit and gap identification"
  echo "  • AUDIT_PHASE2_FINDINGS.md - Production metrics and quota analysis"
  echo "  • AUDIT_PHASE3_TRADEOFFS.md - Strategic options evaluation"
  echo "  • AUDIT_PHASE4_IMPLEMENTATION.md - Specific code changes"
  echo "  • AUDIT_COMPLETE_SUMMARY.md - Executive summary"
  echo "  • IMPLEMENTATION_DEPLOYMENT_GUIDE.md - Deployment procedures"
  echo "  • VALIDATION_REPORT.md - Safety assessment"
  echo "  • DELIVERY_COMPLETE.md - Deliverables inventory"
  echo
  echo "Code Migrations:"
  echo "  • supabase/migrations/0050_enhance_system_logs_schema.sql"
  echo "  • supabase/migrations/0051_player_online_offline_logging.sql"
  echo
  echo "Code Updates:"
  echo "  • supabase/functions/_shared/error-logger.ts (NEW)"
  echo "  • supabase/functions/player-control/index.ts (MODIFIED)"
  echo "  • supabase/functions/queue-manager/index.ts (MODIFIED)"
  echo
}

# Function to show deployment commands
show_deployment_commands() {
  echo "======================================================================"
  echo "DEPLOYMENT COMMANDS"
  echo "======================================================================"
  echo
  echo "Step 1: Deploy migrations to Supabase"
  echo "  $ supabase migration up"
  echo
  echo "Step 2: Deploy edge functions"
  echo "  $ supabase functions deploy player-control"
  echo "  $ supabase functions deploy queue-manager"
  echo
  echo "Step 3: Verify logging is working"
  echo "  $ supabase functions invoke player-control --method POST --body '{\"player_id\":\"test\",\"action\":\"heartbeat\"}'"
  echo
  echo "Step 4: Check for new system_logs entries"
  echo "  SELECT * FROM system_logs WHERE source='edge' ORDER BY timestamp DESC LIMIT 10;"
  echo
}

# Function to show rollback plan
show_rollback_plan() {
  echo "======================================================================"
  echo "ROLLBACK PROCEDURES"
  echo "======================================================================"
  echo
  echo "If critical issues occur:"
  echo
  echo "Option 1: Redeploy previous function versions (Recommended - 2 minutes)"
  echo "  $ supabase functions deploy player-control --version [previous-version]"
  echo "  $ supabase functions deploy queue-manager --version [previous-version]"
  echo
  echo "Option 2: Disable logging at source (1 minute)"
  echo "  Comment out logAdminAction() calls in player-control"
  echo "  Comment out logEdgeError() calls in queue-manager"
  echo "  Redeploy functions"
  echo
  echo "Option 3: Full rollback (30 minutes)"
  echo "  1. Identify rollback commit hash in git"
  echo "  2. Revert migrations: supabase migration down"
  echo "  3. Revert function code: git checkout [hash]"
  echo "  4. Redeploy everything"
  echo
  echo "NOTE: Migrations are non-destructive. New columns won't cause queries to fail."
  echo
}

# Function to show success criteria
show_success_criteria() {
  echo "======================================================================"
  echo "DEPLOYMENT SUCCESS CRITERIA"
  echo "======================================================================"
  echo
  echo "Verify deployment with these checks:"
  echo
  echo "1. Schema verification:"
  echo "   SELECT column_name FROM information_schema.columns"
  echo "     WHERE table_name='system_logs' AND column_name IN"
  echo "     ('source', 'request_id', 'user_id', 'kiosk_session_id');"
  echo
  echo "2. Trigger verification:"
  echo "   SELECT trigger_name FROM information_schema.triggers"
  echo "     WHERE trigger_name='trigger_log_player_status_change';"
  echo
  echo "3. Event logging verification:"
  echo "   SELECT event, COUNT(*) FROM system_logs"
  echo "     WHERE event IN ('admin_skip', 'player_online', 'player_offline','edge_error:queue-manager')"
  echo "     GROUP BY event;"
  echo
  echo "4. Performance check:"
  echo "   SELECT AVG(EXTRACT(EPOCH FROM (now() - timestamp)))"
  echo "     FROM system_logs WHERE timestamp > NOW() - INTERVAL '1 hour';"
  echo "   (Should show new entries being logged within last hour)"
  echo
}

# Main execution
if [ "$1" = "help" ] || [ "$1" = "-h" ]; then
  show_deployment_plan
  echo && show_deployment_commands
  echo && show_rollback_plan
  echo && show_success_criteria
  echo "======================================================================"
  echo "For detailed documentation, see IMPLEMENTATION_DEPLOYMENT_GUIDE.md"
  echo "======================================================================"
  exit 0
fi

# Run checks
verify_prerequisites

# Show all information
show_deployment_plan
echo
export_package_contents
echo
show_deployment_commands
echo
show_rollback_plan
echo
show_success_criteria

echo "======================================================================"
echo "DEPLOYMENT PACKAGE READY"
echo "======================================================================"
echo
echo "To proceed with deployment:"
echo "  1. Review all documentation files"
echo "  2. Backup Supabase database"
echo "  3. Deploy to staging environment first"
echo "  4. Monitor for 24-48 hours"
echo "  5. Deploy to production when stable"
echo
echo "Run: bash DEPLOYMENT_PACKAGE.sh help"
echo "to see this information again"
echo
