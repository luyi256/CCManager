#!/bin/bash
# CCManager 部署脚本
# 用法: ./deploy.sh [commit message]
# 如果不提供消息，会根据修改的文件自动生成

set -e

# 自动生成 commit 消息
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

# 1. 添加并提交代码
echo ">>> Git add and commit..."
git add -A
git commit -m "$COMMIT_MSG

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>" || echo "Nothing to commit"

# 2. 推送到 GitHub
echo ">>> Pushing to GitHub..."
git push origin main

# 3. 在 rack 服务器上更新并重启 (以 CC 用户)
echo ">>> Updating rack server..."
ssh rack "su - CC -c 'cd ~/CCManager && git pull && pnpm run build && pm2 restart ccm-server'"

echo "=== Deploy Complete ==="
