#!/bin/bash
# CCManager 部署脚本
# 用法: ./deploy.sh [commit message]

set -e

COMMIT_MSG="${1:-auto deploy}"

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
