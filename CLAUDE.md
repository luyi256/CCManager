# CC Manager

Multi-device task management system for Claude Code — manage Claude Code task execution across multiple devices via Web UI.

## Tech Stack

| Package | Technology | Description |
|---|---|---|
| `@ccmanager/server` | Express + Socket.IO + better-sqlite3 | API server, WebSocket, SQLite |
| `@ccmanager/web` | React 18 + Vite + TailwindCSS + TanStack Query | SPA frontend |
| `@ccmanager/agent` | Socket.IO Client + child_process | Connects to server, spawns `claude` CLI to execute tasks |

- **Language**: TypeScript (strict mode)
- **Package Manager**: pnpm 9.0 (monorepo workspace)
- **Runtime**: Node.js >= 18
- **Process Manager**: PM2

## Architecture

```
Server Host
├── CCManager/              - Code repository
├── <DATA_PATH>/            - Data directory (SQLite DB, config, etc.)
├── ccm-server              - PM2 daemon (port 3001)
└── ccm-agent               - PM2 daemon (connects to local server)

Remote Machines (MacBook, Linux, etc.)
├── ccm-agent        - Connects to server to execute tasks
└── ccm-tunnel       - Cloudflare tunnel (optional)
```

## Access URLs

- **Web UI**: http://localhost:3001 (requires API Token login)
- **API**: http://localhost:3001/api (requires `Authorization: Bearer <API_TOKEN>` header)
- **Health Check**: http://localhost:3001/api/health (no auth required)
- **Web Dev**: http://localhost:5173 (proxies `/api` and `/socket.io` to 3001)

## Project Structure

```
packages/
├── server/src/
│   ├── index.ts              # Express entry, route registration, WebSocket
│   ├── cli/
│   │   ├── index.ts          # ccmng CLI entry
│   │   └── token.ts          # Device token create/list/revoke
│   ├── routes/
│   │   ├── agents.ts         # Agent routes
│   │   ├── auth.ts           # Device auth (GET /me, devices CRUD)
│   │   ├── projects.ts       # Project CRUD
│   │   ├── tasks.ts          # Task CRUD, cancel, retry, continue, plan review
│   │   ├── settings.ts       # Global settings, auth validation
│   │   └── transcribe.ts     # Voice-to-text
│   ├── services/
│   │   ├── database.ts       # SQLite connection and schema
│   │   ├── storage.ts        # Data access layer
│   │   ├── agentPool.ts      # Agent registration and task dispatch
│   │   ├── streamParser.ts   # Claude Code stream-json output parser
│   │   ├── waitingTasks.ts   # Background task polling (node-cron, checks every minute, max 20 retries)
│   │   └── claudemd.ts       # CLAUDE.md context management
│   ├── websocket/index.ts    # Socket.IO namespaces and events
│   └── types/index.ts
├── web/src/
│   ├── App.tsx, main.tsx, index.css
│   ├── pages/
│   │   ├── HomePage.tsx      # Project list
│   │   └── ProjectPage.tsx   # Task board
│   ├── components/
│   │   ├── Layout/AppLayout.tsx         # Top nav, connection status
│   │   ├── Project/                     # AddProjectModal, ProjectCard, ProjectList
│   │   ├── Task/                        # TaskBoard, TaskCard, TaskColumn, TaskDetail, TaskInput
│   │   └── common/                      # ErrorBoundary, Modal, SafeMarkdown, StatusBadge, VoiceInput
│   ├── contexts/WebSocketContext.tsx     # Socket.IO provider
│   ├── hooks/                           # useProjects, useTasks, useTaskStream, useVoiceInput
│   ├── services/api.ts                  # API client (3 retries, exponential backoff)
│   └── types/index.ts
├── agent/src/
│   ├── index.ts              # CLI entry, config loading and validation
│   ├── connection.ts         # WebSocket connection, heartbeat (30s), concurrent task Map
│   ├── executor.ts           # spawn claude CLI (stream-json, 4-hour timeout)
│   ├── docker.ts             # Docker container execution (mount /workspace, credential injection, HOME=/home/ccm)
│   ├── security.ts           # Path validation (incl. symlink check), env var whitelist
│   └── types.ts              # AgentConfig, TaskRequest, DockerConfig, TaskResult types
```

