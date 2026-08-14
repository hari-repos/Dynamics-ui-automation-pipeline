#!/usr/bin/env bash
# =============================================================================
# release-account.sh
#
# Releases the Git branch lock in Azure Repos upon job completion.
# Runs with condition: always() in Azure Pipelines.
# =============================================================================

set -euo pipefail

LOCK_REF="${LOCK_REF:-}"
ASSIGNED_ACCOUNT="${ASSIGNED_ACCOUNT:-}"

echo "============================================================"
echo " 🔑 Service Account Lock Release"
echo " Account Key : ${ASSIGNED_ACCOUNT:-<UNKNOWN>}"
echo " Lock Reference: ${LOCK_REF:-<NONE>}"
echo "============================================================"

if [ -z "$LOCK_REF" ]; then
  echo "No active lock reference to release (job may have failed prior to claiming an account)."
  exit 0
fi

echo "Releasing Git lock branch '${LOCK_REF}' from Azure Repos..."

if git push origin --delete "$LOCK_REF" 2>/dev/null; then
  echo "✅ Lock branch successfully deleted. Account '${ASSIGNED_ACCOUNT}' is now free."
else
  echo "⚠️  Lock branch was already deleted or cleaned up."
fi

exit 0
