#!/bin/bash
# CCManager On-Stop Hook
# 任务结束时自动提交代码

PROJECT_DIR="$(pwd)"
cd "$PROJECT_DIR"

# 检查是否有未提交的修改
if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
    echo "[Hook] No changes to commit."
    exit 0
fi

echo "[Hook] Preparing commit..."

# 获取修改的文件列表
CHANGED_FILES=$(git diff --name-only && git diff --cached --name-only && git ls-files --others --exclude-standard)

# 生成 commit message（简单版本，基于修改的文件）
if echo "$CHANGED_FILES" | grep -q "^packages/server"; then
    SCOPE="server"
elif echo "$CHANGED_FILES" | grep -q "^packages/agent"; then
    SCOPE="agent"
elif echo "$CHANGED_FILES" | grep -q "^packages/web"; then
    SCOPE="web"
else
    SCOPE="chore"
fi

# 统计修改
STATS=$(git diff --stat --cached 2>/dev/null | tail -1)
if [ -z "$STATS" ]; then
    STATS=$(git diff --stat 2>/dev/null | tail -1)
fi

# 生成提交信息
COMMIT_MSG="${SCOPE}: auto-commit by CCManager hook

Files changed:
$CHANGED_FILES

Stats: $STATS

Co-Authored-By: Claude <noreply@anthropic.com>"

# 添加所有修改并提交
git add -A
git commit -m "$COMMIT_MSG"

echo "[Hook] Committed successfully."

# 推送到远程
git push origin main 2>&1 || echo "[Hook] Push failed, please push manually."
