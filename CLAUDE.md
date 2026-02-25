# CC Manager

Claude Code 多设备任务管理系统 - 管理多台设备上的 Claude Code 任务执行。

## 架构

```
云服务器 (rack: 107.174.67.124)
└── ccm-server (端口 3001) - Express + Socket.IO + Web 前端

本地 MacBook
└── ccm-agent - 连接到云服务器执行任务
```

## 访问地址

- **Web UI**: http://107.174.67.124:3001
- **API**: http://107.174.67.124:3001/api

## 本地 Agent 启动

```bash
cd /Users/yilu/Desktop/Root/projects/CCManager
npx pm2 start ecosystem.config.cjs

# 常用命令
npx pm2 status          # 查看状态
npx pm2 logs            # 查看日志
npx pm2 restart all     # 重启 agent
npx pm2 stop all        # 停止 agent
```

## 云服务器 Server 管理

```bash
ssh rack
cd ~/ccmanager
pm2 status              # 查看状态
pm2 logs ccm-server     # 查看日志
pm2 restart ccm-server  # 重启 server
```

## 开发命令

```bash
# 各包通用命令
npm run dev        # 开发模式
npm run build      # 编译
npm run typecheck  # 类型检查

# 修改 server 代码后同步到云服务器
npm run build
rsync -avz --exclude 'node_modules' packages/server/ rack:~/ccmanager/server/
ssh rack "cd ~/ccmanager && pm2 restart ccm-server"

# 修改 agent 代码后重启本地
npx pm2 restart ccm-agent
```

## 数据存储

- **云服务器数据库**: `~/ccmanager/data/ccmanager.db` (SQLite)
- **本地日志**: `/tmp/ccm-agent.log`
- **云服务器日志**: `/var/log/ccm-server.log`

## Agent 配置

配置文件 `packages/agent/agent.config.json`:

```json
{
  "agentId": "local-mac",
  "agentName": "Local MacBook",
  "managerUrl": "http://107.174.67.124:3001",
  "authToken": "dev-token-123",
  "executor": "local",
  "allowedPaths": ["/Users/yilu/Desktop/Root/projects/*"],
  "blockedPaths": ["/Users/yilu/.ssh", "/Users/yilu/.config"],
  "capabilities": ["local", "no-gpu"]
}
```

## 任务执行

- **并行执行**: 同一 agent 可同时执行多个任务
- **孤儿任务恢复**: 服务重启后自动恢复 `running` 状态的任务
- **继续对话**: `POST /api/tasks/:id/continue` 基于已完成任务的会话继续工作
