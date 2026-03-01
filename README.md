# CCManager

Claude Code 多设备任务管理系统 — 通过 Web UI 管理多台设备上的 Claude Code 任务执行。

## 架构

```
┌──────────────────────────────────┐
│  Server (Express + Socket.IO)    │    ← 中心服务器
│  Web UI (React SPA)              │
│  SQLite Database                 │
│  Port: 3001                      │
└────────┬────────────┬────────────┘
         │ WebSocket  │ WebSocket
    ┌────┴────┐  ┌────┴────┐
    │ Agent A │  │ Agent B │           ← 分布式 Agent
    │ (Linux) │  │ (macOS) │
    │ Docker  │  │ Local   │
    └─────────┘  └─────────┘
```

- **Server**: API 服务器 + Web 前端，管理项目和任务队列
- **Agent**: 连接 Server 的客户端，在本地 spawn `claude` CLI 执行任务
- **Web UI**: 浏览器访问，实时查看任务状态和输出

## 快速开始

### 前置要求

| 依赖 | 版本 | 说明 |
|------|------|------|
| Node.js | >= 18 | 运行时 |
| pnpm | 9.x | 包管理器 (`npm i -g pnpm@9`) |
| PM2 | >= 5 | 进程管理 (`npm i -g pm2`) |
| Claude CLI | latest | Agent 执行任务需要 (`npm i -g @anthropic-ai/claude-code`) |
| Docker | (可选) | 仅 Docker executor 模式需要 |

### 一键部署

#### Server 端

```bash
git clone https://github.com/luyi256/CCManager.git
cd CCManager
bash setup-server.sh
```

脚本会自动完成：检查依赖 → 安装 npm 包 → 创建 `.env` → 构建项目 → PM2 启动服务

#### Client 端 (Agent)

```bash
git clone https://github.com/luyi256/CCManager.git
cd CCManager
bash setup-client.sh
```

脚本会自动完成：检查依赖 → 安装 npm 包 → 交互式创建 Agent 配置 → 构建 Docker 镜像 (如需) → PM2 启动 Agent

## 手动安装

### 1. 安装依赖

```bash
pnpm install
```

### 2. 配置 Server

复制并编辑环境变量：

```bash
cp .env.example .env
```

`.env` 关键配置：

```bash
# Claude Code 认证 (二选一)
CLAUDE_CODE_OAUTH_TOKEN=clt_xxx    # Pro/Max 订阅
ANTHROPIC_API_KEY=sk-ant-xxx       # 按用量付费

# 服务端口
PORT=3001

# 数据目录 (可选，默认 ./data)
DATA_PATH=/path/to/data

# 生产环境：内置前端静态文件
SERVE_STATIC=true
STATIC_PATH=/path/to/packages/web/dist
```

### 3. 配置 Agent

创建配置文件（以下路径任选其一）：

- `./agent.config.json` (agent 包目录下)
- `./ccm-agent.json`
- `~/.ccm-agent.json`
- `--config=<path>` (命令行指定)

```json
{
  "agentId": "my-agent",
  "agentName": "My Agent",
  "managerUrl": "http://your-server:3001",
  "authToken": "change-this-token",
  "executor": "local",
  "allowedPaths": ["/home/me/projects/*"],
  "blockedPaths": ["/home/me/.ssh"],
  "capabilities": ["linux", "gpu"]
}
```

Docker 模式需额外配置：

```json
{
  "executor": "docker",
  "dockerConfig": {
    "image": "ccmanager-runner:latest",
    "memory": "8g",
    "cpus": "4"
  }
}
```

### 4. 构建 & 运行

```bash
# 构建
pnpm run build

# 开发模式 (server + web HMR)
pnpm run dev

# 生产模式
pm2 start packages/server/dist/index.js --name ccm-server
pm2 start ecosystem.config.cjs --only ccm-agent
pm2 save
```

## Agent 配置参考

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `agentId` | string | Yes | 唯一标识，仅限字母数字和 `-_` |
| `agentName` | string | Yes | 显示名称 |
| `managerUrl` | string | Yes | Server 地址，如 `http://host:3001` |
| `authToken` | string | Yes | 认证 Token，需与 Server 配置一致 |
| `executor` | string | Yes | `local` 或 `docker` |
| `allowedPaths` | string[] | Yes | 允许操作的路径，支持 glob |
| `blockedPaths` | string[] | No | 禁止访问的路径 |
| `capabilities` | string[] | No | Agent 能力标签，用于任务路由 |
| `dockerConfig` | object | docker 时必填 | Docker 容器配置 |

## 常用命令

```bash
# 服务管理
pm2 status                    # 查看所有进程状态
pm2 logs ccm-server           # 查看 Server 日志
pm2 logs ccm-agent            # 查看 Agent 日志
pm2 restart ccm-server        # 重启 Server
pm2 restart ccm-agent         # 重启 Agent

# 开发
pnpm run dev                  # 启动开发模式 (server:3001 + web:5173)
pnpm run dev:server           # 仅启动 Server
pnpm run dev:web              # 仅启动 Web
pnpm run build                # 构建所有包
pnpm run typecheck            # 类型检查

# 快速重部署
pnpm run build && pm2 restart ccm-server
```

## 项目结构

```
packages/
├── server/         Express API + Socket.IO + SQLite
│   └── src/
│       ├── index.ts             # 入口
│       ├── routes/              # REST API 路由
│       ├── services/            # 业务逻辑 (DB, Agent Pool, Stream Parser)
│       └── websocket/           # WebSocket 事件处理
├── web/            React 18 + Vite + TailwindCSS
│   └── src/
│       ├── pages/               # 页面组件
│       ├── components/          # UI 组件
│       ├── hooks/               # 自定义 Hooks
│       └── contexts/            # WebSocket Context
└── agent/          Socket.IO Client + child_process
    ├── src/
    │   ├── index.ts             # CLI 入口, 配置加载
    │   ├── connection.ts        # WebSocket 连接管理
    │   ├── executor.ts          # Claude CLI 执行器
    │   ├── docker.ts            # Docker 容器执行
    │   └── security.ts          # 路径安全校验
    └── docker/
        └── Dockerfile           # Docker 执行环境镜像
```

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET/POST | `/api/projects` | 项目列表 / 创建 |
| GET/PUT/DELETE | `/api/projects/:id` | 项目 CRUD |
| GET/POST | `/api/projects/:pid/tasks` | 任务列表 / 创建 |
| GET/PUT | `/api/tasks/:id` | 任务详情 / 更新 |
| POST | `/api/tasks/:id/cancel` | 取消任务 |
| POST | `/api/tasks/:id/retry` | 重试任务 |
| POST | `/api/tasks/:id/continue` | 继续对话 |
| GET | `/api/agents` | Agent 列表 |
| GET | `/api/agents/online` | 在线 Agent |
| GET/PUT | `/api/settings` | 全局配置 |

## 任务生命周期

```
pending → running → completed
                  → completed_with_warnings
                  → failed
                  → cancelled

运行中可进入:
  running → waiting            (等待外部条件)
  running → waiting_permission (等待用户授权)
  running → plan_review        (等待计划确认)
```

## License

MIT
