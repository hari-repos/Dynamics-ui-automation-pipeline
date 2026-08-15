#!/usr/bin/env bash
# =============================================================================
# claim-account.sh
#
# Validates user account selection, performs atomic Git branch lock acquisition
# in Azure Repos (locks/env-${ENVIRONMENT}-autoXX-build-${BUILD_BUILDID}),
# parses secret credentials via jq, and emits secret-masked pipeline variables.
# =============================================================================

set -euo pipefail

ENVIRONMENT="${ENVIRONMENT:-dev}"
BUILD_BUILDID="${BUILD_BUILDID:-0}"
AVAILABLE="${AVAILABLE_ACCOUNTS:-}"
SERVICE_CATALOG="${SERVICE_ACCOUNT_CATALOG_JSON:-}"

echo "============================================================"
echo " 🔑 Service Account Claim Initialization"
echo " Environment : $ENVIRONMENT"
echo " Build ID    : $BUILD_BUILDID"
echo " Selected    : ${AVAILABLE:-<NONE>}"
echo "============================================================"

# 1. Validation: At least 1 account must be selected in the UI
if [ -z "$AVAILABLE" ]; then
  echo "##[error] No service accounts selected!"
  echo "##[error] You must enable at least 1 service account toggle (use_auto01 ... use_auto16) in the pipeline run parameters."
  exit 1
fi

if [ -z "$SERVICE_CATALOG" ]; then
  echo "##[error] SERVICE_ACCOUNT_CATALOG_JSON secret variable is not set."
  echo "##[error] Ensure the Variable Group 'dynamics365-service-accounts' is linked to the pipeline."
  exit 1
fi

if ! echo "$SERVICE_CATALOG" | jq empty 2>/dev/null; then
  echo "##[error] SERVICE_ACCOUNT_CATALOG_JSON is not valid JSON."
  exit 1
fi

# Convert comma-separated "auto01, auto03" into a clean array
IFS=',' read -ra ACCOUNTS_ARRAY <<< "$AVAILABLE"
CLEAN_ACCOUNTS=()
for acct in "${ACCOUNTS_ARRAY[@]}"; do
  trimmed=$(echo "$acct" | xargs)
  if [ -n "$trimmed" ]; then
    CLEAN_ACCOUNTS+=("$trimmed")
  fi
done

if [ ${#CLEAN_ACCOUNTS[@]} -eq 0 ]; then
  echo "##[error] No valid accounts parsed from selection: '$AVAILABLE'."
  exit 1
fi

echo "Scanning ${#CLEAN_ACCOUNTS[@]} user-selected account(s) for lock availability..."

MAX_ATTEMPTS=80 # 80 attempts * 15s = 20 minutes timeout
ATTEMPT=1

while [ $ATTEMPT -le $MAX_ATTEMPTS ]; do
  for ACCOUNT_KEY in "${CLEAN_ACCOUNTS[@]}"; do
    LOCK_REF="refs/heads/locks/env-${ENVIRONMENT}-${ACCOUNT_KEY}-build-${BUILD_BUILDID}"
    
    echo "Attempting lock acquisition for account '$ACCOUNT_KEY' (Ref: $LOCK_REF)..."
    
    # Attempt atomic git branch reference creation in Azure Repos
    PUSH_OUTPUT=$(git push origin "HEAD:${LOCK_REF}" 2>&1) && rc=0 || rc=$?
    
    # IMPORTANT FIX: Git returns exit code 0 when creating a NEW branch, BUT ALSO returns 0
    # with "Everything up-to-date" if the branch ALREADY exists!
    # We MUST check that PUSH_OUTPUT does NOT contain "Everything up-to-date".
    if [ $rc -eq 0 ] && ! echo "$PUSH_OUTPUT" | grep -qi "Everything up-to-date"; then
      echo "------------------------------------------------------------"
      echo "✅ Lock Acquired Successfully!"
      echo " Account Key   : $ACCOUNT_KEY"
      echo " Lock Reference: $LOCK_REF"
      echo " Output        : $PUSH_OUTPUT"
      echo "------------------------------------------------------------"

      # Parse credentials for claimed account using jq
      USERNAME=$(echo "$SERVICE_CATALOG" | jq -r --arg k "$ACCOUNT_KEY" '.[$k].username // empty')
      PASSWORD=$(echo "$SERVICE_CATALOG" | jq -r --arg k "$ACCOUNT_KEY" '.[$k].password // empty')

      if [ -z "$USERNAME" ] || [ -z "$PASSWORD" ]; then
        echo "##[error] Account '$ACCOUNT_KEY' is missing username or password in SERVICE_ACCOUNT_CATALOG_JSON."
        exit 1
      fi

      # Emit secret-masked variables to Azure DevOps job
      echo "##vso[task.setvariable variable=TEST_USERNAME;issecret=true]$USERNAME"
      echo "##vso[task.setvariable variable=TEST_PASSWORD;issecret=true]$PASSWORD"
      echo "##vso[task.setvariable variable=ASSIGNED_ACCOUNT]$ACCOUNT_KEY"
      echo "##vso[task.setvariable variable=LOCK_REF]$LOCK_REF"

      exit 0
    else
      # If output contains "Everything up-to-date", "rejected", "already exists", "non-fast-forward" or "conflict", it's locked by another job!
      if echo "$PUSH_OUTPUT" | grep -qiE "Everything up-to-date|rejected|already exists|non-fast-forward|conflict"; then
        echo " ⏳ Account '$ACCOUNT_KEY' is currently locked by another job (Reason: branch already exists / pushed). Trying next..."
      else
        echo "##[error] Git push failed with an unexpected error during lock acquisition:"
        echo "$PUSH_OUTPUT"
        exit 1
      fi
    fi
  done

  echo "All ${#CLEAN_ACCOUNTS[@]} selected account(s) are currently locked. Retrying in 15 seconds (Attempt $ATTEMPT/$MAX_ATTEMPTS)..."
  sleep 15
  ATTEMPT=$((ATTEMPT + 1))
done

echo "##[error] Timed out after 20 minutes waiting for a free service account."
exit 1
