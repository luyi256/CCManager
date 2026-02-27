# Docker 模式部署指南

## 前置条件

1. **Docker Engine** (20.10+)
   - Ubuntu/Debian: `sudo apt-get install docker.io`
   - macOS: 安装 [Docker Desktop](https://docs.docker.com/desktop/install/mac-install/)
   - 确保当前用户在 docker 组中: `sudo usermod -aG docker $USER`（需重新登录生效）

2. **Claude Code 凭证**（二选一）
   - `ANTHROPIC_API_KEY` — API Key 按量付费
   - `CLAUDE_CODE_OAUTH_TOKEN` — Pro/Max 订阅 OAuth Token

3. **Node.js** (>=18) 和 **pnpm** — 用于运行 Agent 本体

## 快速开始

### 1. 配置 Agent

创建 `agent.config.json`，设置 `executor` 为 `docker`：

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

### 2. 设置凭证

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# 或
export CLAUDE_CODE_OAUTH_TOKEN=clt_...
```

### 3. 启动 Agent

```bash
cd packages/agent
npm run start
```

Agent 启动时会自动：
1. 检测 Docker 是否可用
2. 检查镜像是否存在，不存在则自动构建（首次约需 2-5 分钟）
3. 连接到 Manager 服务器

## 数据隔离原理

每个任务运行在独立的 Docker 容器中：

```
宿主机                              容器内部
─────────                          ──────────
/home/me/projects/my-repo  ──→    /workspace (rw)    ← 唯一可写业务目录
~/.ccm-sessions/<projectId> ──→   /home/node/.claude (rw)  ← 会话持久化
其他所有目录                       不可见、不可访问
```

### 安全防护层

| 层级 | 防护措施 |
|------|----------|
| 文件系统 | 仅挂载项目目录，容器内无法访问宿主其他文件 |
| Linux Capabilities | `--cap-drop=ALL` + 仅保留最小必要能力 |
| 权限提升 | `--security-opt=no-new-privileges` 禁止提权 |
| 用户身份 | `--user UID:GID` 以宿主用户身份运行，避免 root |
| 资源限制 | 可配置 CPU、内存上限 |
| 网络 | 可配置网络模式（默认 bridge） |
| 凭证 | 仅通过环境变量传入，不挂载宿主配置文件 |

## 配置项说明

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `image` | string | 必填 | Docker 镜像名称 |
| `memory` | string | 无限制 | 内存上限（如 `"8g"`） |
| `cpus` | string | 无限制 | CPU 上限（如 `"4"`） |
| `network` | string | bridge | Docker 网络模式 |
| `timeout` | number | 14400000 | 任务超时时间 (ms)，默认 4 小时 |
| `sessionsDir` | string | ~/.ccm-sessions | 会话持久化目录 |
| `extraMounts` | array | [] | 额外卷挂载（可配置只读） |

## 手动构建镜像

如果需要自定义镜像或离线环境：

```bash
cd packages/agent
docker build -t ccmanager-runner:latest ./docker/
```

## 常见问题

### Docker 不可用

```
Error: Docker is not available. Please install Docker and ensure the daemon is running.
```

解决：
- 确认 Docker 已安装: `docker --version`
- 确认 Docker 守护进程运行中: `sudo systemctl start docker`
- 确认用户权限: `sudo usermod -aG docker $USER`（需重新登录）

### 凭证错误

任务执行时报 API 认证失败：
- 确认环境变量已设置: `echo $ANTHROPIC_API_KEY`
- 环境变量需在启动 Agent **之前** 设置

### 会话恢复不工作

"继续对话" 功能失败：
- 检查 `~/.ccm-sessions/` 目录是否存在且有正确权限
- 该目录存储 Claude Code 的会话数据，用于 `--resume` 功能

### 文件权限问题

容器内创建的文件在宿主机上权限不对：
- Agent 默认使用 `--user UID:GID` 以宿主用户身份运行容器
- 如仍有问题，检查项目目录权限: `ls -la /path/to/project`

### 网络问题

Claude Code 需要访问 Anthropic API，不要将 `network` 设为 `none`。推荐使用默认的 `bridge` 模式。
