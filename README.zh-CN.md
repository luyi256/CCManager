# CCManager

[English](./README.md) | **中文**

CCManager 是一个自托管的多设备编程 Agent 控制平台，由对话式 Web UI、Express/Socket.IO 服务端和轻量执行 Agent 组成，可统一管理多台机器上的本地编程 CLI。

<p align="center">
  <img src="docs/screenshots/demo.gif" alt="CCManager 当前界面演示" width="960">
</p>

## 当前能力

- **对话式项目工作区** — 每个项目拥有持久会话侧栏、实时执行时间线、追问输入框、状态操作、摘要和 Runner/模型信息。
- **多 Runner 支持** — 每个任务或追问均可选择 Claude、Claude Grok、Codex、Qwen、tClaude 或 tCodex。
- **Agent 自动发现模型** — Agent 启动时探测本机已安装 CLI 和可用模型，服务端在派发前校验模型选择。
- **可靠实时输出** — 使用带版本的流事件、持久化快照、断线回放和去重；支持工具调用折叠、Markdown/GFM、公式、表格和代码块。
- **接管已有 CLI 会话** — 浏览 Claude、Claude Grok、Codex、Qwen、tClaude、tCodex 和 Docker Claude 的活跃或历史会话，搜索消息、查看合并链，并用原 Runner 接入或继续。
- **任务编排** — 支持并行任务、依赖关系、取消、重试、等待状态、Plan Mode、权限确认，以及 Agent 重连后的孤儿任务恢复。
- **富输入** — 新任务和追问都可粘贴或上传图片，也可通过兼容 OpenAI 的 Whisper 接口进行语音输入。
- **隔离执行** — 普通 Claude 可在本机或安全加固的 Docker 中运行；也可为每个任务创建 Git worktree，并在界面中合并或清理。
- **多设备安全** — 浏览器与 Agent 使用独立哈希 Token，并包含同源 CORS、限流、路径白/黑名单和符号链接检查。
- **支持 `/ccm` 子路径部署** — 生产 SPA、API、WebSocket 和 PWA 资源均支持部署在反向代理的 `/ccm` 路径下。

## 最新截图

以下截图由当前生产构建配合虚构演示数据自动生成，不包含真实项目、路径、会话或 Token。

<table>
  <tr>
    <td align="center"><b>项目列表</b></td>
    <td align="center"><b>新建对话</b></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/projects.png" alt="项目列表" width="500"></td>
    <td><img src="docs/screenshots/new-conversation.png" alt="新建对话输入区" width="500"></td>
  </tr>
  <tr>
    <td align="center"><b>实时执行对话</b></td>
    <td align="center"><b>CLI 会话浏览器</b></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/conversation.png" alt="实时编程对话" width="500"></td>
    <td><img src="docs/screenshots/cli-sessions.png" alt="CLI 会话浏览器" width="500"></td>
  </tr>
  <tr>
    <td align="center" colspan="2"><b>设备与 Agent 管理</b></td>
  </tr>
  <tr>
    <td colspan="2"><img src="docs/screenshots/settings.png" alt="设备与 Agent 管理" width="1000"></td>
  </tr>
</table>

<details>
<summary><b>移动端视图</b></summary>
<br>
<table>
  <tr>
    <td align="center"><b>项目列表</b></td>
    <td align="center"><b>对话输入区</b></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/mobile-projects.png" alt="移动端项目列表" width="280"></td>
    <td><img src="docs/screenshots/mobile-conversation.png" alt="移动端对话输入区" width="280"></td>
  </tr>
</table>
</details>

## 架构

```text
浏览器 / 已安装 PWA
        │ HTTPS + Socket.IO
        ▼
┌───────────────────────────────────────┐
│ @ccmanager/server                    │
│ Express API · Socket.IO · SQLite     │
│ 在 /ccm 下托管 @ccmanager/web        │
└───────────────┬───────────────────────┘
                │ 经过认证的 Agent Socket
        ┌───────┴────────┬──────────────────┐
        ▼                ▼                  ▼
   Linux Agent      macOS Agent        更多 Agent
   本机/Docker      本机执行           并发执行
        │                │                  │
        └──── Claude / Claude Grok / Codex / Qwen / tClaude / tCodex
```

