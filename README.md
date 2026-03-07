# CCManager

A multi-device task management system for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Manage and execute Claude Code tasks across multiple machines through a centralized Web UI.

## Features

- **Multi-Agent Architecture** — Distribute Claude Code tasks across multiple machines (Linux, macOS, etc.)
- **Real-time Web UI** — Monitor task status, view streaming output, and manage projects from your browser
- **Dual Execution Modes** — Run tasks locally or in isolated Docker containers with security hardening
- **Plan Mode** — Review AI-generated plans before execution, with approval/rejection workflow
- **Continue Conversations** — Resume completed tasks with Claude's session context preserved
- **Voice Input** — Dictate task prompts via Groq Whisper integration (optional)
- **Security** — Device token auth (CLI-managed, SHA-256 hashed), CORS, rate limiting, path whitelisting, symlink protection
- **Cloudflare Tunnel** — Optional public access with automatic URL notification via Telegram

## Architecture

```
┌──────────────────────────────────┐
│  Server (Express + Socket.IO)    │    ← Central server
│  Web UI (React SPA)              │
│  SQLite Database                 │
│  Port: 3001                      │
└────────┬────────────┬────────────┘
         │ WebSocket  │ WebSocket
    ┌────┴────┐  ┌────┴────┐
    │ Agent A │  │ Agent B │           ← Distributed agents
    │ (Linux) │  │ (macOS) │
    │ Docker  │  │ Local   │
    └─────────┘  └─────────┘
```

| Component | Description |
|-----------|-------------|
| **Server** (`@ccmanager/server`) | Express API + Socket.IO + SQLite — manages projects, task queue, and WebSocket events |
| **Web UI** (`@ccmanager/web`) | React 18 + Vite + TailwindCSS + TanStack Query — SPA frontend with real-time updates |
| **Agent** (`@ccmanager/agent`) | Socket.IO client + child_process — connects to server, spawns `claude` CLI to execute tasks |
| **ccmng** | Server-side CLI tool for managing device tokens |

## Prerequisites

