# CCManager

[English](./README.md) | **中文**

多设备 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 任务管理系统 — 通过集中式 Web UI 管理和执行多台设备上的 Claude Code 任务。

## 功能特性

- **多 Agent 架构** — 将 Claude Code 任务分发到多台机器（Linux、macOS 等）
- **实时 Web UI** — 在浏览器中监控任务状态、查看流式输出、管理项目
- **双执行模式** — 本地执行或在安全加固的 Docker 容器中隔离执行
- **Plan 模式** — 执行前审查 AI 生成的计划，支持批准/拒绝工作流
- **继续对话** — 基于已完成任务的会话上下文继续工作
- **语音输入** — 通过 Groq Whisper 集成实现语音转文字（可选）
- **安全机制** — 设备 Token 认证（CLI 管理，SHA-256 哈希存储）、CORS、速率限制、路径白名单、符号链接保护
- **Cloudflare 隧道** — 可选的公网访问，自动通过 Telegram 通知隧道 URL

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
| **Server** (`@ccmanager/server`) | Express API + Socket.IO + SQLite — 管理项目、任务队列和 WebSocket 事件 |
| **Web UI** (`@ccmanager/web`) | React 18 + Vite + TailwindCSS + TanStack Query — 实时更新的 SPA 前端 |
| **Agent** (`@ccmanager/agent`) | Socket.IO 客户端 + child_process — 连接服务器，spawn `claude` CLI 执行任务 |
| **ccmng** | 服务器端 CLI 工具，管理设备 Token |

## 前置要求