| 包 | 作用 |
|---|---|
| `@ccmanager/server` | REST API、Socket.IO、任务派发、SQLite、流回放、会话路由和 Token CLI |
| `@ccmanager/web` | React 18 SPA、对话工作区、会话浏览器、项目/设备/Agent 管理和 PWA |
| `@ccmanager/agent` | 将机器接入服务端，发现本地 Runner/模型，启动任务、上报事件并读取受支持 CLI 的本机会话 |
| `ccmng` CLI | 创建/吊销浏览器与 Agent Token，并轮换备份 SQLite |

## Runner 支持

Runner 是否可用取决于每台 Agent 机器。Agent 启动时会探测已安装 CLI，并把模型目录上报到服务端。

| 界面名称 | 本地命令 | 模型来源 | 执行位置 |
|---|---|---|---|
| Claude | `claude` | Claude CLI 帮助与配置 | 本机或 Docker |
| Claude Grok | `claude-grok` | `~/.config/distill-grok/claude-settings.json` | 宿主机 |
| Codex | `codex` | Codex 模型目录与配置 | 宿主机 |
| Qwen | `qwen` | 检测 CLI，可使用默认模型 | 宿主机 |
| tClaude | `tclaude` | CLI/本地 daemon 模型目录 | 宿主机 |
| tCodex | `tcodex` | tCodex 模型目录与配置 | 宿主机 |

当前 Docker 执行只封装普通 `claude` Runner。即使项目选择 Docker，其余 Runner 仍使用宿主机上的 CLI 与凭证。

## 前置要求

