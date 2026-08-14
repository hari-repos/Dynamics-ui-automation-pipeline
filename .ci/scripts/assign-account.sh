#!/usr/bin/env bash
# =============================================================================
# assign-account.sh
#
# Filters SERVICE_ACCOUNT_CATALOG_JSON by AVAILABLE_ACCOUNTS (if provided),
# assigns an account to SLOT using modulo math for safe reuse, and emits
# secret-masked TEST_USERNAME and TEST_PASSWORD job variables.
#
# Environment variables:
#   SERVICE_ACCOUNT_CATALOG_JSON  🔒 Secret JSON catalog of all service accounts
#   SLOT                          Numeric slot index (0, 1, 2...) from matrix
#   AVAILABLE_ACCOUNTS            Optional comma-separated filter (e.g. "auto01,auto03")
# =============================================================================

set -euo pipefail

if [ -z "${SERVICE_ACCOUNT_CATALOG_JSON:-}" ]; then
  echo "##[error]SERVICE_ACCOUNT_CATALOG_JSON is not set."
  echo "##[error]Add this secret to the 'dynamics365-service-accounts' Variable Group."
  exit 1
fi

if [ -z "${SLOT:-}" ]; then
  echo "##[error]SLOT env var is not set."
  exit 1
fi

if ! echo "$SERVICE_ACCOUNT_CATALOG_JSON" | jq empty 2>/dev/null; then
  echo "##[error]SERVICE_ACCOUNT_CATALOG_JSON is not valid JSON."
  exit 1
fi

# 1. Parse all available account keys in alphabetical order
ALL_KEYS_JSON=$(echo "$SERVICE_ACCOUNT_CATALOG_JSON" | jq -c 'keys | sort')

AVAILABLE_INPUT="${AVAILABLE_ACCOUNTS:-}"

# 2. Filter keys if user specified a subset of accounts
if [ -n "$AVAILABLE_INPUT" ]; then
  # Convert comma-separated string "auto01, auto03" into a cleaned jq array
  SELECTED_ARRAY=$(echo "$AVAILABLE_INPUT" | jq -R 'split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))')
  
  # Intersect catalog keys with selected keys
  TARGET_KEYS_JSON=$(echo "$ALL_KEYS_JSON" | jq -c --argjson sel "$SELECTED_ARRAY" '[.[] | select(. as $k | $sel | contains([$k]))]')
else
  TARGET_KEYS_JSON="$ALL_KEYS_JSON"
fi

COUNT=$(echo "$TARGET_KEYS_JSON" | jq 'length')

if [ "$COUNT" -eq 0 ]; then
  echo "##[error]No matching service accounts found for input: '$AVAILABLE_INPUT'."
  echo "##[error]Accounts in catalog: $(echo "$ALL_KEYS_JSON" | jq -r 'join(", ")')"
  exit 1
fi

# 3. Calculate index using modulo math for safe reuse when personas > available accounts
INDEX=$(( SLOT % COUNT ))

# 4. Extract account key and credentials
ACCOUNT_KEY=$(echo "$TARGET_KEYS_JSON" | jq -r --argjson idx "$INDEX" '.[$idx]')

USERNAME=$(echo "$SERVICE_ACCOUNT_CATALOG_JSON" | jq -r --arg k "$ACCOUNT_KEY" '.[$k].username')
PASSWORD=$(echo "$SERVICE_ACCOUNT_CATALOG_JSON" | jq -r --arg k "$ACCOUNT_KEY" '.[$k].password')

if [ -z "$USERNAME" ] || [ "$USERNAME" = "null" ] || [ -z "$PASSWORD" ] || [ "$PASSWORD" = "null" ]; then
  echo "##[error]Account '$ACCOUNT_KEY' is missing username or password in catalog."
  exit 1
fi

# 5. Emit secret-masked variables to Azure DevOps
echo "##vso[task.setvariable variable=TEST_USERNAME;issecret=true]$USERNAME"
echo "##vso[task.setvariable variable=TEST_PASSWORD;issecret=true]$PASSWORD"
echo "##vso[task.setvariable variable=ASSIGNED_ACCOUNT]$ACCOUNT_KEY"

echo "✅ Slot $SLOT assigned to account '$ACCOUNT_KEY' (Index $INDEX of $COUNT selected account(s))"