| 依赖 | 版本 | 用途 |
|------|------|------|
| [Node.js](https://nodejs.org/) | >= 18 | 运行时 |
| [pnpm](https://pnpm.io/) | 9.x | 包管理器 (`npm i -g pnpm@9`) |
| [PM2](https://pm2.keymetrics.io/) | >= 5 | 进程管理 (`npm i -g pm2`) |
| [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) | latest | 任务执行 (`npm i -g @anthropic-ai/claude-code`) |
| [Docker](https://www.docker.com/) | (可选) | 仅 Docker 执行模式需要 |

## 快速开始

### 服务器部署

```bash
git clone https://github.com/luyi256/CCManager.git
cd CCManager
bash setup-server.sh
```

安装脚本会自动安装依赖、构建项目、配置 PM2 并启动服务。

部署完成后，生成设备 Token 用于 Web UI 登录：

```bash
ccmng token create --name "My Computer"
# 复制 Token — 仅显示一次
```

在浏览器中打开 `http://localhost:3001`，粘贴 Token 登录。

### Agent 部署（客户端）

在每台需要执行任务的机器上：

```bash
git clone https://github.com/luyi256/CCManager.git
cd CCManager
bash setup-client.sh
```

安装脚本会引导你完成：
1. 安装依赖
2. 配置 Agent ID、名称和允许路径
3. 输入认证 Token（通过服务器上的 `ccmng agent create` 或 Web UI 设置页面生成）
4. 构建并通过 PM2 启动 Agent

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
ccmng token create --name "My Computer"
# 使用 Token 在 http://localhost:3001 登录
```

## 配置

### 环境变量 (`.env`)

复制 `.env.example` 为 `.env` 并配置：

```bash
# Claude Code 认证（二选一）
CLAUDE_CODE_OAUTH_TOKEN=clt_xxx    # Pro/Max 订阅 (OAuth)
ANTHROPIC_API_KEY=sk-ant-xxx       # 按用量付费 (API Key)

# 服务器
PORT=3001                          # 服务端口（默认 3001）
HOST=127.0.0.1                     # 监听地址
DATA_PATH=/path/to/data            # 数据目录（默认 ./data）

# 生产模式
SERVE_STATIC=true                  # 托管前端静态文件
STATIC_PATH=/path/to/web/dist     # 前端构建产物路径

# 语音转文字（可选）
GROQ_API_KEY=gsk_xxx               # 从 https://console.groq.com/keys 获取
GROQ_MODEL=whisper-large-v3-turbo  # 或 whisper-large-v3
```

### Agent 配置

配置文件：`~/.ccm-agent.json`（或 `--config=<path>` 指定）

参见 `packages/agent/agent.config.example.json` 获取完整示例。

```json
{
  "agentId": "my-agent",
  "agentName": "My Agent",
  "dataPath": "/path/to/data",
  "allowedPaths": ["/home/me/projects/*"],
  "blockedPaths": ["/home/me/.ssh"],
  "capabilities": ["linux", "gpu"]
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `agentId` | string | 是 | 唯一标识（仅限字母数字、`-`、`_`）|
| `agentName` | string | 是 | 显示名称 |
| `dataPath` | string | 是 | 数据目录路径（本地路径或 GitHub raw URL）|
| `authToken` | string | 自动 | 首次运行时交互输入，自动保存到配置 |
| `allowedPaths` | string[] | 是 | 允许操作的路径 glob |
| `blockedPaths` | string[] | 否 | 禁止访问的路径 |
| `capabilities` | string[] | 否 | 能力标签，用于任务路由（如 `gpu`、`linux`）|
| `dockerConfig` | object | 否 | Docker 容器配置（见下方）|

Agent 从 `<dataPath>/server-url.txt` 读取服务器 URL。远程 Agent 可使用 GitHub raw URL 作为 `dataPath`（如 `https://raw.githubusercontent.com/user/data-repo/main`）。连接失败时自动重新读取，支持隧道 URL 动态变更。

### Docker 执行模式

在 Web UI 中按项目配置，或在 Agent 配置中设置：

```json
{
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

每个任务在隔离容器中运行：
- 项目目录挂载到 `/workspace`
- Claude CLI 凭证自动注入
- 安全加固：`--cap-drop=ALL` + 最小权限 + `--no-new-privileges`

构建运行镜像：`docker build -t ccmanager-runner:latest packages/agent/docker/`

## 设备 Token 管理

设备 Token 通过服务器端 `ccmng` CLI 管理，无公开注册端点。

```bash
# 创建 Token（仅显示一次，请立即复制）
ccmng token create --name "MacBook Pro"

# 查看已注册设备
ccmng token list

# 吊销设备 Token
ccmng token revoke <id>
```

所有 API 和 WebSocket 连接都需要 Token 认证：
- **REST API**：`Authorization: Bearer <TOKEN>` 请求头
- **WebSocket（UI）**：`auth: { token }` 连接参数
- **WebSocket（Agent）**：使用 `agentAuthToken`（在设置页面配置）
- **例外**：`GET /api/health` 免认证

## 任务生命周期

```
pending → running → completed / completed_with_warnings / failed / cancelled

运行中可进入：
  running → waiting              (等待外部条件)
  running → waiting_permission   (等待用户授权)
  running → plan_review          (等待计划确认)
```

## 开发

```bash
pnpm install                  # 安装依赖

pnpm run dev                  # 启动 server (3001) + web (5173)，支持 HMR
pnpm run dev:server           # 仅 server
pnpm run dev:web              # 仅 web

pnpm run build                # 构建所有包
pnpm run build:server         # 仅构建 server
pnpm run build:web            # 仅构建 web

pnpm run lint                 # 代码检查
pnpm run typecheck            # 类型检查
```

### 部署

```bash
pnpm run build && pm2 restart ccm-server
```

### Cloudflare 隧道（可选）

无需端口转发即可远程访问，使用内置隧道脚本：

1. 安装 [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
2. 在 `<DATA_PATH>/secrets.env` 中配置 Telegram 通知：
   ```bash
   TELEGRAM_BOT_TOKEN="your-bot-token"
   TELEGRAM_CHAT_ID="your-chat-id"
   ```
3. 通过 PM2 启动：`pm2 start ecosystem.config.cjs`

隧道 URL 自动写入 `<DATA_PATH>/server-url.txt`，供远程 Agent 发现。

## 安全

- **设备 Token 认证**：CLI 管理，SHA-256 哈希存储，无公开注册
- **Agent Token 认证**：在 Web UI 设置页面管理，每个 Agent 独立 Token
- **CORS**：仅同源请求（`origin: false`）
- **速率限制**：100 请求/分钟/IP
- **路径白名单**：Agent 仅可操作 `allowedPaths` 内的路径，含符号链接检查
- **Docker 沙箱**：`--cap-drop=ALL` + 最小权限 + `--no-new-privileges`
- **Plan 模式**：任务可设为计划模式，需用户确认后执行

## 许可证

MIT