## Database Schema

```sql
config (key, value, updated_at)
agents (id, name, capabilities, executor, status, last_seen, created_at)
projects (id, name, agent_id, project_path, security_mode, auth_type, created_at, last_activity)
tasks (id, project_id, prompt, status, is_plan_mode, depends_on, worktree_branch,
       created_at, started_at, completed_at, error, waiting_until, wait_reason,
       check_command, continue_prompt, git_info, summary, security_warnings, pending_permission)
task_logs (id, task_id, timestamp, type, content)
```

## Development

```bash
pnpm install                  # Install dependencies

pnpm run dev                  # Start server (3001) + web (5173)
pnpm run dev:server           # Server only
pnpm run dev:web              # Web only

pnpm run build                # Build server + web
pnpm run build:server         # Build server only
pnpm run build:web            # Build web only

pnpm run start                # Start production server
pnpm run lint                 # Lint
pnpm run typecheck            # Type check
```

## Deployment

Build locally and restart the service after code changes.

### Quick Deploy (Recommended)

```bash
pnpm run build && pm2 restart ccm-server
```

### Claude Code Workflow

**Important**: After code changes, always run the deploy pipeline automatically without asking for confirmation.

After completing code changes, Claude should automatically execute the following steps (do not ask):
1. Build the project (`pnpm run build`)
2. Restart the service (`pm2 restart ccm-server`)
3. Verify the service is running (`curl http://localhost:3001/api/health`)
4. Push code to GitHub (`git push origin main`)

## Service Management

```bash
# PM2 commands
pm2 status                    # View status
pm2 logs ccm-server           # View logs
pm2 restart ccm-server        # Restart service

# If service loses env vars, restart using ecosystem config
pm2 delete ccm-server ccm-agent && pm2 start ecosystem.config.cjs && pm2 save

# Data sync (if using separate data repo)
cd <DATA_PATH> && git add -A && git commit -m "Data sync" && git push
```

## PM2 Configuration (ecosystem.config.cjs)

Root `ecosystem.config.cjs` manages local dev machine processes:

| Process | Description |
|---------|-------------|
| `ccm-agent` | Agent process (`packages/agent`, `npm run dev`) |
| `ccm-tunnel` | Cloudflare tunnel + Telegram notification |

Start: `npx pm2 start ecosystem.config.cjs && npx pm2 logs`

Environment variables (via .env or ecosystem.config.cjs):
- `DATA_PATH=<path-to-data-directory>`
- `STATIC_PATH=<path-to-web-dist>`
- `SERVE_STATIC=true`

## Agent Configuration

Config file: `~/.ccm-agent.json` (or `--config=<path>`)

Example: `packages/agent/agent.config.example.json`

```json
{
  "agentId": "my-agent",
  "agentName": "My Agent",
  "dataPath": "/path/to/CCManagerData",
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

`dataPath` can be a local path or GitHub raw URL base (e.g., `https://raw.githubusercontent.com/user/CCManagerData/main`). Agent reads server address from `<dataPath>/server-url.txt`, auto re-reads on connection failure. `authToken` is entered interactively on first run and saved to config.

## API Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/auth/me` | Current device info |
| GET | `/api/auth/devices` | Registered device list |
| DELETE | `/api/auth/devices/:id` | Revoke device token |
| GET/POST | `/api/projects` | Project list / create |
| GET/PUT/DELETE | `/api/projects/:id` | Project detail / update / delete |
| GET/POST | `/api/projects/:pid/tasks` | Task list / create |
| GET/PUT | `/api/tasks/:id` | Task detail / update |
| POST | `/api/tasks/:id/cancel` | Cancel task |
| POST | `/api/tasks/:id/retry` | Retry failed task |
| POST | `/api/tasks/:id/continue` | Continue conversation |
| POST | `/api/tasks/:id/plan/answer` | Answer plan question |
| POST | `/api/tasks/:id/plan/confirm` | Confirm plan |
| GET | `/api/tasks/:id/logs` | Get task logs |
| GET | `/api/agents` | Agent list |
| GET | `/api/agents/online` | Online agents |
| GET | `/api/agents/:id` | Agent detail |
| GET/PUT | `/api/settings` | Global settings |
| POST | `/api/settings/validate-auth` | Validate auth token |
| POST | `/api/transcribe` | Voice-to-text (Whisper) |

