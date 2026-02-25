#!/bin/bash
# CCManager Post-Edit Hook
# 在文件修改后运行代码检查和提交

PROJECT_DIR="$(pwd)"
cd "$PROJECT_DIR"

# 检查是否有修改
if git diff --quiet && git diff --cached --quiet; then
    exit 0
fi

echo "[Hook] Running code checks..."

# TypeScript 类型检查
if [ -f "package.json" ]; then
    npm run typecheck 2>&1 || true
fi

# 如果有 eslint，运行 lint
if [ -f ".eslintrc.js" ] || [ -f ".eslintrc.json" ]; then
    npm run lint 2>&1 || true
fi

echo "[Hook] Code check completed."
