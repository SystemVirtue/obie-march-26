#!/bin/bash
# Diagnostic: Check Master Player (OBIE) Online Status
# This script loads env vars and runs the Node.js diagnostic

set -a
source .env
set +a

node scripts/check-master-player-status.mjs
