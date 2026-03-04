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

| 组件 | 说明 |
|------|------|
| **Server** | API 服务器 + Web 前端，管理项目和任务队列 |
| **Agent** | 连接 Server 的客户端，在本地 spawn `claude` CLI 执行任务 |
| **Web UI** | 浏览器访问，实时查看任务状态和输出 |
| **ccmng** | 服务器端 CLI 工具，管理设备 Token |

## 快速开始

### 前置要求

| 依赖 | 版本 | 说明 |
|------|------|------|
| Node.js | >= 18 | 运行时 |
| pnpm | 9.x | 包管理器 (`npm i -g pnpm@9`) |
| PM2 | >= 5 | 进程管理 (`npm i -g pm2`) |
| Claude CLI | latest | Agent 执行需要 (`npm i -g @anthropic-ai/claude-code`) |
| Docker | (可选) | 仅 Docker executor 模式需要 |

### 一键部署

#### Server 端

```bash
git clone https://github.com/luyi256/CCManager.git
cd CCManager
bash setup-server.sh
```

部署完成后，生成设备 Token 用于 Web UI 登录：

```bash
ccmng token create --name "我的电脑"
```

#### Client 端 (Agent)

```bash
git clone https://github.com/luyi256/CCManager.git
cd CCManager
bash setup-client.sh
```

### 手动安装

```bash
# 1. 安装依赖
pnpm install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env 填入必要配置

# 3. 构建
pnpm run build

# 4. 启动服务
pm2 start packages/server/dist/index.js --name ccm-server
pm2 save

# 5. 生成设备 Token
ccmng token create --name "我的电脑"
# 用输出的 Token 在浏览器登录 http://localhost:3001
```

## 设备 Token 管理

设备 Token 通过服务器端 `ccmng` CLI 管理，无公开注册端点：

```bash
# 创建 Token（仅显示一次，请立即复制）
ccmng token create --name "MacBook Pro"

# 查看所有已注册设备
ccmng token list

# 吊销指定设备
ccmng token revoke <id>
```

用生成的 Token 在 Web UI 登录页粘贴即可。

## Agent 配置

配置文件：`~/.ccm-agent.json`（或 `--config=<path>` 指定）

```json
{
  "agentId": "my-agent",
  "agentName": "My Agent",
  "managerUrl": "http://your-server:3001",
  "managerUrlSource": "https://raw.githubusercontent.com/your-org/CCManagerData/main/tunnel-url.txt",
  "authToken": "在 Settings 页面生成的 agent token",
  "executor": "local",
  "allowedPaths": ["/home/me/projects/*"],
  "blockedPaths": ["/home/me/.ssh"],
  "capabilities": ["linux", "gpu"]
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `agentId` | string | Yes | 唯一标识，仅限字母数字和 `-_` |
| `agentName` | string | Yes | 显示名称 |
| `managerUrl` | string | Yes | Server 地址 |
| `managerUrlSource` | string | No | 动态 URL 源（如 GitHub raw URL），连接失败时自动拉取最新地址 |
| `authToken` | string | Yes | Agent 认证 Token（Web UI Settings 页面生成） |
| `executor` | string | Yes | `local` 或 `docker` |
| `allowedPaths` | string[] | Yes | 允许操作的路径，支持 glob |
| `blockedPaths` | string[] | No | 禁止访问的路径 |
| `capabilities` | string[] | No | 能力标签，用于任务路由 |
| `dockerConfig` | object | docker 时必填 | Docker 容器配置 |

### Docker 模式

```json
{
  "executor": "docker",
  "dockerConfig": {
    "image": "ccmanager-runner:latest",
    "memory": "8g",
    "cpus": "4",
    "extraMounts": [
      { "source": "/data", "target": "/data", "readonly": true }
    ]
  }
}
```

每个任务在独立容器中运行，项目目录挂载到 `/workspace`，Claude CLI 凭证自动注入。容器使用 `--cap-drop=ALL` + 最小权限安全加固。

## 环境变量

```bash
# Claude Code 认证 (二选一)
CLAUDE_CODE_OAUTH_TOKEN=clt_xxx    # Pro/Max 订阅
ANTHROPIC_API_KEY=sk-ant-xxx       # 按用量付费