| Dependency | Version | Required For |
|------------|---------|--------------|
| [Node.js](https://nodejs.org/) | >= 18 | Runtime |
| [pnpm](https://pnpm.io/) | 9.x | Package manager (`npm i -g pnpm@9`) |
| [PM2](https://pm2.keymetrics.io/) | >= 5 | Process management (`npm i -g pm2`) |
| [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) | latest | Task execution (`npm i -g @anthropic-ai/claude-code`) |
| [Docker](https://www.docker.com/) | (optional) | Docker executor mode only |

## Quick Start

### Server Setup

```bash
git clone https://github.com/luyi256/CCManager.git
cd CCManager
bash setup-server.sh
```

The setup script will install dependencies, build the project, configure PM2, and start the server.

After setup, generate a device token for Web UI login:

```bash
ccmng token create --name "My Computer"
# Copy the token — it's only shown once
```

Open `http://localhost:3001` in your browser and paste the token to log in.

### Agent Setup (Client)

On each machine that will execute tasks:

```bash
git clone https://github.com/luyi256/CCManager.git
cd CCManager
bash setup-client.sh
```

The setup script will guide you through:
1. Installing dependencies
2. Configuring agent ID, name, and allowed paths
3. Entering the auth token (generated via `ccmng agent create` on the server or Web UI Settings)
4. Building and starting the agent with PM2

### Manual Installation

```bash
# 1. Install dependencies
pnpm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your settings

# 3. Build
pnpm run build

# 4. Start the server
pm2 start packages/server/dist/index.js --name ccm-server
pm2 save

# 5. Generate a device token
ccmng token create --name "My Computer"
# Use the token to log in at http://localhost:3001
```

## Configuration

### Environment Variables (`.env`)

Copy `.env.example` to `.env` and configure:

```bash
# Claude Code Authentication (choose one)
CLAUDE_CODE_OAUTH_TOKEN=clt_xxx    # Pro/Max subscription (OAuth)
ANTHROPIC_API_KEY=sk-ant-xxx       # Pay-per-use (API key)

# Server
PORT=3001                          # Server port (default: 3001)
HOST=127.0.0.1                     # Listen address
DATA_PATH=/path/to/data            # Data directory (default: ./data)

# Production mode
SERVE_STATIC=true                  # Serve frontend static files
STATIC_PATH=/path/to/web/dist     # Path to built frontend

# Voice transcription (optional)
GROQ_API_KEY=gsk_xxx               # Get from https://console.groq.com/keys
GROQ_MODEL=whisper-large-v3-turbo  # or whisper-large-v3
```

### Agent Configuration

Config file: `~/.ccm-agent.json` (or specify with `--config=<path>`)

See `packages/agent/agent.config.example.json` for a full example.

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

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agentId` | string | Yes | Unique identifier (alphanumeric, `-`, `_` only) |
| `agentName` | string | Yes | Display name |
| `dataPath` | string | Yes | Path to data directory (local path or GitHub raw URL) |
| `authToken` | string | Auto | Entered interactively on first run, saved to config |
| `allowedPaths` | string[] | Yes | Glob patterns for allowed project paths |
| `blockedPaths` | string[] | No | Paths to block access to |
| `capabilities` | string[] | No | Tags for task routing (e.g., `gpu`, `linux`) |
| `dockerConfig` | object | No | Docker container settings (see below) |

The agent reads the server URL from `<dataPath>/server-url.txt`. Remote agents can use a GitHub raw URL as `dataPath` (e.g., `https://raw.githubusercontent.com/user/data-repo/main`). The agent automatically re-reads the server URL on connection failure, supporting dynamic tunnel URLs.

### Docker Executor Mode

Configure per-project in the Web UI, or set in agent config:

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

Each task runs in an isolated container:
- Project directory mounted at `/workspace`
- Claude CLI credentials auto-injected
- Security: `--cap-drop=ALL` + minimal capabilities + `--no-new-privileges`

Build the runner image: `docker build -t ccmanager-runner:latest packages/agent/docker/`

## Device Token Management

Device tokens are managed via the server-side `ccmng` CLI. There is no public registration endpoint.

```bash
# Create a token (shown once — copy immediately)
ccmng token create --name "MacBook Pro"

# List registered devices
ccmng token list

# Revoke a device token
ccmng token revoke <id>
```

All API and WebSocket connections require token authentication:
- **REST API**: `Authorization: Bearer <TOKEN>` header
- **WebSocket (UI)**: `auth: { token }` connection parameter
- **WebSocket (Agent)**: Uses `agentAuthToken` (configured in Settings)
- **Exception**: `GET /api/health` is unauthenticated

## Task Lifecycle

```
pending → running → completed / completed_with_warnings / failed / cancelled

While running, a task may enter:
  running → waiting              (waiting for external condition)
  running → waiting_permission   (waiting for user authorization)
  running → plan_review          (waiting for plan confirmation)
```

## Development

```bash
pnpm install                  # Install dependencies

pnpm run dev                  # Start server (3001) + web (5173) with HMR
pnpm run dev:server           # Server only
pnpm run dev:web              # Web only

pnpm run build                # Build all packages
pnpm run build:server         # Build server only
pnpm run build:web            # Build web only

pnpm run lint                 # Lint
pnpm run typecheck            # Type check
```

### Deployment

```bash
pnpm run build && pm2 restart ccm-server
```

### PM2 Process Management

The `ecosystem.config.cjs` file manages local processes:

| Process | Description |
|---------|-------------|
| `ccm-agent` | Agent process (`packages/agent`) |
| `ccm-tunnel` | Cloudflare tunnel + Telegram notification (optional) |

```bash
pm2 start ecosystem.config.cjs   # Start all processes
pm2 status                       # View status
pm2 logs ccm-server              # View server logs
pm2 restart ccm-server           # Restart server
```

### Cloudflare Tunnel (Optional)

For remote access without port forwarding, use the included tunnel scripts:

1. Install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
2. Configure Telegram notifications in `<DATA_PATH>/secrets.env`:
   ```bash
   TELEGRAM_BOT_TOKEN="your-bot-token"
   TELEGRAM_CHAT_ID="your-chat-id"
   ```
3. Start via PM2: `pm2 start ecosystem.config.cjs`

The tunnel URL is automatically written to `<DATA_PATH>/server-url.txt` for remote agent discovery.

## API Reference

All endpoints require `Authorization: Bearer <TOKEN>` header (except `/api/health`).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/auth/me` | Current device info |
| GET | `/api/auth/devices` | List registered devices |
| DELETE | `/api/auth/devices/:id` | Revoke device token |
| GET/POST | `/api/projects` | List / create projects |
| GET/PUT/DELETE | `/api/projects/:id` | Project CRUD |
| GET/POST | `/api/projects/:pid/tasks` | List / create tasks |
| GET/PUT | `/api/tasks/:id` | Task detail / update |
| POST | `/api/tasks/:id/cancel` | Cancel task |
| POST | `/api/tasks/:id/retry` | Retry failed task |
| POST | `/api/tasks/:id/continue` | Continue conversation |
| POST | `/api/tasks/:id/plan/answer` | Answer plan question |
| POST | `/api/tasks/:id/plan/confirm` | Confirm plan |
| GET | `/api/tasks/:id/logs` | Get task logs |
| GET | `/api/agents` | List agents |
| GET | `/api/agents/online` | List online agents |
| GET | `/api/agents/:id` | Agent detail |
| GET/PUT | `/api/settings` | Global settings |
| POST | `/api/transcribe` | Voice-to-text (Whisper) |

## Project Structure

```
packages/
├── server/         Express API + Socket.IO + SQLite
│   └── src/
│       ├── index.ts             # Entry point
│       ├── cli/                 # ccmng CLI (token & agent management)
│       ├── routes/              # REST API routes
│       ├── services/            # DB, Agent Pool, Stream Parser
│       └── websocket/           # WebSocket events
├── web/            React 18 + Vite + TailwindCSS
│   └── src/
│       ├── pages/               # Home, Project, Login, Settings
│       ├── components/          # UI components
│       ├── hooks/               # Custom hooks
│       └── contexts/            # WebSocket context
└── agent/          Socket.IO Client + child_process
    └── src/
        ├── index.ts             # CLI entry
        ├── connection.ts        # WebSocket connection
        ├── executor.ts          # Claude CLI executor
        ├── docker.ts            # Docker container execution
        └── security.ts          # Path security validation
```

## Security

- **Device Token Auth**: CLI-managed tokens, SHA-256 hashed storage, no public registration
- **Agent Auth Token**: Configured in Web UI Settings, per-agent isolation
- **CORS**: Same-origin only (`origin: false`)
- **Rate Limiting**: 100 requests/min/IP
- **Path Whitelisting**: Agents can only operate within `allowedPaths`, with symlink checking
- **Docker Sandbox**: `--cap-drop=ALL` + minimal capabilities + `--no-new-privileges`
- **Plan Mode**: Tasks can require user approval before execution

## License

MIT
