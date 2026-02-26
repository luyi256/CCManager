# CC Manager

Claude Code 多设备任务管理系统 - 管理多台设备上的 Claude Code 任务执行。

## 仓库

- **代码**: https://github.com/luyi256/CCManager
- **数据**: https://github.com/luyi256/CCManagerData

## 架构

```
云服务器 (rack: 107.174.67.124, 用户: CC)
├── /home/CC/CCManager      - 代码仓库
├── /home/CC/CCManagerData  - 数据仓库 (SQLite DB, 配置等)
├── ccm-server              - pm2 守护进程 (端口 3001)
└── ccm-agent               - pm2 守护进程 (连接本地服务器)

开发机器 (MacBook, Linux 等)
└── ccm-agent        - 连接到云服务器执行任务
```

**重要**: 服务器上始终使用 CC 用户操作，不要用 root 用户。

## 访问地址

- **Web UI**: http://107.174.67.124:3001
- **API**: http://107.174.67.124:3001/api

## 服务器管理 (rack)

**重要**: 始终使用 CC 用户操作！

```bash
# 方式1: 直接以 CC 用户 SSH
ssh CC@rack

# 方式2: 从 root 切换到 CC
ssh rack
su - CC

# 进入项目目录
cd ~/CCManager

# 常用命令
pm2 status              # 查看状态
pm2 logs ccm-server     # 查看日志
pm2 restart ccm-server  # 重启服务

# 更新代码并重启
git pull
pnpm run build
pm2 restart ccm-server

# 如果服务丢失环境变量，使用 ecosystem 重新启动
pm2 delete ccm-server ccm-agent
pm2 start ecosystem.config.cjs
pm2 save

# 同步数据到 GitHub
cd ~/CCManagerData && git add -A && git commit -m "Data sync" && git push
```

## 环境变量 (重要)

服务器必须设置以下环境变量：
- `DATA_PATH=/home/CC/CCManagerData` - 数据库路径
- `STATIC_PATH=/home/CC/CCManager/packages/web/dist` - 静态文件路径
- `SERVE_STATIC=true` - 启用静态文件服务

这些已配置在 `ecosystem.config.cjs` 中。

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

## 部署流程

**重要**: 本地修改代码完成后，必须执行部署流程让远程服务器更新。

### 快速部署 (推荐)

```bash
./deploy.sh "fix: your commit message"
```

### 手动部署

```bash
# 1. 本地提交并推送
git add -A
git commit -m "your message"
git push origin main

# 2. 远程更新 (以 CC 用户)
ssh rack "su - CC -c 'cd ~/CCManager && git pull && pnpm run build && pm2 restart ccm-server'"
```

### Claude Code 工作流

当完成代码修改任务后，Claude 应该：
1. 提交代码到 GitHub
2. SSH 到 rack 服务器，以 CC 用户执行 `git pull && pnpm run build && pm2 restart ccm-server`
3. 确认服务正常运行
