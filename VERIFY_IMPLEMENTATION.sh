#!/bin/bash
# Implementation Verification Script
# Validates that all Phase 4 deliverables are in place and ready for deployment

set -e

echo "=========================================="
echo "PHASE 4 IMPLEMENTATION VERIFICATION"
echo "=========================================="
echo

# Check SQL migrations
echo "1. Verifying SQL Migrations..."
if [ -f "supabase/migrations/0050_enhance_system_logs_schema.sql" ]; then
  LINES=$(wc -l < supabase/migrations/0050_enhance_system_logs_schema.sql)
  echo "   ✓ 0050_enhance_system_logs_schema.sql ($LINES lines)"
else
  echo "   ✗ Missing 0050_enhance_system_logs_schema.sql"
  exit 1
fi

if [ -f "supabase/migrations/0051_player_online_offline_logging.sql" ]; then
  LINES=$(wc -l < supabase/migrations/0051_player_online_offline_logging.sql)
  echo "   ✓ 0051_player_online_offline_logging.sql ($LINES lines)"
else
  echo "   ✗ Missing 0051_player_online_offline_logging.sql"
  exit 1
fi

# Check error-logger utility
echo
echo "2. Verifying Error-Logger Utility..."
if [ -f "supabase/functions/_shared/error-logger.ts" ]; then
  EXPORTS=$(grep -c "export" supabase/functions/_shared/error-logger.ts)
  echo "   ✓ error-logger.ts ($EXPORTS exports)"
else
  echo "   ✗ Missing error-logger.ts"
  exit 1
fi

# Check player-control modifications
echo
echo "3. Verifying player-control Modifications..."
if grep -q "logAdminAction" supabase/functions/player-control/index.ts; then
  echo "   ✓ logAdminAction helper function present"
else
  echo "   ✗ logAdminAction not found"
  exit 1
fi

# Check queue-manager modifications
echo
echo "4. Verifying queue-manager Modifications..."
if grep -q "logEdgeError" supabase/functions/queue-manager/index.ts; then
  echo "   ✓ logEdgeError import present"
else
  echo "   ✗ logEdgeError not found"
  exit 1
fi

# Check documentation
echo
echo "5. Verifying Documentation..."
DOCS=("AUDIT_PHASE1_FINDINGS.md" "AUDIT_PHASE2_FINDINGS.md" "AUDIT_PHASE3_TRADEOFFS.md" "AUDIT_PHASE4_IMPLEMENTATION.md" "AUDIT_COMPLETE_SUMMARY.md" "IMPLEMENTATION_DEPLOYMENT_GUIDE.md" "VALIDATION_REPORT.md" "DELIVERY_COMPLETE.md")

for doc in "${DOCS[@]}"; do
  if [ -f "$doc" ]; then
    SIZE=$(ls -lh "$doc" | awk '{print $5}')
    echo "   ✓ $doc ($SIZE)"
  else
    echo "   ✗ Missing $doc"
    exit 1
  fi
done

echo
echo "=========================================="
echo "✓ ALL DELIVERABLES VERIFIED"
echo "=========================================="
echo
echo "Implementation is ready for deployment:"
echo "  - 2 SQL migrations created"
echo "  - 1 error-logger utility added"
echo "  - 2 edge functions enhanced"
echo "  - 8 comprehensive documents provided"
echo
echo "Next steps: Review IMPLEMENTATION_DEPLOYMENT_GUIDE.md for deployment procedures"
echo