# 服务器
PORT=3001                          # 默认端口
HOST=127.0.0.1                     # 监听地址
DATA_PATH=/path/to/data            # 数据目录 (默认 ./data)

# 生产模式
SERVE_STATIC=true                  # 托管前端静态文件
STATIC_PATH=/path/to/web/dist     # 前端构建产物路径

# 语音转文字 (可选)
GROQ_API_KEY=gsk_xxx
GROQ_MODEL=whisper-large-v3-turbo
```

## 常用命令

```bash
# 设备 Token
ccmng token create --name "设备名"
ccmng token list
ccmng token revoke <id>

# 开发
pnpm run dev                  # server:3001 + web:5173 (HMR)
pnpm run build                # 构建所有包
pnpm run typecheck            # 类型检查

# 部署
pnpm run build && pm2 restart ccm-server

# 日志
pm2 logs ccm-server
pm2 logs ccm-agent
```

## 安全

- **设备 Token 认证**：Token 通过服务器端 CLI 生成（SHA-256 hash 存储），无公开注册端点
- **Agent Token 认证**：在 Web UI Settings 页面管理，每个 Agent 独立 Token
- **CORS 同源限制**：`origin: false`，仅允许同源请求
- **速率限制**：100 请求/分钟/IP
- **路径白名单**：Agent 仅可操作 `allowedPaths` 内的项目，含符号链接检查
- **Docker 沙箱**：`--cap-drop=ALL` + 最小权限 + `--no-new-privileges`
- **Plan Mode**：任务可设为计划模式，需用户确认后执行

## API

所有请求需要 `Authorization: Bearer <TOKEN>` 头（`/api/health` 除外）。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/auth/me` | 当前设备信息 |
| GET | `/api/auth/devices` | 已注册设备列表 |
| DELETE | `/api/auth/devices/:id` | 吊销设备 Token |
| GET/POST | `/api/projects` | 项目列表 / 创建 |
| GET/PUT/DELETE | `/api/projects/:id` | 项目 CRUD |
| GET/POST | `/api/projects/:pid/tasks` | 任务列表 / 创建 |
| GET/PUT | `/api/tasks/:id` | 任务详情 / 更新 |
| POST | `/api/tasks/:id/cancel` | 取消任务 |
| POST | `/api/tasks/:id/retry` | 重试任务 |
| POST | `/api/tasks/:id/continue` | 继续对话 |
| POST | `/api/tasks/:id/plan/answer` | 回答计划问题 |
| POST | `/api/tasks/:id/plan/confirm` | 确认计划 |
| GET | `/api/tasks/:id/logs` | 获取任务日志 |
| GET | `/api/agents` | Agent 列表 |
| GET | `/api/agents/online` | 在线 Agent |
| GET | `/api/agents/:id` | Agent 详情 |
| GET/PUT | `/api/settings` | 全局配置 |
| POST | `/api/transcribe` | 语音转文字 |

## 任务生命周期

```
pending → running → completed / completed_with_warnings / failed / cancelled

运行中可进入:
  running → waiting            (等待外部条件)
  running → waiting_permission (等待用户授权)
  running → plan_review        (等待计划确认)
```

## 项目结构

```
packages/
├── server/         Express API + Socket.IO + SQLite
│   └── src/
│       ├── index.ts             # 入口
│       ├── cli/                 # ccmng CLI (token 管理)
│       ├── routes/              # REST API 路由
│       ├── services/            # DB, Agent Pool, Stream Parser
│       └── websocket/           # WebSocket 事件
├── web/            React 18 + Vite + TailwindCSS
│   └── src/
│       ├── pages/               # 页面 (Home, Project, Login, Settings)
│       ├── components/          # UI 组件
│       ├── hooks/               # 自定义 Hooks
│       └── contexts/            # WebSocket Context
└── agent/          Socket.IO Client + child_process
    └── src/
        ├── index.ts             # CLI 入口
        ├── connection.ts        # WebSocket 连接
        ├── executor.ts          # Claude CLI 执行器
        ├── docker.ts            # Docker 容器执行
        └── security.ts          # 路径安全校验
```

## License

MIT
