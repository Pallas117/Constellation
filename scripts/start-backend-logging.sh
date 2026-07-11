#!/usr/bin/env bash
set -euo pipefail

# Creates logs dir and starts the backend with stdout/stderr redirected
LOG_DIR="data/agents/logs"
mkdir -p "$LOG_DIR"

echo "Starting backend with logging to $LOG_DIR/backend.log"
export OFFICIAL_SOURCES_ONLY=${OFFICIAL_SOURCES_ONLY:-true}

# Run the same command used by package.json 'dev:proxy' but pipe through tee
node --env-file-if-exists=.env --import tsx backend/server.ts 2>&1 | tee "$LOG_DIR/backend.log"
