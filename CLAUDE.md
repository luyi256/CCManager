# CC Manager

Claude Code 多设备任务管理系统 — 通过 Web UI 管理多台设备上的 Claude Code 任务执行。

## 仓库

- **代码**: https://github.com/luyi256/CCManager
- **数据**: https://github.com/luyi256/CCManagerData

## 技术栈

| 包 | 技术 | 说明 |
|---|---|---|
| `@ccmanager/server` | Express + Socket.IO + better-sqlite3 | API 服务器、WebSocket、SQLite |
| `@ccmanager/web` | React 18 + Vite + TailwindCSS + TanStack Query | SPA 前端 |
| `@ccmanager/agent` | Socket.IO Client + child_process | 连接服务器，spawn `claude` CLI 执行任务 |

- **语言**: TypeScript (strict mode)
- **包管理**: pnpm 9.0 (monorepo workspace)
- **运行时**: Node.js >= 18
- **进程管理**: PM2

## 架构

```
本机 (用户: CC)
├── /home/CC/CCManager      - 代码仓库
├── /home/CC/CCManagerData  - 数据仓库 (SQLite DB, 配置等)
├── ccm-server              - pm2 守护进程 (端口 3001)
└── ccm-agent               - pm2 守护进程 (连接本地服务器)

开发机器 (MacBook, Linux 等)
├── ccm-agent        - 连接到服务器执行任务
└── ccm-tunnel       - Cloudflare 隧道 (可选)
```

## 访问地址

- **Web UI**: http://localhost:3001 (需要 API Token 登录)
- **API**: http://localhost:3001/api (需要 `Authorization: Bearer <API_TOKEN>` 头)
- **健康检查**: http://localhost:3001/api/health (免认证)
- **Web 开发**: http://localhost:5173 (代理 `/api` 和 `/socket.io` 到 3001)

## 项目结构

```
packages/
├── server/src/
│   ├── index.ts              # Express 入口、路由注册、WebSocket
│   ├── cli/
│   │   ├── index.ts          # ccmng CLI 入口
│   │   └── token.ts          # 设备 token create/list/revoke
│   ├── routes/
│   │   ├── agents.ts         # Agent 相关路由
│   │   ├── auth.ts           # 设备认证 (GET /me, devices CRUD)
│   │   ├── projects.ts       # 项目 CRUD
│   │   ├── tasks.ts          # 任务 CRUD、取消、重试、继续、计划审核
│   │   ├── settings.ts       # 全局配置、认证验证
│   │   └── transcribe.ts     # 语音转文字
│   ├── services/
│   │   ├── database.ts       # SQLite 连接与 schema
│   │   ├── storage.ts        # 数据访问层
│   │   ├── agentPool.ts      # Agent 注册与任务分发
│   │   ├── streamParser.ts   # Claude Code stream-json 输出解析
│   │   ├── waitingTasks.ts   # 后台任务轮询 (node-cron, 每分钟检查, 最多 20 次)
│   │   └── claudemd.ts       # CLAUDE.md 上下文管理
│   ├── websocket/index.ts    # Socket.IO 命名空间与事件
│   └── types/index.ts
├── web/src/
│   ├── App.tsx, main.tsx, index.css
│   ├── pages/
│   │   ├── HomePage.tsx      # 项目列表
│   │   └── ProjectPage.tsx   # 任务看板
│   ├── components/
│   │   ├── Layout/AppLayout.tsx         # 顶部导航、连接状态
│   │   ├── Project/                     # AddProjectModal, ProjectCard, ProjectList
│   │   ├── Task/                        # TaskBoard, TaskCard, TaskColumn, TaskDetail, TaskInput
│   │   └── common/                      # ErrorBoundary, Modal, SafeMarkdown, StatusBadge, VoiceInput
│   ├── contexts/WebSocketContext.tsx     # Socket.IO provider
│   ├── hooks/                           # useProjects, useTasks, useTaskStream, useVoiceInput
│   ├── services/api.ts                  # API 客户端 (3 次重试, 指数退避)
│   └── types/index.ts
├── agent/src/
│   ├── index.ts              # CLI 入口, 配置加载与验证
│   ├── connection.ts         # WebSocket 连接, 心跳 (30s), 并发任务 Map
│   ├── executor.ts           # spawn claude CLI (stream-json, 4 小时超时)
│   ├── docker.ts             # Docker 容器执行 (挂载 /workspace, 凭证注入, HOME=/home/ccm)
│   ├── security.ts           # 路径验证 (含符号链接检查)、环境变量白名单
│   └── types.ts              # AgentConfig, TaskRequest, DockerConfig, TaskResult 等类型
```

