#!/bin/bash
# CCManager deploy script
# Usage: ./deploy.sh [commit message]
# Auto-generates commit message from changed files if not provided
#
# Configure deploy target in <DATA_PATH>/secrets.env:
#   DEPLOY_HOST - SSH host alias
#   DEPLOY_USER - remote user

set -e

DATA_PATH="${DATA_PATH:-./data}"
SECRETS_FILE="${DATA_PATH}/secrets.env"

if [ -f "$SECRETS_FILE" ]; then
    source "$SECRETS_FILE"
fi

# Auto-generate commit message
if [ -z "$1" ]; then
  CHANGED_FILES=$(git diff --name-only HEAD 2>/dev/null | head -3 | tr '\n' ', ' | sed 's/,$//')
  if [ -z "$CHANGED_FILES" ]; then
    CHANGED_FILES=$(git diff --cached --name-only 2>/dev/null | head -3 | tr '\n' ', ' | sed 's/,$//')
  fi
  if [ -n "$CHANGED_FILES" ]; then
    COMMIT_MSG="chore: update ${CHANGED_FILES}"
  else
    COMMIT_MSG="chore: auto deploy $(date +%Y-%m-%d_%H:%M)"
  fi
else
  COMMIT_MSG="$1"
fi

echo "=== CCManager Deploy ==="

# 1. Add and commit
echo ">>> Git add and commit..."
git add -A
git commit -m "$COMMIT_MSG" || echo "Nothing to commit"

# 2. Push to GitHub
echo ">>> Pushing to GitHub..."
git push origin main

# 3. Update remote server (if configured)
if [ -n "$DEPLOY_HOST" ] && [ -n "$DEPLOY_USER" ]; then
    echo ">>> Updating remote server ($DEPLOY_HOST)..."
    ssh "$DEPLOY_HOST" "su - $DEPLOY_USER -c 'cd ~/CCManager && git pull && pnpm run build && pm2 restart ccm-server'"
else
    echo ">>> No remote deploy target configured (set DEPLOY_HOST and DEPLOY_USER in secrets.env)"
fi

echo "=== Deploy Complete ==="
