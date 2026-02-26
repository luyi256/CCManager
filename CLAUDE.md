# CC Manager

Claude Code 多设备任务管理系统 - 管理多台设备上的 Claude Code 任务执行。

## 仓库

- **代码**: https://github.com/luyi256/CCManager
- **数据**: https://github.com/luyi256/CCManagerData

## 架构

```
云服务器 (rack: 107.174.67.124)
├── ~/CCManager      - 代码仓库
├── ~/CCManagerData  - 数据仓库 (SQLite DB, 配置等)
└── ccm-server       - pm2 守护进程 (端口 3001)

开发机器 (MacBook, Linux 等)
└── ccm-agent        - 连接到云服务器执行任务
```

## 访问地址

- **Web UI**: http://107.174.67.124:3001
- **API**: http://107.174.67.124:3001/api

## 服务器管理 (rack)

```bash
ssh rack
cd ~/CCManager

# 常用命令
pm2 status              # 查看状态
pm2 logs ccm-server     # 查看日志
pm2 restart ccm-server  # 重启服务

# 更新代码
git pull
npm run build -w @ccmanager/server
npm run build -w @ccmanager/web
pm2 restart ccm-server

# 同步数据到 GitHub
cd ~/CCManagerData && git add -A && git commit -m "Data sync" && git push
```

## Agent 配置 (开发机器)

配置文件 `packages/agent/agent.config.json`:

```json
{
  "agentId": "unique-id",
  "agentName": "显示名称",
  "managerUrl": "http://107.174.67.124:3001",
  "authToken": "dev-token-123",
  "executor": "local",
  "allowedPaths": ["/path/to/projects/*"],
  "blockedPaths": ["/path/to/.ssh"],
  "capabilities": ["local", "no-gpu"]
}
```

启动 Agent:
```bash
cd /path/to/CCManager
npx pm2 start ecosystem.config.cjs
npx pm2 logs ccm-agent
```

## 重要规则

- 每次修改后重启服务以应用修改：`pm2 restart ccm-server`
- 每次完成代码修改后重新部署本项目：编译 (`npm run build -w @ccmanager/server && npm run build -w @ccmanager/web`) 然后重启 (`pm2 restart ccm-server`)
- **提交信息**: 每次 commit 时必须生成有意义的提交信息，总结本次修改的具体内容（如 `fix: 修复任务状态同步问题` 或 `feat: 添加任务优先级排序功能`），禁止使用 `auto-commit by CCManager hook` 等无意义的通用信息

## 开发

```bash
# 安装依赖
npm install

# 编译
npm run build -w @ccmanager/server
npm run build -w @ccmanager/web

# 开发模式
npm run dev -w @ccmanager/server
npm run dev -w @ccmanager/web
```

## 任务执行

- **并行执行**: 同一 agent 可同时执行多个任务
- **孤儿任务恢复**: 服务重启后自动恢复 `running` 状态的任务
- **继续对话**: `POST /api/tasks/:id/continue` 基于已完成任务的会话继续工作