| 依赖 | 版本 | 用途 |
|---|---:|---|
| [Node.js](https://nodejs.org/) | `>= 18` | 运行时 |
| [pnpm](https://pnpm.io/) | `9.x` | Monorepo 包管理 |
| [PM2](https://pm2.keymetrics.io/) | `>= 5` | 推荐的进程管理器 |
| 至少一个受支持的编程 CLI | 当前兼容版本 | 每台 Agent 上执行任务 |
| [Docker](https://www.docker.com/) | 可选 | 普通 Claude 容器执行 |

请在 Agent 所在机器上完成各 Runner 的登录。Docker 模式的 Claude 可复用 `~/.claude/.credentials.json`，也可从 Agent 进程环境读取 `CLAUDE_CODE_OAUTH_TOKEN` 或 `ANTHROPIC_API_KEY`。

## 快速开始

### 1. 启动服务端

```bash
git clone https://github.com/luyi256/CCManager.git
cd CCManager
bash setup-server.sh
```

脚本会安装依赖、构建服务端和 SPA，并创建或重启 `ccm-server` PM2 进程。

创建第一个浏览器 Token：

```bash
node packages/server/dist/cli/index.js token create --name "Admin Browser"
```

打开 `http://localhost:3001/ccm/` 并粘贴 Token。登录后可以在 **Settings** 中创建更多浏览器 Token 和注册 Agent。

### 2. 发布 Agent 使用的服务地址

Agent 从 `<dataPath>/server-url.txt` 读取地址，URL 必须包含 `/ccm`：

```bash
mkdir -p ./data
printf '%s\n' 'http://127.0.0.1:3001/ccm' > ./data/server-url.txt
```

远程机器应改为外部可访问的 HTTPS 地址，例如 `https://code.example.com/ccm`。`dataPath` 也可以是包含 `server-url.txt` 的 GitHub Raw URL 根路径；连接失败后 Agent 会重新读取地址。

### 3. 注册并启动 Agent

可以在 **Settings → Agent Management** 注册，也可以使用服务端 CLI：

```bash
node packages/server/dist/cli/index.js agent create \
  --id studio-linux \
  --name "Studio Linux"
```

在实际执行任务的机器上：

```bash
git clone https://github.com/luyi256/CCManager.git
cd CCManager
bash setup-client.sh
```

客户端脚本会询问 Agent ID/名称、`dataPath`、允许访问的项目路径和一次性 Agent Token，然后构建并通过 PM2 启动 `ccm-agent`。

### 4. 添加项目

在 Web UI 中点击 **Add Project**，选择在线 Agent，填写该 Agent 上的绝对项目路径，并配置：

- 本机或 Docker 执行；
- Auto 或 Safe 安全模式；
- 可选 Git worktree 隔离；
- 可选 Docker 镜像和额外挂载。

## Agent 配置

默认配置文件为 `~/.ccm-agent.json`，也可通过 `--config=/path/to/file.json` 指定。

```json
{
  "agentId": "studio-linux",
  "agentName": "Studio Linux",
  "dataPath": "/srv/CCManagerData",
  "authToken": "one-time-generated-agent-token",
  "allowedPaths": ["/srv/projects/**"],
  "blockedPaths": ["/home/user/.ssh", "/home/user/.gnupg"],
  "capabilities": ["linux", "docker"],
  "dockerConfig": {
    "image": "ccmanager-runner:latest",
    "memory": "8g",
    "cpus": "4",
    "network": "bridge",
    "sessionsDir": "/home/user/.ccm-sessions",
    "extraMounts": [
      {
        "source": "/srv/datasets",
        "target": "/datasets",
        "readonly": true
      }
    ]
  }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `agentId`、`agentName` | 是 | 稳定的机器标识与显示名称 |
| `dataPath` | 是 | 包含 `server-url.txt` 的本地目录或远程 URL 根路径 |
| `authToken` | 首次连接需要 | 与当前 Agent ID 严格绑定的 Token |
| `allowedPaths` | 是 | Agent 可访问的路径，支持 `/*` 与 `/**` |
| `blockedPaths` | 否 | 显式禁止路径，优先于允许规则 |
| `capabilities` | 否 | 用户自定义路由标签；Runner 模型能力会自动补充 |
| `dockerConfig` | Docker 项目需要 | 默认镜像、资源限制、会话目录、网络和挂载 |

## 项目与执行选项

- **逐任务选择 Runner/模型** — 新建任务和追问都能切换 Runner 与模型，项目会记住最近使用的选择。
- **任务依赖** — 可让任务等待另一个活跃任务结束后再派发。
- **Plan Mode** — 对支持的 Runner 启用计划模式，并在对话中处理问题与确认。
- **图片与语音** — 初始任务和追问均支持截图；语音输入需要配置可选 Whisper 服务。
- **Git worktree** — 为任务创建独立分支/工作区，执行后可在界面合并或清理。
- **Runner 感知的会话连续性** — 追问会用原 Runner 恢复已保存的 Session ID；也可把受支持 CLI 的现有会话接入 CCManager，Docker Claude 会话从配置的会话目录读取。
- **任务后 Hook** — 服务端/Agent 协议支持成功后执行项目 Hook，需要时可通过项目 API 配置。

### Docker 目录

```text
/workspace                 项目目录，可读写
/home/ccm                  每个项目持久化的 HOME
└── .claude/
    └── .credentials.json  存在时从宿主机复制
```

容器使用宿主 UID/GID，启用 `--cap-drop=ALL`，仅补回必要 capability，并设置 `--no-new-privileges`。

## 服务端配置

服务端会读取仓库根目录 `.env`；设置 `DATA_PATH` 后还会读取 `<DATA_PATH>/secrets.env`。

```bash
PORT=3001
HOST=127.0.0.1
NODE_ENV=production
DATA_PATH=/srv/CCManagerData
SERVE_STATIC=true
STATIC_PATH=/opt/CCManager/packages/web/dist
SOCKET_IO_PATH=/ccm/socket.io

# 可选：兼容 OpenAI 的语音转文字接口
WHISPER_API_URL=https://api.groq.com/openai/v1
WHISPER_API_KEY=gsk_xxx
WHISPER_MODEL=whisper-large-v3-turbo
```

通过反向代理对外提供服务时建议保留 `HOST=127.0.0.1`。浏览器 SPA 使用 `/ccm/api` 和 `/ccm/socket.io`，服务端也保留无前缀 `/api` 路由供直接集成。

## Token 与备份 CLI

可以直接执行构建后的 CLI，也可以自行将其暴露为 `ccmng`：

```bash
# 浏览器/设备 Token
node packages/server/dist/cli/index.js token create --name "MacBook Pro"
node packages/server/dist/cli/index.js token list
node packages/server/dist/cli/index.js token revoke <device-id>

# Agent Token
node packages/server/dist/cli/index.js agent create --id macbook --name "MacBook"
node packages/server/dist/cli/index.js agent list
node packages/server/dist/cli/index.js agent token macbook
node packages/server/dist/cli/index.js agent revoke macbook

# SQLite 热备份，默认保留最新 7 份
node packages/server/dist/cli/index.js backup --keep 7
```

明文 Token 仅显示一次，数据库中只保存 SHA-256 哈希。

## 任务生命周期

```text
pending → running → completed | completed_with_warnings | failed | cancelled
              ├── waiting
              ├── waiting_permission
              └── plan_review
```

同一 Agent 可并行执行多个任务 ID。重复派发会被忽略，Agent 会在心跳中上报运行任务，重连时服务端会重新派发遗留在 `running` 状态的任务。

## 开发与部署

```bash
pnpm install

pnpm run dev:server            # API 与 Socket.IO：:3001
pnpm run dev:web               # Vite：http://localhost:5173/ccm/

pnpm run typecheck
pnpm --filter @ccmanager/server test
pnpm --filter @ccmanager/agent test

pnpm run build
pnpm exec pm2 restart ccm-server --update-env
curl http://localhost:3001/api/health
```

仓库中的 `docs/generate-showcase.mjs` 会创建临时虚构数据库，并通过真实浏览器界面重新生成 README 的全部截图与演示动画。

## API 概览

除健康检查外，所有接口都需要 `Authorization: Bearer <DEVICE_TOKEN>`。同一组接口同时挂载在 `/api` 和 `/ccm/api` 下。

| 模块 | 路由 |
|---|---|
| 健康检查 | `GET /api/health` 或 `GET /ccm/api/health` |
| 设备 | `GET /auth/me`、`GET/POST /auth/devices`、`DELETE /auth/devices/:id` |
| 项目 | `GET/POST /projects`、`GET/PUT/DELETE /projects/:id` |
| 任务 | 项目任务列表/创建；任务详情/更新、取消、重试、追问、日志、计划回答/确认、worktree 合并/清理 |
| 会话 | `/projects/:projectId/sessions` 下的多 Runner 列表、活跃列表、搜索、详情、继续和接入 |
| Agent | 列表、在线列表、Runner 模型、注册、独立 Token 创建/状态/吊销 |
| 其他 | 全局设置与可选 `/transcribe` |

## 仓库结构

```text
packages/
├── server/src/
│   ├── routes/       auth、project、task、session、agent REST 接口
│   ├── services/     SQLite、派发、流快照、会话读取、等待任务
│   ├── websocket/    经过认证的用户与 Agent Socket.IO namespace
│   └── cli/          Token、Agent 和备份命令
├── web/src/
│   ├── components/Conversation/  对话侧栏、主面板、模型选择器
│   ├── components/Session/       CLI 会话浏览器
│   ├── components/Task/          时间线与旧任务组件
│   ├── pages/                    项目、项目工作区、设置、登录
│   └── hooks/                    查询、会话、语音、可靠任务流
└── agent/src/
    ├── connection.ts             重连、心跳、并行任务派发
    ├── executor.ts               Claude 系与 Qwen 执行
    ├── codexExecutor.ts          Codex 与 tCodex 执行
    ├── runnerModels.ts           已安装 Runner/模型发现
    ├── sessions.ts               多 Runner 本机/Docker 会话发现
    ├── docker.ts                 加固后的普通 Claude 容器
    └── worktree.ts               逐任务 Git worktree
```

## 安全说明

- 浏览器与 Agent 凭证相互独立，均可单独吊销。
- REST API 和两个 Socket.IO namespace 均要求认证。
- CORS 仅允许同源，API 带请求限流。
- Agent Token 与具体 Agent ID 绑定。
- 项目路径会经过允许/禁止列表和真实符号链接目标检查。
- 图片以 data URL 提交，JSON 请求体上限为 50 MB。
- Docker 可以增加隔离，但宿主机 Runner 仍继承 Agent 系统账户权限；建议使用独立 OS 用户并收紧允许路径。

## 许可证

MIT
