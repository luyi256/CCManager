# Docker 数据保护机制实现计划

## Context

当前 CCManager 的 agent 支持 `local` 和 `docker` 两种执行器，但 Docker 执行器存在功能缺失（无 session 跟踪、无 `--resume` 支持、无凭证注入），且没有提供 Dockerfile 和自动化构建流程。用户需要一个完整的 Docker 隔离方案：仅挂载项目目录，确保 Claude Code 不能修改项目目录以外的内容，并让 agent 启动时自动安装所需环境。

## 修改文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/agent/docker/Dockerfile` | 新建 | Docker 镜像定义 |
| `packages/agent/src/dockerSetup.ts` | 新建 | 启动时自动检测/构建 Docker 镜像 |
| `packages/agent/src/docker.ts` | 重写 | 补全功能对齐 ClaudeExecutor，添加安全加固 |
| `packages/agent/src/types.ts` | 修改 | DockerConfig 增加 `sessionsDir` 字段 |
| `packages/agent/src/index.ts` | 修改 | 启动时调用 Docker 环境检测 |
| `packages/agent/agent.config.example.json` | 更新 | 反映新配置项 |
| `packages/agent/DOCKER-SETUP.md` | 新建 | 客户端 Docker 模式部署文档 |

## 实现细节

### 1. Dockerfile (`packages/agent/docker/Dockerfile`)

基于 `node:20-slim`，安装 git + Claude Code CLI：

```dockerfile
FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code
WORKDIR /workspace
ENTRYPOINT ["claude"]
```

- 不设置固定 USER，运行时通过 `--user $(id -u):$(id -g)` 传入宿主用户 UID/GID，避免文件权限问题
- `ENTRYPOINT ["claude"]` 使 `docker run <image> <args>` 直接执行 claude 命令

### 2. dockerSetup.ts（自动环境安装）

agent 启动时执行：
1. `docker info` — 验证 Docker 可用
2. `docker image inspect <image>` — 检查镜像是否存在
3. 不存在 → 先尝试 `docker pull`，失败则从本地 `packages/agent/docker/Dockerfile` 自动 `docker build`

### 3. docker.ts 重写（核心）

对齐 ClaudeExecutor (`executor.ts`) 的所有功能：

**新增功能：**
- `sessionId` 字段 + `getSessionId()` 方法 + `session_id` 事件
- `--resume sessionId` 支持（继续对话）
- `--verbose` 标志
- `hasStreamedDelta` 去重逻辑（防止 `content_block_delta` 和 `assistant` 重复输出）
- `parseLine()` 补全 `system`（init 提取 session_id）、`user`、`result` 事件处理

**安全加固（Docker run 参数）：**
- `--security-opt=no-new-privileges` — 禁止提权
- `--cap-drop=ALL` — 丢弃所有 Linux capabilities
- `--cap-add` 仅保留最小必要能力（CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID）
- `--user $(id -u):$(id -g)` — 以宿主用户身份运行，避免文件权限问题

**挂载策略：**
- 项目目录 → `/workspace:rw`（唯一可写的业务目录）
- 会话目录 `~/.ccm-sessions/<projectId>/` → `/home/node/.claude:rw`（session 持久化，支持 `--resume`）
- extraMounts 照旧（用户可配置只读挂载）

**凭证注入：**
- 通过 `-e ANTHROPIC_API_KEY` / `-e CLAUDE_CODE_OAUTH_TOKEN` 传入（从宿主 `process.env` 读取）
- 不挂载宿主的 `~/.config` 或凭证文件

### 4. types.ts 修改

DockerConfig 新增：
```typescript
sessionsDir?: string;  // 会话持久化目录，默认 ~/.ccm-sessions
```

### 5. index.ts 修改

在 `validateConfig()` 和 `new AgentConnection()` 之间插入：
```typescript
if (config.executor === 'docker' && config.dockerConfig) {
  await verifyDockerAvailable();
  await ensureDockerImage(config.dockerConfig);
}
```

### 6. DOCKER-SETUP.md（客户端文档）

包含：
- 前置条件（Docker 安装、凭证配置）
- agent.config.json 配置示例（executor: docker）
- 安全模型说明（挂载策略、capability 控制、凭证传递）
- 手动构建镜像命令
- 常见问题排查

## 注意事项

- **网络**：容器默认使用 `bridge` 网络，Claude Code 需要访问 Anthropic API，不可设为 `none`
- **Git 配置**：容器内 git 没有 user.name/email，通过环境变量 `GIT_AUTHOR_NAME` 等传入
- **`--dangerously-skip-permissions`**：Docker 隔离本身提供了保护，容器内使用此标志是安全的

## 验证

1. `pnpm run typecheck` — 类型检查通过
2. 手动测试：配置 `executor: docker`，启动 agent，观察自动构建镜像
3. 创建任务，验证容器仅挂载项目目录
4. 验证 session resume（继续对话）功能正常