## Task States

`pending` → `running` → `completed` / `completed_with_warnings` / `failed` / `cancelled`

While running, may enter: `waiting` / `waiting_permission` / `plan_review`

## Key Features

- **Parallel Execution**: Same agent can execute multiple tasks concurrently (Map storing active executors)
- **Orphan Task Recovery**: Agent auto-recovers `running` tasks after reconnection
- **Duplicate Execution Guard**: Agent skips already-running taskIds
- **Continue Conversation**: Resume work based on completed task's session ID (`--resume sessionId`)
- **Real-time Updates**: WebSocket push + frontend 5s polling fallback
- **Security Model**: API Token auth + CORS same-origin + rate limiting + path whitelist + symlink check + permission requests + plan mode
- **Task Timeout**: Default 4 hours
- **Waiting Tasks**: node-cron checks every minute, max 20 retries

## Docker Execution Mode

When agent is configured with `executor: "docker"`, each task runs in an isolated container:

```
Container directory structure:
├── /workspace          ← Project directory (bind mount, rw)
└── /home/ccm           ← HOME directory (bind mount from ~/.ccm-sessions/<projectId>)
    ├── .claude/        ← Claude CLI data (sessions, debug)
    │   └── .credentials.json  ← Copied from host ~/.claude/
    └── .claude.json    ← Claude CLI config (generated at runtime)
```

**Credential Passing**: Before starting the container, host `~/.claude/.credentials.json` is automatically copied to the session directory's `.claude/` subdirectory. Container runs with host UID (`--user`), HOME set to `/home/ccm` (mounted session directory), ensuring Claude CLI can read credentials and write config.

**Security Hardening**: `--cap-drop=ALL` + minimal capabilities (`CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID`) + `--no-new-privileges`

## Security

### Device Token Auth (CLI-managed)

Device tokens are generated via server-side CLI, no public registration endpoint:

```bash
# Generate device token
ccmng token create --name "MacBook Pro"

# List registered devices
ccmng token list

# Revoke device token
ccmng token revoke <id>
```

All API and WebSocket connections require token auth:

- **REST API**: `Authorization: Bearer <DEVICE_TOKEN>` header
- **WebSocket (User)**: `auth: { token }` connection parameter
- **WebSocket (Agent)**: Uses separate `agentAuthToken` (configured in Settings)
- **Exception**: `/api/health` health check is unauthenticated

Token storage:
- Server: SQLite `device_tokens` table (stores SHA-256 hash)
- Browser: `localStorage` key `ccm_api_token`
- Auth failure (401/403) auto-clears localStorage and redirects to login

### Other Security Measures

- **CORS**: `origin: false`, same-origin only
- **Rate Limiting**: 100 requests/min/IP (`express-rate-limit`)
- **Agent Auth**: Must configure `agentAuthToken`, rejects connections without token (no dev fallback)

## Environment Variables (.env)

```bash
# Device tokens managed via CLI (ccmng token create --name "...")

# Claude Code Auth
# Docker mode: auto-reads OAuth credentials from ~/.claude/.credentials.json
# Local mode: uses host's claude CLI auth directly
# Env vars (optional override, also supported in Docker mode):
CLAUDE_CODE_OAUTH_TOKEN=clt_...    # Pro/Max subscription
ANTHROPIC_API_KEY=sk-ant-...       # Pay-per-use

# Voice-to-text (optional, Groq Whisper)
GROQ_API_KEY=gsk_...
GROQ_MODEL=whisper-large-v3-turbo

# Server
PORT=3001
NODE_ENV=development
DATA_PATH=/custom/data/path        # Optional, default ./data
SERVE_STATIC=true                  # Optional, serve frontend in production
STATIC_PATH=/path/to/web/dist     # Optional
```