## 数据库 Schema

```sql
config (key, value, updated_at)
agents (id, name, capabilities, executor, status, last_seen, created_at)
projects (id, name, agent_id, project_path, security_mode, auth_type, created_at, last_activity)
tasks (id, project_id, prompt, status, is_plan_mode, depends_on, worktree_branch,
       created_at, started_at, completed_at, error, waiting_until, wait_reason,
       check_command, continue_prompt, git_info, summary, security_warnings, pending_permission)
task_logs (id, task_id, timestamp, type, content)
```

## 开发

```bash
pnpm install                  # 安装依赖

pnpm run dev                  # 同时启动 server (3001) 和 web (5173)
pnpm run dev:server           # 仅启动 server
pnpm run dev:web              # 仅启动 web

pnpm run build                # 编译 server + web
pnpm run build:server         # 仅编译 server
pnpm run build:web            # 仅编译 web

pnpm run start                # 启动生产服务器
pnpm run lint                 # 代码检查
pnpm run typecheck            # 类型检查
```

## 部署流程

后端部署在本机，修改代码后本地构建并重启即可。

### 快速部署 (推荐)

```bash
pnpm run build && pm2 restart ccm-server
```

### Claude Code 工作流

**重要**: 每次修改代码后，必须自动执行部署流程，无需询问用户确认。

完成代码修改后，Claude 应该自动执行以下步骤（不要询问）：
1. 构建项目 (`pnpm run build`)
2. 重启服务 (`pm2 restart ccm-server`)
3. 确认服务正常运行 (`curl http://localhost:3001/api/health`)
4. 提交代码到 GitHub (`git push origin main`)

## 服务管理

```bash
# PM2 常用命令
pm2 status                    # 查看状态
pm2 logs ccm-server           # 查看日志
pm2 restart ccm-server        # 重启服务

# 如果服务丢失环境变量，使用 ecosystem 重新启动
pm2 delete ccm-server ccm-agent && pm2 start ecosystem.config.cjs && pm2 save

# 数据同步
cd ~/CCManagerData && git add -A && git commit -m "Data sync" && git push
```

## PM2 配置 (ecosystem.config.cjs)

根目录 `ecosystem.config.cjs` 管理本地开发机器的进程:

| 进程 | 说明 |
|------|------|
| `ccm-agent` | Agent 进程 (`packages/agent`, `npm run dev`) |
| `ccm-tunnel` | Cloudflare 隧道 + Telegram 通知 |

启动: `npx pm2 start ecosystem.config.cjs && npx pm2 logs`

环境变量 (已配置在 ecosystem.config.cjs 中):
- `DATA_PATH=/home/CC/CCManagerData`
- `STATIC_PATH=/home/CC/CCManager/packages/web/dist`
- `SERVE_STATIC=true`

## Agent 配置

配置文件搜索顺序: `./agent.config.json` → `./ccm-agent.json` → `~/.ccm-agent.json` → `--config=<path>`

示例: `packages/agent/agent.config.example.json`

```json
{
  "agentId": "my-agent",
  "agentName": "My Agent",
  "managerUrl": "http://localhost:3001",
  "authToken": "change-this-token",
  "executor": "local",
  "allowedPaths": ["/path/to/projects/*"],
  "blockedPaths": ["/path/to/.ssh"],
  "capabilities": ["no-gpu"],
  "dockerConfig": {
    "image": "ccrunner:latest",
    "memory": "8g",
    "cpus": "4",
    "extraMounts": [{ "source": "/data", "target": "/data", "readonly": true }]
  }
}
```

