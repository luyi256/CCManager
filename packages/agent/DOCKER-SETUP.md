# Docker Mode Setup Guide

## Prerequisites

1. **Docker Engine** (20.10+)
   - Ubuntu/Debian: `sudo apt-get install docker.io`
   - macOS: Install [Docker Desktop](https://docs.docker.com/desktop/install/mac-install/)
   - Ensure current user is in docker group: `sudo usermod -aG docker $USER` (re-login required)

2. **Claude Code Credentials** (choose one)
   - `ANTHROPIC_API_KEY` — API Key (pay-per-use)
   - `CLAUDE_CODE_OAUTH_TOKEN` — Pro/Max subscription OAuth Token

3. **Node.js** (>=18) and **pnpm** — for running the Agent itself

## Quick Start

### 1. Configure Agent

Create `agent.config.json` with `executor` set to `docker`:

```json
{
  "agentId": "my-docker-agent",
  "agentName": "Docker Agent",
  "managerUrl": "http://your-server:3001",
  "authToken": "your-token",
  "executor": "docker",
  "allowedPaths": ["/home/me/projects/*"],
  "dockerConfig": {
    "image": "ccmanager-runner:latest",
    "memory": "8g",
    "cpus": "4"
  }
}
```

### 2. Set Up Credentials

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# or
export CLAUDE_CODE_OAUTH_TOKEN=clt_...
```

### 3. Start Agent

```bash
cd packages/agent
npm run start
```

On startup, the agent will automatically:
1. Check if Docker is available
2. Check if the image exists; if not, build it automatically (first time takes ~2-5 minutes)
3. Connect to the Manager server

## Data Isolation

Each task runs in an isolated Docker container:

```
Host                                Container
─────────                          ──────────
/home/me/projects/my-repo  ──→    /workspace (rw)    ← Only writable project directory
~/.ccm-sessions/<projectId> ──→   /home/node/.claude (rw)  ← Session persistence
All other directories              Invisible, inaccessible
```

### Security Layers

| Layer | Protection |
|-------|-----------|
| Filesystem | Only project directory is mounted; container cannot access other host files |
| Linux Capabilities | `--cap-drop=ALL` + only minimal required capabilities retained |
| Privilege Escalation | `--security-opt=no-new-privileges` prevents escalation |
| User Identity | `--user UID:GID` runs container as host user, avoiding root |
| Resource Limits | Configurable CPU and memory limits |
| Network | Configurable network mode (default: bridge) |
| Credentials | Passed via environment variables only, no host config files mounted |

## Configuration Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `image` | string | required | Docker image name |
| `memory` | string | unlimited | Memory limit (e.g., `"8g"`) |
| `cpus` | string | unlimited | CPU limit (e.g., `"4"`) |
| `network` | string | bridge | Docker network mode |
| `timeout` | number | 14400000 | Task timeout in ms (default: 4 hours) |
| `sessionsDir` | string | ~/.ccm-sessions | Session persistence directory |
| `extraMounts` | array | [] | Additional volume mounts (can be read-only) |

## Building the Image Manually

For custom images or offline environments:

```bash
cd packages/agent
docker build -t ccmanager-runner:latest ./docker/
```

## Troubleshooting

### Docker Not Available

```
Error: Docker is not available. Please install Docker and ensure the daemon is running.
```

Solution:
- Verify Docker is installed: `docker --version`
- Verify Docker daemon is running: `sudo systemctl start docker`
- Verify user permissions: `sudo usermod -aG docker $USER` (re-login required)

### Credential Errors

API authentication fails during task execution:
- Verify environment variable is set: `echo $ANTHROPIC_API_KEY`
- Environment variables must be set **before** starting the Agent

### Session Resume Not Working

"Continue conversation" feature fails:
- Check if `~/.ccm-sessions/` directory exists and has correct permissions
- This directory stores Claude Code session data for `--resume` functionality

### File Permission Issues

Files created in container have wrong permissions on host:
- Agent uses `--user UID:GID` by default to run container as host user
- If issues persist, check project directory permissions: `ls -la /path/to/project`

### Network Issues

Claude Code requires access to the Anthropic API. Do not set `network` to `none`. Use the default `bridge` mode.