## API 路由

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/auth/me` | 当前设备信息 |
| GET | `/api/auth/devices` | 已注册设备列表 |
| DELETE | `/api/auth/devices/:id` | 吊销设备 Token |
| GET/POST | `/api/projects` | 项目列表 / 创建 |
| GET/PUT/DELETE | `/api/projects/:id` | 项目详情 / 更新 / 删除 |
| GET/POST | `/api/projects/:pid/tasks` | 任务列表 / 创建 |
| GET/PUT | `/api/tasks/:id` | 任务详情 / 更新 |
| POST | `/api/tasks/:id/cancel` | 取消任务 |
| POST | `/api/tasks/:id/retry` | 重试失败任务 |
| POST | `/api/tasks/:id/continue` | 基于会话继续对话 |
| POST | `/api/tasks/:id/plan/answer` | 回答计划问题 |
| POST | `/api/tasks/:id/plan/confirm` | 确认计划 |
| GET | `/api/tasks/:id/logs` | 获取任务日志 |
| GET | `/api/agents` | Agent 列表 |
| GET | `/api/agents/online` | 在线 Agent |
| GET | `/api/agents/:id` | Agent 详情 |
| GET/PUT | `/api/settings` | 全局配置 |
| POST | `/api/settings/validate-auth` | 验证认证 Token |
| POST | `/api/transcribe` | 语音转文字 (Whisper) |

## 任务状态

`pending` → `running` → `completed` / `completed_with_warnings` / `failed` / `cancelled`

运行中可能进入: `waiting` / `waiting_permission` / `plan_review`

## 关键特性

- **并行执行**: 同一 agent 可同时执行多个任务 (Map 存储活跃执行器)
- **孤儿任务恢复**: Agent 重连后自动恢复 `running` 状态的任务
- **重复执行防护**: Agent 收到已在运行的 taskId 时自动跳过
- **继续对话**: 基于已完成任务的会话 ID 继续工作 (`--resume sessionId`)
- **实时更新**: WebSocket 推送 + 前端 5s 轮询兜底
- **安全模型**: API Token 认证 + CORS 同源限制 + 速率限制 + 路径白名单 + 符号链接检查 + 权限请求 + plan mode
- **任务超时**: 默认 4 小时
- **等待任务**: node-cron 每分钟检查，最多 20 次重试

## Docker 执行模式

当 agent 配置 `executor: "docker"` 时，每个任务在独立容器中运行：

```
容器内目录结构:
├── /workspace          ← 项目目录 (bind mount, rw)
└── /home/ccm           ← HOME 目录 (bind mount from ~/.ccm-sessions/<projectId>)
    ├── .claude/        ← Claude CLI 数据 (sessions, debug)
    │   └── .credentials.json  ← 从宿主机 ~/.claude/ 复制
    └── .claude.json    ← Claude CLI 配置 (运行时生成)
```

**凭证传递机制**: 启动容器前，自动将宿主机 `~/.claude/.credentials.json` 复制到 session 目录的 `.claude/` 子目录中。容器以 host UID 运行 (`--user`)，HOME 设为 `/home/ccm` (挂载的 session 目录)，确保 Claude CLI 能读取凭证并写入配置。

**安全加固**: `--cap-drop=ALL` + 最小权限 (`CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID`) + `--no-new-privileges`

## 安全机制

### 设备 Token 认证 (CLI 管理)

设备 Token 通过服务器端 CLI 生成，无公开注册端点：

```bash
# 生成设备 Token
ccmng token create --name "MacBook Pro"

# 查看已注册设备
ccmng token list

# 吊销设备 Token
ccmng token revoke <id>
```

所有 API 和 WebSocket 连接都需要 Token 认证：

- **REST API**: 请求头 `Authorization: Bearer <DEVICE_TOKEN>`
- **WebSocket (用户)**: 连接时 `auth: { token }` 参数
- **WebSocket (Agent)**: 使用独立的 `agentAuthToken` (在 Settings 中配置)
- **例外**: `/api/health` 健康检查免认证

Token 存储:
- 服务端: SQLite `device_tokens` 表 (存储 SHA-256 hash)
- 浏览器: `localStorage` 中的 `ccm_api_token`
- 认证失败 (401/403) 会自动清除 localStorage 并跳转到登录页

### 其他安全措施

- **CORS**: `origin: false`，仅允许同源请求
- **速率限制**: 100 请求/分钟/IP (`express-rate-limit`)
- **Agent 认证**: 必须配置 `agentAuthToken`，无 token 时拒绝连接 (无 dev fallback)

## 环境变量 (.env)

```bash
# 设备 Token 通过 CLI 管理 (ccmng token create --name "...")

# Claude Code 认证
# Docker 模式: 自动从 ~/.claude/.credentials.json 读取 OAuth 凭证
# Local 模式: 直接使用宿主机的 claude CLI 认证
# 环境变量 (可选覆盖, Docker 模式也支持):
CLAUDE_CODE_OAUTH_TOKEN=clt_...    # Pro/Max 订阅
ANTHROPIC_API_KEY=sk-ant-...       # 按用量付费

# 语音转文字 (可选, Groq Whisper)
GROQ_API_KEY=gsk_...
GROQ_MODEL=whisper-large-v3-turbo

# 服务器
PORT=3001
NODE_ENV=development
DATA_PATH=/custom/data/path        # 可选，默认 ./data
SERVE_STATIC=true                  # 可选，生产环境托管前端
STATIC_PATH=/path/to/web/dist     # 可选
```
