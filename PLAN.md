# Claude Code Manager (CCManager) 设计计划

## 项目概述

一个 Web 应用，用于管理多个远程项目的 Claude Code 开发任务。支持 iOS 和 macOS 使用。

## 核心需求

### 1. 首页 - 项目管理
- 展示所有项目列表
- 添加项目：SSH 地址、项目文件夹路径
- 项目状态概览（任务统计）

### 2. 项目页面 - 任务管理
- **任务输入**：文字输入 + 语音输入
- **Plan 模式**：可选择是否启用 plan 模式
- **前序任务**：任务依赖关系设置
- **任务看板**：待开发、开发中、等待中、待 Review、已完成、失败、已取消

### 3. Claude Code 集成
- 命令格式：`claude -p [prompt] --dangerously-skip-permissions --output-format stream-json --verbose`
- 解析 stream-json 输出，实时展示任务进度
- Plan 模式下的交互式 UI（选项选择、确认反馈）

### 4. Git Worktree 工作流
- 每个任务创建独立的 worktree 和分支
- 任务完成后自动 merge 到 main
- 冲突处理和清理机制

---

## 架构设计

### 技术栈（已确认）

**前端**：
- React 18 + Vite
- TailwindCSS（UI 快速开发）
- Lucide React（图标库，轻量简洁）
- Framer Motion（过渡动画）
- React Query（数据获取与缓存）
- WebSocket（实时通信）
- OpenAI Whisper API（语音转文字）

**后端**：
- Node.js + Express/Fastify
- ssh2 库（SSH 连接管理）
- ws 库（WebSocket 服务）
- 部署到云服务器

**移动端**：
- PWA（渐进式 Web 应用）
- 支持 iOS Safari "添加到主屏幕"

**数据存储**：
- JSON 文件，存储在 CCManager 项目的 `data/` 目录下
- 直接同步到 CCManager 仓库（不是单独的数据仓库）
- 结构见下方「数据存储格式」章节

---

## 数据存储格式

### 目录结构

数据存储在 CCManager 项目的 `data/` 目录下，与代码一起提交到同一个 Git 仓库：

```
ccmanager/                         # CCManager 项目根目录
├── .git/                          # Git 仓库（包含代码和数据）
├── packages/
│   ├── web/                       # 前端代码
│   └── server/                    # 后端代码
│
├── data/                          # 数据目录（与代码同仓库）
│   ├── config.json                # 全局配置
│   ├── projects/                  # 项目数据
│   │   ├── index.json             # 项目列表索引
│   │   └── {projectId}/
│   │       ├── project.json       # 项目配置
│   │       ├── tasks.json         # 任务列表
│   │       └── logs/              # 任务执行日志
│   │           └── {taskId}.log   # 单个任务的日志
│   │
│   └── README.md                  # 数据说明（自动生成）
│
├── package.json
└── README.md
```

### 项目列表索引 (projects/index.json)

```json
{
  "projects": [
    {
      "id": "voice-notes",
      "name": "Voice Notes",
      "sshHost": "192.168.1.100",
      "lastActivity": "2024-02-14T12:00:00Z",
      "taskCount": 209,
      "runningCount": 2
    }
  ],
  "updatedAt": "2024-02-14T12:00:00Z"
}
```

### 项目任务列表 (projects/{projectId}/tasks.json)

包含完整的任务信息和 commit 对应关系：

```json
{
  "projectId": "voice-notes",
  "tasks": [
    {
      "id": 213,
      "prompt": "实现用户登录功能，支持 JWT 认证",
      "status": "completed",
      "isPlanMode": true,
      "dependsOn": null,

      "createdAt": "2024-02-14T00:15:00Z",
      "startedAt": "2024-02-14T00:15:30Z",
      "completedAt": "2024-02-14T00:19:45Z",

      "git": {
        "branch": "task-213-20240214001530",
        "commits": [
          {
            "sha": "abc1234",
            "message": "feat: implement JWT authentication",
            "author": "Claude Code",
            "date": "2024-02-14T00:19:00Z"
          }
        ],
        "mergedTo": "main",
        "mergedAt": "2024-02-14T00:19:45Z",
        "mergeCommit": "def5678"
      },

      "summary": "添加了登录表单组件和 auth 服务，实现了 JWT token 管理"
    },
    {
      "id": 214,
      "prompt": "修复图片同步慢的问题",
      "status": "running",
      "isPlanMode": false,
      "dependsOn": null,

      "createdAt": "2024-02-14T00:20:00Z",
      "startedAt": "2024-02-14T00:20:05Z",

      "git": {
        "branch": "task-214-20240214002005",
        "commits": []
      }
    }
  ],
  "updatedAt": "2024-02-14T00:20:05Z"
}
```

### 快速查找

#### 1. 查找任务对应的 commit

```bash
# 在 data 目录下搜索
grep -r "abc1234" projects/*/tasks.json

# 或使用 jq 查询
jq '.tasks[] | select(.git.commits[].sha == "abc1234")' projects/*/tasks.json
```

#### 2. 查找 prompt 包含关键词的任务

```bash
grep -r "登录" projects/*/tasks.json | jq '.tasks[] | select(.prompt | contains("登录"))'
```

#### 3. 在 CCManager UI 中搜索

提供搜索功能：
- 按任务 ID 搜索
- 按 prompt 关键词搜索
- 按 commit SHA 搜索
- 按日期范围筛选

### Git 同步（与 CCManager 仓库一体）

由于数据存储在 CCManager 项目的 `data/` 目录下，数据变更直接提交到 CCManager 仓库本身。

#### 首次部署 - 建立仓库连接

在云服务器上部署 CCManager 时，需要首先建立与 Git 仓库的连接：

```bash
# 1. 配置 SSH 密钥（用于 git push）
# 将本地的 SSH 公钥添加到 GitHub/GitLab 的 Deploy Keys
# 或者使用 Personal Access Token

# 2. 克隆 CCManager 仓库到云服务器
git clone git@github.com:luyi256/CCManager.git
cd CCManager

# 3. 配置 git 用户信息（用于自动提交）
git config user.name "CCManager Bot"
git config user.email "ccmanager@yourdomain.com"

# 4. 确保 data 目录存在
mkdir -p data/projects

# 5. 安装依赖并启动
npm install
npm run build
npm run start
```

#### 自动同步

CCManager 在每次数据变更后自动提交和推送到仓库：

```typescript
// services/dataSync.ts
class DataSyncService {
  private repoRoot: string;        // CCManager 仓库根目录
  private syncEnabled: boolean;
  private pendingSync = false;
  private syncDebounceMs = 5000;   // 5 秒内的变更合并为一次提交

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
    this.syncEnabled = this.isGitRepo();
  }

  private isGitRepo(): boolean {
    return fs.existsSync(path.join(this.repoRoot, '.git'));
  }

  async scheduleSync(message: string) {
    if (!this.syncEnabled) return;

    if (this.pendingSync) return;
    this.pendingSync = true;

    setTimeout(async () => {
      await this.doSync(message);
      this.pendingSync = false;
    }, this.syncDebounceMs);
  }

  private async doSync(message: string) {
    try {
      // 只提交 data/ 目录的变更
      await execAsync(`
        cd ${this.repoRoot}
        git add data/
        git diff --cached --quiet || git commit -m "data: ${message}"
        git push origin main
      `);
      console.log('Data synced to remote');
    } catch (error) {
      console.error('Failed to sync data:', error);
      // 可以添加重试逻辑或通知机制
    }
  }

  // 从远程拉取（启动时）
  async pull() {
    if (!this.syncEnabled) return;

    await execAsync(`
      cd ${this.repoRoot}
      git pull origin main --rebase
    `);
  }
}
```

#### 触发同步的时机

```typescript
// 任务状态变更时
taskService.on('taskUpdated', (task) => {
  dataSyncService.scheduleSync(`task #${task.id}: ${task.status}`);
});

// 项目配置变更时
projectService.on('projectUpdated', (project) => {
  dataSyncService.scheduleSync(`project: ${project.name}`);
});
```

#### Git 提交记录示例

```
* abc1234 data: task #215: completed
* def5678 data: task #215: running
* ghi9012 data: task #215: pending
* jkl3456 data: project: Voice Notes
```

### 数据备份和恢复

#### 备份

由于数据存储在 CCManager Git 仓库中，历史版本自动保留。

```bash
# 查看数据变更历史
cd /path/to/CCManager
git log --oneline -- data/

# 恢复某个项目的任务数据到历史版本
git checkout abc1234 -- data/projects/voice-notes/tasks.json

# 查看某个时间点的数据状态
git show abc1234:data/projects/voice-notes/tasks.json
```

#### 多设备同步

由于数据在 CCManager 仓库中，更新代码时会自动获取最新数据：

```bash
# 拉取最新代码和数据
git pull origin main
```

#### 迁移到新服务器

```bash
# 在新服务器上，直接克隆 CCManager 仓库即可（包含代码和数据）
git clone git@github.com:username/CCManager.git
cd CCManager
npm install
npm run build
npm run start
```

### data/README.md 自动生成

每次同步时自动更新 `data/README.md`：

```markdown
# CCManager Data Directory

Last updated: 2024-02-14 12:00:00

## Projects

| Project | Tasks | Running | Last Activity |
|---------|-------|---------|---------------|
| Voice Notes | 209 | 2 | 5 minutes ago |
| Blog Engine | 45 | 0 | 2 days ago |

## Recent Tasks

| ID | Project | Prompt | Status | Commit |
|----|---------|--------|--------|--------|
| 214 | Voice Notes | 修复图片同步慢... | running | - |
| 213 | Voice Notes | 实现用户登录... | completed | abc1234 |
```

---

## Git Worktree 管理方案（推荐：混合模式）

- **Manager 负责**：创建 worktree、分配任务、状态跟踪、冲突处理、清理
- **Claude Code 负责**：在已创建的 worktree 中完成开发和 commit

**理由**：Manager 作为"调度中心"，应该掌控任务的完整生命周期。Claude Code 是"工人"，只需在指定的工作区完成编码任务。

---

## 系统架构

```
┌─────────────────────────────────────────────────────────┐
│                    CCManager Web App                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │
│  │   首页      │  │  项目页面   │  │  Plan 对话视图  │  │
│  │  项目列表   │  │  任务看板   │  │  选项/确认 UI   │  │
│  └─────────────┘  └─────────────┘  └─────────────────┘  │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│                     Backend Server                       │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │
│  │ 项目管理    │  │ 任务调度    │  │  SSH 连接池     │  │
│  │             │  │ 队列管理    │  │                 │  │
│  └─────────────┘  └─────────────┘  └─────────────────┘  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │
│  │ Git Worktree│  │ Stream JSON │  │  WebSocket      │  │
│  │ 管理        │  │ 解析器      │  │  实时通信       │  │
│  └─────────────┘  └─────────────┘  └─────────────────┘  │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼ SSH
┌─────────────────────────────────────────────────────────┐
│                   Remote Server(s)                       │
│  ┌─────────────────────────────────────────────────┐    │
│  │  Project Folder                                  │    │
│  │  ├── src/, package.json... (主代码)              │    │
│  │  └── .worktrees/                                 │    │
│  │      ├── task-001/  (含 CLAUDE.md 限制)          │    │
│  │      └── task-002/                               │    │
│  └─────────────────────────────────────────────────┘    │
│  ┌─────────────────────────────────────────────────┐    │
│  │  Claude Code 实例                                │    │
│  │  - 接收 prompt                                   │    │
│  │  - 输出 stream-json                             │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

---

## 数据模型设计

### Project（项目）
```typescript
interface Project {
  id: string;
  name: string;
  sshHost: string;        // SSH 主机地址
  sshUser: string;        // SSH 用户名
  sshKeyPath?: string;    // SSH 私钥路径（云服务器上）
  projectPath: string;    // 项目文件夹路径
  createdAt: string;
  taskCount: number;      // 任务统计
}
```

### Task（任务）
```typescript
interface Task {
  id: number;
  projectId: string;
  prompt: string;         // 用户输入的任务描述
  status: TaskStatus;
  isPlanMode: boolean;    // 是否为 Plan 模式
  dependsOn?: number;     // 前序任务 ID
  worktreeBranch?: string;// Git worktree 分支名
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  // 等待任务相关
  waitingUntil?: string;     // 下次检查时间 (ISO timestamp)
  waitReason?: string;       // 等待原因
  checkCommand?: string;     // 检查完成的命令（可选）
  continuePrompt?: string;   // 续接时的 prompt
}

type TaskStatus =
  | 'pending'      // 待开发
  | 'running'      // 开发中
  | 'waiting'      // 等待中（定时续接）
  | 'plan_review'  // 待 Review (Plan 模式)
  | 'completed'    // 已完成
  | 'failed'       // 失败
  | 'cancelled';   // 已取消
```

### TaskLog（任务执行日志）
```typescript
interface TaskLogEntry {
  timestamp: string;
  type: 'assistant' | 'tool_use' | 'tool_result' | 'user' | 'system';
  content: any;           // stream-json 的原始内容
}
```

### PlanInteraction（Plan 模式交互）
```typescript
interface PlanQuestion {
  id: string;
  question: string;
  options: Array<{
    label: string;
    description?: string;
  }>;
  selectedOption?: number;
}
```

---

## API 设计

### REST API

```
# 项目管理
GET    /api/projects              # 获取所有项目
POST   /api/projects              # 创建项目
PUT    /api/projects/:id          # 更新项目
DELETE /api/projects/:id          # 删除项目
POST   /api/projects/:id/test-ssh # 测试 SSH 连接

# 任务管理
GET    /api/projects/:id/tasks    # 获取项目任务列表
POST   /api/projects/:id/tasks    # 创建任务
PUT    /api/tasks/:id             # 更新任务
DELETE /api/tasks/:id             # 删除任务
POST   /api/tasks/:id/cancel      # 取消任务
POST   /api/tasks/:id/retry       # 重试任务

# Plan 模式交互
POST   /api/tasks/:id/plan/answer # 回答 Plan 问题
POST   /api/tasks/:id/plan/confirm # 确认 Plan
POST   /api/tasks/:id/plan/modify  # 修改反馈
```

### WebSocket Events

```
# 客户端 -> 服务器
subscribe:task      # 订阅任务实时更新
unsubscribe:task    # 取消订阅

# 服务器 -> 客户端
task:status         # 任务状态变化
task:output         # Claude Code 输出流
task:plan_question  # Plan 模式问题（需要用户选择）
task:completed      # 任务完成
task:failed         # 任务失败
```

---

## 前端组件结构

```
src/
├── components/
│   ├── Layout/
│   │   └── AppLayout.tsx       # 应用布局
│   │
│   ├── Project/
│   │   ├── ProjectList.tsx     # 项目列表
│   │   ├── ProjectCard.tsx     # 项目卡片
│   │   └── AddProjectModal.tsx # 添加项目弹窗
│   │
│   ├── Task/
│   │   ├── TaskBoard.tsx       # 任务看板
│   │   ├── TaskColumn.tsx      # 任务列（按状态分组）
│   │   ├── TaskCard.tsx        # 任务卡片
│   │   ├── TaskInput.tsx       # 任务输入框（文字+语音）
│   │   └── TaskDetail.tsx      # 任务详情抽屉
│   │
│   ├── Plan/
│   │   ├── PlanView.tsx        # Plan 模式全屏对话视图
│   │   ├── PlanOutput.tsx      # Plan 输出展示（Markdown 渲染）
│   │   ├── PlanQuestion.tsx    # Plan 问题选项组件（卡片式选择）
│   │   ├── PlanActions.tsx     # 底部操作栏（确认/反馈/取消）
│   │   └── PlanTransition.tsx  # Plan 模式过渡动画
│   │
│   └── common/
│       ├── VoiceInput.tsx      # 语音输入组件
│       └── StatusBadge.tsx     # 状态徽章
│
├── hooks/
│   ├── useProjects.ts          # 项目数据管理
│   ├── useTasks.ts             # 任务数据管理
│   ├── useTaskStream.ts        # 任务输出流订阅
│   ├── useVoiceInput.ts        # 语音输入（录音 + Whisper API）
│   └── usePlanSession.ts       # Plan 会话状态管理（含离开恢复）
│
├── pages/
│   ├── HomePage.tsx            # 首页（项目列表）
│   └── ProjectPage.tsx         # 项目页面（任务管理 + Plan 对话）
│
└── services/
    ├── api.ts                  # REST API 调用
    └── websocket.ts            # WebSocket 连接
```

---

## Plan 模式 UI 设计

### 进入 Plan 模式的流程

1. 用户在任务输入框输入任务描述
2. 勾选「Plan 模式」复选框
3. 点击「添加」按钮
4. **丝滑过渡**到 Plan 对话界面（同一页面内切换，不跳转路由）

### 过渡动画设计

使用 `framer-motion` 实现共享元素动画：

```
┌─ 项目页面状态 ─────────────────────────────────────────┐
│  [输入框区域]                                         │
│  [任务看板]                                           │
└───────────────────────────────────────────────────────┘
                    │
                    │ 点击「添加」（Plan 模式）
                    ▼
┌─ 过渡动画 (200-300ms) ────────────────────────────────┐
│  • 输入框区域向下"生长"，扩展为全屏对话区域           │
│  • 任务看板向下滑出 + 淡出                           │
│  • 背景色渐变为对话界面背景                          │
└───────────────────────────────────────────────────────┘
                    │
                    ▼
┌─ Plan 对话状态 ───────────────────────────────────────┐
│  [顶部栏：任务标题 + 关闭按钮]                        │
│  [对话内容区域：Claude 输出 + 选项]                   │
│  [底部操作栏：确认/反馈/取消]                         │
└───────────────────────────────────────────────────────┘
```

### Plan 对话界面布局

```
┌─────────────────────────────────────────────────────────┐
│  ← 返回    任务 #213: 实现用户登录功能          [×]    │
│─────────────────────────────────────────────────────────│
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ 🤖 Claude 正在分析你的需求...                   │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ ## 方案概述                                     │   │
│  │                                                  │   │
│  │ 我将实现一个完整的用户登录功能，包括：          │   │
│  │ 1. 登录表单组件（email + 密码）                 │   │
│  │ 2. 表单验证                                     │   │
│  │ 3. API 集成                                     │   │
│  │ 4. 错误处理                                     │   │
│  │                                                  │   │
│  │ ### 需要确认的问题：                            │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ┌─ ❓ Claude 的问题 ──────────────────────────────┐   │
│  │                                                  │   │
│  │  选择认证方式：                                 │   │
│  │                                                  │   │
│  │  ┌────────────────┐  ┌────────────────┐         │   │
│  │  │     JWT        │  │    Session     │         │   │
│  │  │  ✓ 推荐        │  │   传统方式      │         │   │
│  │  │  无状态、可扩展 │  │   需要服务端存储 │         │   │
│  │  └────────────────┘  └────────────────┘         │   │
│  │                                                  │   │
│  │  ┌────────────────┐                             │   │
│  │  │    OAuth 2.0   │                             │   │
│  │  │   第三方登录    │                             │   │
│  │  └────────────────┘                             │   │
│  │                                                  │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│─────────────────────────────────────────────────────────│
│  ┌──────────────────────────────────────────────────┐  │
│  │ 输入反馈...                              🎤 📎  │  │
│  └──────────────────────────────────────────────────┘  │
│  [确认并创建任务]  [继续对话]  [取消]                   │
└─────────────────────────────────────────────────────────┘
```

### 关键交互细节

1. **选项选择**：点击选项卡片后高亮显示，可以选择多个或切换
2. **继续对话**：用户可以输入额外反馈，Claude 会基于反馈调整方案
3. **确认并创建任务**：确认后，任务进入 `running` 状态，界面丝滑过渡回任务看板
4. **离开后恢复**：对话状态保存在 localStorage/服务端，用户回来后自动恢复到上次位置

### 退出 Plan 模式的过渡

```
┌─ Plan 对话状态 ───────────────────────────────────────┐
│  [全屏对话界面]                                       │
└───────────────────────────────────────────────────────┘
                    │
                    │ 点击「确认并创建任务」或「×」
                    ▼
┌─ 过渡动画 (200-300ms) ────────────────────────────────┐
│  • 对话区域向上收缩回输入框位置                       │
│  • 任务看板从下方滑入 + 淡入                         │
│  • 新任务卡片出现在「开发中」列（带高亮动画）          │
└───────────────────────────────────────────────────────┘
                    │
                    ▼
┌─ 项目页面状态 ─────────────────────────────────────────┐
│  [输入框区域]                                         │
│  [任务看板] ← 新任务卡片闪烁高亮                      │
└───────────────────────────────────────────────────────┘
```

---

## 任务状态机

```
                                    ┌─────────────┐
                                    │  pending    │
                                    └──────┬──────┘
                                           │ 开始执行
                                           ▼
┌──────────────────────────────────────────────────────────────┐
│                        running                                │
│  ┌────────────────┐                    ┌───────────────────┐ │
│  │ 普通模式        │                    │ Plan 模式          │ │
│  │ - 执行中        │                    │ - 需要用户选择      │ │
│  │ - 等待完成      │                    │ - 交互式对话        │ │
│  └───────┬────────┘                    └────────┬──────────┘ │
└──────────┼─────────────────────────────────────┼─────────────┘
           │                                     │
           │                                     ▼
           │                          ┌─────────────────┐
           │                          │  plan_review    │
           │                          │  等待确认/修改   │
           │                          └───────┬─────────┘
           │                                  │ 确认
           │◄─────────────────────────────────┘
           │
     ┌─────┴─────────────────────────┐
     │                               │
     │ 需要等待                       │ 执行完成
     ▼                               │
┌─────────────┐                      │
│  waiting    │                      │
│ 定时轮询等待 │──────────────────────┤
└─────────────┘    检查完成           │
     │                               │
     │ 超时/失败                      ▼
     │                        ┌──────────────┐
     │                        │  Git Merge   │
     │                        └──────┬───────┘
     │                               │
     │                         ┌─────┴─────┐
     │                         │           │
     ▼                         ▼           ▼
┌─────────┐               ┌─────────┐ ┌─────────┐
│ failed  │               │completed│ │ failed  │
└─────────┘               └─────────┘ └─────────┘
```

---

## 任务执行流程

### 1. 创建任务
1. 用户输入 prompt + 选择 Plan 模式 + 选择前序任务
2. 后端创建任务记录，状态为 `pending`
3. 如有前序任务，等待其完成

### 2. 开始执行
1. 通过 SSH 连接到远程服务器
2. 创建 git worktree: `git worktree add -b task-{id} .worktrees/task-{id}`
3. 生成 CLAUDE.md 限制规则（见「执行安全模式」章节）
4. 切换到 worktree 目录
5. 根据安全模式和任务模式执行 Claude Code：

   **Auto 模式**（完全自动）：
   ```bash
   claude -p "{prompt}" \
     --dangerously-skip-permissions \
     --output-format stream-json \
     --include-partial-messages \
     --verbose
   ```

   **Plan 模式**（交互式）：
   ```bash
   claude --permission-mode plan \
     --output-format stream-json \
     --include-partial-messages \
     --verbose
   # 然后通过 stdin 发送 prompt 和后续答案
   ```

5. 实时解析 stream-json 输出，通过 WebSocket 推送到前端

### 3. Plan 模式处理（交互式对话）

**关键发现**：`-p` 模式不支持交互，Plan 模式需要使用交互模式。

#### 两种任务模式

| 模式 | 命令 | 特点 |
|-----|-----|-----|
| **Auto 模式** | `claude -p "prompt" --dangerously-skip-permissions` | 完全自动，无交互 |
| **Plan 模式** | `claude --permission-mode plan` + stdin 交互 | 支持来回对话 |

#### Plan 模式执行流程

```bash
# 1. 启动 Plan 模式（保持 SSH 连接开放）
ssh user@server "cd /project && claude --permission-mode plan --output-format stream-json --verbose"

# 2. 通过 stdin 发送初始 prompt
echo "实现用户登录功能" | ...

# 3. 解析 stream-json 输出，检测 AskUserQuestion
# 4. 前端显示问题，等待用户选择
# 5. 通过 stdin 发送用户答案
# 6. 重复 3-5 直到用户确认 Plan
# 7. 发送 "proceed" 开始执行
```

#### Plan 会话状态

```typescript
interface PlanSession {
  sessionId: string;      // Claude Code 会话 ID
  taskId: string;
  sshConnection: SSHConnection;  // 保持活跃的 SSH 连接
  status: 'analyzing' | 'waiting_user' | 'executing' | 'completed';
  currentQuestion?: {
    question: string;
    options?: Array<{ label: string; description?: string }>;
  };
  conversationHistory: Message[];
}
```

#### 检测用户问题

stream-json 中检测 `AskUserQuestion` 工具调用：

```typescript
if (event.content_block?.type === 'tool_use' &&
    event.content_block.name === 'AskUserQuestion') {
  const { question, options } = event.content_block.input;
  // 更新任务状态为 plan_review
  // 通过 WebSocket 发送问题到前端
  websocket.send({ type: 'task:plan_question', question, options });
}
```

#### 发送用户答案

```typescript
// 用户在前端选择答案后
function sendAnswer(sshConnection: SSHConnection, answer: string) {
  sshConnection.stdin.write(answer + '\n');
}

// 用户确认 Plan 后
function confirmPlan(sshConnection: SSHConnection) {
  sshConnection.stdin.write('proceed\n');
  // 任务状态变为 running
}
```

#### 会话恢复

如果用户离开后回来，使用 `--resume` 恢复：

```bash
claude --resume <session-id> --output-format stream-json
```

### 4. 任务完成
1. Claude Code 执行完成
2. 在 worktree 中提交代码
3. 尝试 merge 到 main 分支:
   ```bash
   git fetch origin main
   git rebase origin/main
   git checkout main
   git merge task-{id}
   git push origin main
   ```
4. 清理 worktree: `git worktree remove .worktrees/task-{id}`
5. 更新任务状态为 `completed`
6. 运行事后验证（Auto 模式），检测越界操作

### 5. 失败处理
- 冲突时：记录错误，状态为 `failed`，保留 worktree
- 安全警告时：状态为 `completed_with_warnings`，通知用户
- 用户可选择重试或手动处理

### 6. 任务完成与等待检测

#### 任务完成检测

stream-json 中检测任务完成：

```typescript
// 监听 message_delta 事件
if (event.delta?.stop_reason === 'end_turn') {
  // Claude 完成了当前回合
  // 但这不一定意味着任务完成
}

// 更可靠：监听 Claude Code 进程退出
sshProcess.on('exit', (code) => {
  if (code === 0) {
    // 任务完成
    updateTaskStatus('completed');
    startGitMerge();
  } else {
    // 任务失败
    updateTaskStatus('failed');
  }
});
```

#### 等待任务检测（定时续接）

Claude Code 可能需要等待某些操作完成（如下载、编译）。Manager 需要能检测到这种情况。

**方案：在 prompt 中要求 Claude 使用特定格式**

在每个任务的 prompt 末尾追加：

```
如果任务需要等待某个操作完成（如下载、编译、测试运行），
请在输出中使用以下格式标记：

[WAITING]
reason: 等待原因（如"等待 npm install 完成"）
check_after: 预计等待时间（如"5m"、"10m"、"1h"）
check_command: 检查完成的命令（可选，如"test -f node_modules/.package-lock.json"）
[/WAITING]
```

**后端解析逻辑**：

```typescript
// 在 text_delta 中检测 WAITING 标记
const waitingPattern = /\[WAITING\]([\s\S]*?)\[\/WAITING\]/;

function parseWaitingBlock(text: string): WaitingInfo | null {
  const match = text.match(waitingPattern);
  if (!match) return null;

  const content = match[1];
  const reason = content.match(/reason:\s*(.+)/)?.[1];
  const checkAfter = content.match(/check_after:\s*(.+)/)?.[1];
  const checkCommand = content.match(/check_command:\s*(.+)/)?.[1];

  return { reason, checkAfter, checkCommand };
}

// 检测到 WAITING 后
function handleWaiting(task: Task, waitingInfo: WaitingInfo) {
  task.status = 'waiting';
  task.waitReason = waitingInfo.reason;
  task.waitingUntil = calculateWaitUntil(waitingInfo.checkAfter);
  task.checkCommand = waitingInfo.checkCommand;

  // 保存任务状态，准备定时续接
  saveTask(task);
}
```

**定时续接服务**：

```typescript
// 每分钟检查 waiting 状态的任务
cron.schedule('* * * * *', async () => {
  const waitingTasks = await getTasksByStatus('waiting');

  for (const task of waitingTasks) {
    if (new Date() >= new Date(task.waitingUntil)) {
      await resumeTask(task);
    }
  }
});

async function resumeTask(task: Task) {
  // 1. 如果有 checkCommand，先执行检查
  if (task.checkCommand) {
    const result = await sshExec(task.project, task.checkCommand);
    if (result.exitCode !== 0) {
      // 还没完成，延长等待时间
      task.waitingUntil = addMinutes(new Date(), 5);
      await saveTask(task);
      return;
    }
  }

  // 2. 继续执行任务
  const continuePrompt = `
之前的任务因等待"${task.waitReason}"而暂停。
请检查操作是否已完成，如果完成，继续完成剩余任务。
如果未完成，请使用 [WAITING]...[/WAITING] 格式告知新的等待时间。
`;

  // 使用 --resume 继续会话
  await executeClaudeCode(task, continuePrompt, { resume: true });
}
```

**前端展示**：

等待中的任务卡片显示：
```
┌──────────────────────────────────────────┐
│  ⏳ 等待中                               │
│  121  下载大型数据集...                   │
│  等待原因: npm install                    │
│  预计恢复: 5分钟后                        │
└──────────────────────────────────────────┘
```

---

## Stream JSON 解析

### 命令格式

```bash
claude -p "{prompt}" \
  --dangerously-skip-permissions \
  --output-format stream-json \
  --include-partial-messages \
  --verbose
```

**重要**：必须加 `--include-partial-messages` 才能获得 token 级实时流。

### 输出格式

输出是 **NDJSON（行分隔 JSON）**，每行一个独立的 JSON 对象，**实时流式输出**（不是任务完成后一次性输出）。

### 事件类型

```typescript
// 1. 消息开始
{"type":"stream_event","event":{"type":"message_start"}}

// 2. 内容块开始（文本）
{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"text"}}}

// 3. 文本增量（实时流出，每个 token 一条）
{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"分析"}}}

// 4. 工具调用开始
{"type":"stream_event","event":{
  "type":"content_block_start",
  "content_block":{
    "type":"tool_use",
    "id":"tool_123",
    "name":"Read",
    "input":{"file_path":"src/index.ts"}
  }
}}

// 5. 内容块结束
{"type":"stream_event","event":{"type":"content_block_stop"}}

// 6. 消息结束
{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"}}}
```

### 解析逻辑

```typescript
async function parseStreamJson(sshStream: ReadableStream) {
  const reader = sshStream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // 保留未完成的行

    for (const line of lines) {
      if (!line.trim()) continue;

      const event = JSON.parse(line);

      if (event.type === 'stream_event') {
        const e = event.event;

        // 实时文本内容
        if (e.delta?.type === 'text_delta') {
          websocket.send({ type: 'task:output', text: e.delta.text });
          // 检测 Plan 模式问题
          checkForPlanQuestion(e.delta.text);
        }

        // 工具调用
        if (e.content_block?.type === 'tool_use') {
          websocket.send({
            type: 'task:tool_use',
            name: e.content_block.name,
            input: e.content_block.input
          });
        }

        // 任务结束
        if (e.delta?.stop_reason === 'end_turn') {
          websocket.send({ type: 'task:completed' });
        }
      }
    }
  }
}
```

### UI 展示规则

- `text_delta`: 实时追加到输出区域（Markdown 渲染）
- `tool_use`: 显示为可折叠的工具调用块
- `content_block_stop` (tool_use): 工具执行完成，等待 tool_result
- Plan 模式问题：检测文本中的选项模式，渲染为可点击选项

---

## PWA 配置

```json
// manifest.json
{
  "name": "Claude Code Manager",
  "short_name": "CCManager",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#1a1a2e",
  "theme_color": "#6366f1",
  "icons": [...]
}
```

---

## 安全考虑

1. **SSH 密钥管理**：
   - 密钥提前存放在云服务器的 `~/.ssh/` 目录
   - 项目配置只存储密钥文件名，不存储密钥内容
   - 前端和 API 不接触密钥内容
2. **API 认证**：添加简单的 API Key 或 JWT 认证
3. **HTTPS**：PWA 要求 HTTPS，需要配置 SSL 证书
4. **WebSocket 安全**：使用 WSS (WebSocket Secure)
5. **OpenAI API Key**：存储在云服务器环境变量，用于 Whisper 语音识别
6. **Claude Code 执行隔离**：见下方「执行安全模式」章节

---

## 执行安全模式

限制 Claude Code 只能修改当前 worktree 内的文件，防止误操作影响其他目录。

### 项目文件夹结构

用户提供的项目路径是一个大的项目文件夹，CCManager 在其下创建 worktrees：

```
/home/user/projects/voice-notes/     # 用户提供给 CCManager 的项目路径
├── .git/                             # Git 仓库
├── src/                              # 主分支代码
├── package.json
├── CLAUDE.md                         # 主分支的 CLAUDE.md（可选）
│
└── .worktrees/                       # CCManager 创建的 worktree 目录
    ├── task-213-20240214/
    │   ├── src/
    │   ├── CLAUDE.md                 # CCManager 生成的限制规则
    │   └── ...
    └── task-214-20240214/
```

### 安全模式对比

| 模式 | 命令参数 | 限制方式 | 适用场景 |
|-----|---------|---------|---------|
| **Auto 模式** | `--dangerously-skip-permissions` | CLAUDE.md 软限制 + 事后验证 | 快速开发，信任 Claude |
| **Safe 模式** | 无 skip permissions | 权限请求路由到用户 | 需要严格控制 |

### 模式切换配置

```typescript
interface Project {
  // ... 其他字段
  securityMode: 'auto' | 'safe';  // 安全模式，可在项目设置中切换
}

interface GlobalConfig {
  defaultSecurityMode: 'auto' | 'safe';  // 新项目的默认模式
}
```

---

### Auto 模式：CLAUDE.md + 事后验证

#### 1. 生成 CLAUDE.md

每个 worktree 创建时，自动生成限制规则文件：

```typescript
// services/claudemd.ts
function generateClaudeMd(worktreePath: string, taskId: string): string {
  return `# CCManager 工作目录规则

## 当前任务
- 任务 ID: ${taskId}
- 工作目录: ${worktreePath}

## 严格限制

**你只能修改当前目录内的文件。**

### 禁止操作

1. ❌ 访问或修改其他 worktree（\`../.worktrees/task-xxx/\`）
2. ❌ 修改主分支文件（\`../src/\`, \`../package.json\` 等）
3. ❌ 修改系统配置文件（\`~/.bashrc\`, \`~/.gitconfig\` 等）
4. ❌ 安装全局包（\`npm install -g\`, \`pip install\` 不带 \`--user\`）
5. ❌ 访问 \`~/.ssh\`, \`~/.aws\` 等敏感目录
6. ❌ 使用绝对路径写入当前目录以外的位置

### 如需例外

如果任务确实需要执行上述操作，你必须：
1. 明确说明原因
2. 使用 [PERMISSION_REQUEST] 标记请求许可
3. 等待用户确认后再执行

示例：
\`\`\`
[PERMISSION_REQUEST]
操作: 安装全局 CLI 工具
原因: 项目需要 typescript 编译器
命令: npm install -g typescript
[/PERMISSION_REQUEST]
\`\`\`
`;
}
```

#### 2. 事后验证

任务完成后，验证是否有越界操作：

```typescript
// services/validation.ts
interface ValidationResult {
  valid: boolean;
  violations: Violation[];
}

interface Violation {
  type: 'file_write' | 'bash_command' | 'absolute_path';
  target: string;
  timestamp: string;
}

class ExecutionValidator {
  async validate(taskId: string, worktreePath: string, logs: TaskLogEntry[]): Promise<ValidationResult> {
    const violations: Violation[] = [];
    const allowedPrefix = worktreePath;

    for (const log of logs) {
      if (log.type === 'tool_use') {
        // 检查 Write/Edit 工具的文件路径
        if (log.name === 'Write' || log.name === 'Edit') {
          const filePath = log.input.file_path;
          if (this.isOutsideWorktree(filePath, allowedPrefix)) {
            violations.push({
              type: 'file_write',
              target: filePath,
              timestamp: log.timestamp
            });
          }
        }

        // 检查 Bash 命令
        if (log.name === 'Bash') {
          const command = log.input.command;
          if (this.isDangerousCommand(command)) {
            violations.push({
              type: 'bash_command',
              target: command,
              timestamp: log.timestamp
            });
          }
        }
      }
    }

    return {
      valid: violations.length === 0,
      violations
    };
  }

  private isOutsideWorktree(filePath: string, worktreePath: string): boolean {
    // 绝对路径且不在 worktree 内
    if (filePath.startsWith('/') && !filePath.startsWith(worktreePath)) {
      return true;
    }
    // 相对路径尝试跳出
    if (filePath.includes('../') && this.resolvesOutside(filePath, worktreePath)) {
      return true;
    }
    return false;
  }

  private isDangerousCommand(command: string): boolean {
    const patterns = [
      /npm\s+install\s+-g/,
      /pip\s+install(?!\s+--user)/,
      /rm\s+-rf\s+\//,
      /chmod\s+777/,
      />(>)?\s*\/etc\//,
      />\s*~\//,
    ];
    return patterns.some(p => p.test(command));
  }

  private resolvesOutside(relativePath: string, worktreePath: string): boolean {
    const resolved = path.resolve(worktreePath, relativePath);
    return !resolved.startsWith(worktreePath);
  }
}
```

#### 3. 验证结果处理

```typescript
// 任务完成后
async function onTaskComplete(task: Task) {
  const logs = await loadTaskLogs(task.id);
  const result = await validator.validate(task.id, task.worktreePath, logs);

  if (!result.valid) {
    // 标记任务有安全警告
    task.securityWarnings = result.violations;
    task.status = 'completed_with_warnings';

    // 通知用户
    websocket.emit('task:security_warning', {
      taskId: task.id,
      violations: result.violations
    });
  }
}
```

---

### Safe 模式：权限请求路由

不使用 `--dangerously-skip-permissions`，让 Claude Code 的权限请求通过 CCManager 路由到用户。

#### 1. 命令变化

```typescript
function buildClaudeCommand(task: Task, project: Project): string {
  const baseCmd = `claude -p "${task.prompt}" --output-format stream-json --verbose`;

  if (project.securityMode === 'auto') {
    return `${baseCmd} --dangerously-skip-permissions`;
  } else {
    // Safe 模式：不跳过权限
    return baseCmd;
  }
}
```

#### 2. 权限请求检测

Claude Code 在需要权限时会输出特定格式：

```typescript
// 解析 stream-json 中的权限请求
interface PermissionRequest {
  id: string;
  type: 'file_write' | 'file_edit' | 'bash' | 'other';
  action: string;        // 'Write to file', 'Run command', etc.
  target: string;        // 文件路径或命令
  description?: string;  // Claude 的解释
}

function parsePermissionRequest(message: StreamMessage): PermissionRequest | null {
  // Claude Code 权限请求格式（需要实际测试确认）
  if (message.type === 'system' && message.subtype === 'permission_request') {
    return {
      id: message.id,
      type: categorizePermission(message.action),
      action: message.action,
      target: message.target,
      description: message.description
    };
  }
  return null;
}
```

#### 3. 自动审批规则

```typescript
// services/autoApprove.ts
class AutoApproveService {
  shouldAutoApprove(request: PermissionRequest, worktreePath: string): boolean {
    // 规则 1: worktree 内的文件操作自动批准
    if (request.type === 'file_write' || request.type === 'file_edit') {
      if (this.isInsideWorktree(request.target, worktreePath)) {
        return true;
      }
    }

    // 规则 2: 安全的 bash 命令自动批准
    if (request.type === 'bash') {
      if (this.isSafeBashCommand(request.target, worktreePath)) {
        return true;
      }
    }

    // 其他情况需要用户确认
    return false;
  }

  private isInsideWorktree(filePath: string, worktreePath: string): boolean {
    const resolved = path.resolve(worktreePath, filePath);
    return resolved.startsWith(path.resolve(worktreePath));
  }

  private isSafeBashCommand(command: string, worktreePath: string): boolean {
    // 白名单命令
    const safePatterns = [
      /^(npm|pnpm|yarn)\s+(install|run|test|build)/,
      /^(git)\s+(status|log|diff|add|commit)/,
      /^(ls|cat|head|tail|grep|find)\s/,
      /^(node|python|go|cargo)\s/,
    ];

    // 黑名单命令
    const dangerousPatterns = [
      /rm\s+-rf\s+\//,
      /npm\s+install\s+-g/,
      /sudo\s/,
      />\s*\//,
    ];

    if (dangerousPatterns.some(p => p.test(command))) {
      return false;
    }

    return safePatterns.some(p => p.test(command));
  }
}
```

#### 4. 权限请求 UI

当需要用户确认时，前端显示权限请求对话框：

```typescript
// WebSocket 事件
interface PermissionRequestEvent {
  taskId: string;
  request: PermissionRequest;
  recommendation: 'approve' | 'deny' | 'review';  // 系统建议
  reason?: string;  // 建议原因
}

// 前端组件
function PermissionDialog({ request, onRespond }: Props) {
  return (
    <Dialog>
      <DialogHeader>
        <AlertTriangle className="text-yellow-500" />
        <span>权限请求</span>
      </DialogHeader>

      <DialogContent>
        <div className="space-y-3">
          <div>
            <Label>操作</Label>
            <p>{request.action}</p>
          </div>
          <div>
            <Label>目标</Label>
            <code className="block bg-gray-100 p-2 rounded">
              {request.target}
            </code>
          </div>
          {request.description && (
            <div>
              <Label>说明</Label>
              <p className="text-gray-600">{request.description}</p>
            </div>
          )}
        </div>
      </DialogContent>

      <DialogFooter>
        <Button variant="outline" onClick={() => onRespond('deny')}>
          拒绝
        </Button>
        <Button variant="outline" onClick={() => onRespond('deny_always')}>
          始终拒绝此类
        </Button>
        <Button onClick={() => onRespond('approve')}>
          允许
        </Button>
        <Button onClick={() => onRespond('approve_always')}>
          始终允许此类
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
```

#### 5. 响应发送

```typescript
// 用户响应后，通过 stdin 发送给 Claude Code
async function sendPermissionResponse(
  sshSession: SSHSession,
  requestId: string,
  response: 'approve' | 'deny'
) {
  // Claude Code 期望的响应格式（需要实际测试确认）
  const responseText = response === 'approve' ? 'y' : 'n';
  await sshSession.stdin.write(responseText + '\n');
}
```

---

### 安全模式切换 UI

在项目设置中提供切换选项：

```typescript
function ProjectSettings({ project }: Props) {
  return (
    <div className="space-y-6">
      <div>
        <Label>执行安全模式</Label>
        <RadioGroup
          value={project.securityMode}
          onChange={(mode) => updateProject({ securityMode: mode })}
        >
          <RadioItem value="auto">
            <div>
              <span className="font-medium">Auto 模式</span>
              <span className="text-gray-500 text-sm ml-2">
                快速执行，事后验证
              </span>
            </div>
            <p className="text-sm text-gray-500">
              Claude Code 自动执行所有操作，任务完成后检查是否有越界行为。
              适合快速开发，信任 Claude 的判断。
            </p>
          </RadioItem>

          <RadioItem value="safe">
            <div>
              <span className="font-medium">Safe 模式</span>
              <span className="text-yellow-600 text-sm ml-2">
                逐项确认
              </span>
            </div>
            <p className="text-sm text-gray-500">
              Claude Code 执行敏感操作前需要你确认。
              worktree 内的文件操作自动批准，其他操作需要手动确认。
            </p>
          </RadioItem>
        </RadioGroup>
      </div>
    </div>
  );
}
```

---

### 任务状态扩展

```typescript
type TaskStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'waiting_permission'    // 新增：等待用户批准权限
  | 'plan_review'
  | 'completed'
  | 'completed_with_warnings'  // 新增：完成但有安全警告
  | 'failed'
  | 'cancelled';

interface Task {
  // ... 其他字段
  securityWarnings?: Violation[];  // Auto 模式下的事后验证警告
  pendingPermission?: PermissionRequest;  // Safe 模式下等待的权限请求
}

---

## Claude Code 认证配置

### 认证方式对比

| 方式 | 计费方式 | 适合场景 | 配置复杂度 |
|-----|---------|---------|----------|
| **setup-token (推荐)** | Pro/Max 订阅额度 | 想使用订阅额度 | 中等 |
| **API Key** | 按量计费 | 不想用订阅额度 | 简单 |

---

### 方式 A：setup-token（使用 Pro/Max 订阅额度）

#### 1. 在本地生成 token

```bash
# 在本地机器（有浏览器）运行
claude setup-token

# 会输出类似：
# Your Claude Code token: clt_xxxxxxxxxxxx
# This token expires in 1 year.
```

#### 2. 在远程服务器配置

```bash
# 1. 设置环境变量
export CLAUDE_CODE_OAUTH_TOKEN="clt_xxxxxxxxxxxx"

# 2. 创建配置文件跳过 onboarding（关键！）
mkdir -p ~/.claude
cat > ~/.claude.json << 'EOF'
{
  "hasCompletedOnboarding": true
}
EOF

# 3. 测试
claude -p "hello" --output-format json
```

**注意**：仅设置环境变量不够，必须同时设置 `hasCompletedOnboarding: true`。

#### 3. CCManager 后端集成

```typescript
const execClaudeCode = async (ssh: SSHConnection, project: Project, prompt: string) => {
  // 使用 OAuth token（订阅额度）
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

  const command = `
    export CLAUDE_CODE_OAUTH_TOKEN="${oauthToken}"
    cd ${project.projectPath}
    claude -p "${escapePrompt(prompt)}" \\
      --dangerously-skip-permissions \\
      --output-format stream-json \\
      --include-partial-messages \\
      --verbose
  `;

  return ssh.exec(command);
};
```

---

### 方式 B：API Key（按量计费）

#### 1. 生成 API Key

访问：https://console.anthropic.com/settings/keys

生成 API Key（格式：`sk-ant-xxxxx`）

#### 2. 在远程服务器配置

```bash
export ANTHROPIC_API_KEY="sk-ant-xxxxx"
```

#### 3. CCManager 后端集成

```typescript
const execClaudeCode = async (ssh: SSHConnection, project: Project, prompt: string) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  const command = `
    export ANTHROPIC_API_KEY="${apiKey}"
    cd ${project.projectPath}
    claude -p "${escapePrompt(prompt)}" \\
      --dangerously-skip-permissions \\
      --output-format stream-json \\
      --include-partial-messages \\
      --verbose
  `;

  return ssh.exec(command);
};
```

---

### 远程服务器初始化脚本

CCManager 在添加新项目时，可以自动执行初始化：

```bash
#!/bin/bash
# init-claude-code.sh

# 创建配置目录
mkdir -p ~/.claude

# 设置 onboarding 完成标记
cat > ~/.claude.json << 'EOF'
{
  "hasCompletedOnboarding": true
}
EOF

# 验证 Claude Code 可用
claude --version

echo "Claude Code 初始化完成"
```

### 同时支持两种认证方式

CCManager 同时支持 setup-token（订阅额度）和 API Key（按量计费），用户可以：
- 在全局配置中设置默认认证方式
- 为每个项目单独配置认证方式

#### 数据模型

```typescript
// 全局配置
interface GlobalConfig {
  defaultAuthType: 'oauth' | 'apikey';
  oauthToken?: string;       // setup-token
  anthropicApiKey?: string;  // API Key
}

// 项目配置（可覆盖全局）
interface Project {
  // ... 现有字段
  authType?: 'oauth' | 'apikey';  // 不设置则使用全局
  oauthToken?: string;
  anthropicApiKey?: string;
}
```

#### 设置页面 UI

```
┌───────────────────────────────────────────────────────────┐
│  设置                                               [×]   │
│───────────────────────────────────────────────────────────│
│                                                           │
│  Claude Code 认证                                         │
│  ──────────────────────────────                          │
│                                                           │
│  认证方式：                                               │
│  ○ setup-token（使用订阅额度，推荐）                      │
│  ○ API Key（按量计费）                                    │
│                                                           │
│  ┌─ setup-token ─────────────────────────────────────┐   │
│  │ Token: [clt_xxxxxxxxxxxxxxxxxx__________]         │   │
│  │ 状态: ✅ 有效（2025年2月到期）                     │   │
│  │ [重新生成] 在本地运行 `claude setup-token`        │   │
│  └───────────────────────────────────────────────────┘   │
│                                                           │
│  ┌─ API Key ─────────────────────────────────────────┐   │
│  │ Key: [sk-ant-xxxxxxxxxxxxxxxx___________]         │   │
│  │ [获取 API Key](https://console.anthropic.com)     │   │
│  └───────────────────────────────────────────────────┘   │
│                                                           │
│───────────────────────────────────────────────────────────│
│                                         [取消]  [保存]    │
└───────────────────────────────────────────────────────────┘
```

#### 认证选择逻辑

```typescript
// services/auth.ts
function getAuthEnv(project: Project, globalConfig: GlobalConfig): string {
  // 1. 优先使用项目配置
  const authType = project.authType || globalConfig.defaultAuthType;
  const oauthToken = project.oauthToken || globalConfig.oauthToken;
  const apiKey = project.anthropicApiKey || globalConfig.anthropicApiKey;

  // 2. 根据类型选择
  if (authType === 'oauth' && oauthToken) {
    return `export CLAUDE_CODE_OAUTH_TOKEN="${oauthToken}"`;
  } else if (apiKey) {
    return `export ANTHROPIC_API_KEY="${apiKey}"`;
  }

  throw new Error('No valid authentication configured');
}

// 验证 token 是否有效
async function validateOAuthToken(token: string): Promise<{
  valid: boolean;
  expiresAt?: Date;
  error?: string;
}> {
  // 尝试调用一个简单命令验证
  try {
    const result = await execClaudeCode(`
      export CLAUDE_CODE_OAUTH_TOKEN="${token}"
      claude --version
    `);
    return { valid: result.exitCode === 0 };
  } catch (error) {
    return { valid: false, error: String(error) };
  }
}
```

#### API 端点

```typescript
// routes/settings.ts

// 获取全局配置
GET /api/settings

// 更新全局配置
PUT /api/settings
Body: {
  defaultAuthType: 'oauth' | 'apikey',
  oauthToken?: string,
  anthropicApiKey?: string
}

// 验证认证
POST /api/settings/validate-auth
Body: { type: 'oauth' | 'apikey', token: string }
Response: { valid: boolean, expiresAt?: string, error?: string }
```

### Token 有效期

- **setup-token**：1 年有效期
- **API Key**：永久有效（除非手动撤销）

建议在 CCManager 中记录 token 创建时间，在临近过期时提醒用户更新。

Sources:
- [GitHub Issue #8938](https://github.com/anthropics/claude-code/issues/8938)

---

## 项目目录结构

```
ccmanager/
├── packages/
│   ├── web/                    # 前端 React 应用
│   │   ├── src/
│   │   ├── public/
│   │   ├── index.html
│   │   ├── vite.config.ts
│   │   └── package.json
│   │
│   └── server/                 # 后端 Node.js 服务
│       ├── src/
│       │   ├── routes/
│       │   ├── services/
│       │   │   ├── ssh.ts      # SSH 连接管理
│       │   │   ├── task.ts     # 任务执行
│       │   │   ├── git.ts      # Git worktree 管理
│       │   │   └── storage.ts  # JSON 文件存储
│       │   ├── websocket/
│       │   └── index.ts
│       └── package.json
│
├── data/                       # 数据存储（JSON 文件）
│   ├── projects.json
│   └── tasks/
│
└── package.json                # Monorepo 根配置
```

---

## 实施步骤

### Phase 1: 基础架构
1. 初始化 monorepo 项目结构
2. 搭建 React + Vite 前端脚手架
3. 搭建 Node.js 后端服务
4. 实现 JSON 文件存储服务（带文件锁）

### Phase 2: 项目管理
5. 实现项目 CRUD API
6. 实现首页项目列表 UI
7. 实现添加项目功能
8. 实现 SSH 连接测试

### Phase 3: 任务管理基础
9. 实现任务 CRUD API
10. 实现任务看板 UI
11. 实现任务输入（文字）
12. 实现语音输入

### Phase 4: Claude Code 集成
13. 实现 SSH 命令执行服务
14. 实现 Git worktree 管理
15. 实现 Claude Code 调用和 stream-json 解析
16. 实现 WebSocket 实时推送
17. 实现等待任务检测与定时续接机制

### Phase 5: Plan 模式
18. 实现 Plan 模式输出解析
19. 实现 Plan 交互 UI（选项、确认、反馈）
20. 实现 Plan 对话流程

### Phase 6: 完善与部署
21. 配置 PWA (manifest, service worker)
22. 添加 API 认证
23. 部署到云服务器
24. 配置 HTTPS

---

## 后端架构细节

### SSH 连接管理

```typescript
import { Client } from 'ssh2';

interface SSHConnectionPool {
  connections: Map<string, {
    client: Client;
    lastUsed: Date;
    isInteractive: boolean;  // Plan 模式长连接
  }>;
  maxIdleTime: number;  // 5 分钟

  async getConnection(project: Project): Promise<Client>;
  releaseConnection(projectId: string): void;
  closeIdleConnections(): void;
}

class SSHPool implements SSHConnectionPool {
  connections = new Map();
  maxIdleTime = 5 * 60 * 1000;

  async getConnection(project: Project) {
    const existing = this.connections.get(project.id);
    if (existing && existing.client.connected) {
      existing.lastUsed = new Date();
      return existing.client;
    }

    const client = new Client();
    await new Promise((resolve, reject) => {
      client.on('ready', resolve);
      client.on('error', reject);
      client.connect({
        host: project.sshHost,
        username: project.sshUser,
        privateKey: fs.readFileSync(project.sshKeyPath),
      });
    });

    this.connections.set(project.id, {
      client,
      lastUsed: new Date(),
      isInteractive: false,
    });

    return client;
  }

  // 每分钟清理空闲连接
  startCleanup() {
    setInterval(() => {
      const now = Date.now();
      for (const [id, conn] of this.connections) {
        if (!conn.isInteractive && now - conn.lastUsed.getTime() > this.maxIdleTime) {
          conn.client.end();
          this.connections.delete(id);
        }
      }
    }, 60 * 1000);
  }
}
```

### 任务队列

```typescript
interface TaskQueue {
  // 同一项目最多并行 2 个任务
  maxConcurrentPerProject: number;

  add(task: Task): void;
  getNext(projectId: string): Task | null;
  markRunning(taskId: string): void;
  markCompleted(taskId: string): void;
}

// 简单实现（单机）
class InMemoryTaskQueue implements TaskQueue {
  private pending: Map<string, Task[]> = new Map();  // projectId -> tasks
  private running: Map<string, Set<string>> = new Map();  // projectId -> taskIds
  maxConcurrentPerProject = 2;

  add(task: Task) {
    const queue = this.pending.get(task.projectId) || [];
    queue.push(task);
    this.pending.set(task.projectId, queue);
    this.processQueue(task.projectId);
  }

  private async processQueue(projectId: string) {
    const runningCount = this.running.get(projectId)?.size || 0;
    if (runningCount >= this.maxConcurrentPerProject) return;

    const queue = this.pending.get(projectId) || [];
    const next = queue.find(t => !t.dependsOn || this.isCompleted(t.dependsOn));

    if (next) {
      this.markRunning(next.id);
      this.executeTask(next);
    }
  }

  private async executeTask(task: Task) {
    // 执行 Claude Code
  }
}
```

### 并发处理

- 同一项目最多 2 个并行任务（避免 git worktree 冲突）
- 不同项目可以完全并行
- Plan 模式任务独占连接直到完成

---

## 部署方案（阿里云 ECS）

### 服务器配置建议

| 配置项 | 推荐值 | 说明 |
|-------|-------|------|
| 实例类型 | ecs.c6.large (2C4G) | 起步够用，后续可升级 |
| 系统 | Ubuntu 22.04 LTS | 稳定、Node.js 支持好 |
| 存储 | 40GB SSD | 系统 + 应用 + 日志 |
| 带宽 | 按量付费 | PWA + WebSocket 不需太大 |

### 架构图

```
┌─────────────────────────────────────────────────────────┐
│                    阿里云 ECS                           │
│                                                         │
│  ┌─────────────┐      ┌─────────────┐                  │
│  │   Nginx     │      │   Node.js   │                  │
│  │  (反向代理)  │─────▶│  CCManager  │                  │
│  │  SSL 终止   │      │   Backend   │                  │
│  └─────────────┘      └──────┬──────┘                  │
│        ▲                     │                         │
│        │                     ▼                         │
│        │              ┌─────────────┐                  │
│   HTTPS/WSS          │  SSH Pool   │                  │
│        │              └──────┬──────┘                  │
└────────┼─────────────────────┼─────────────────────────┘
         │                     │
         ▼                     ▼ SSH
    ┌─────────┐         ┌─────────────┐
    │ iOS/Mac │         │ 项目服务器   │
    │  PWA    │         │ Claude Code │
    └─────────┘         └─────────────┘
```

### 部署步骤

#### 1. 服务器初始化

```bash
# 更新系统
sudo apt update && sudo apt upgrade -y

# 安装 Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 安装 pnpm
npm install -g pnpm

# 安装 Nginx
sudo apt install -y nginx

# 安装 PM2（进程管理）
npm install -g pm2
```

#### 2. 配置 SSL（免费证书）

使用阿里云免费 SSL 证书或 Let's Encrypt：

```bash
# Let's Encrypt 方式
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d ccmanager.yourdomain.com
```

#### 3. Nginx 配置

```nginx
# /etc/nginx/sites-available/ccmanager
server {
    listen 443 ssl http2;
    server_name ccmanager.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/ccmanager.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ccmanager.yourdomain.com/privkey.pem;

    # 前端静态文件
    location / {
        root /var/www/ccmanager/web/dist;
        try_files $uri $uri/ /index.html;
    }

    # 后端 API
    location /api {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # WebSocket
    location /ws {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;  # 长连接
    }
}

server {
    listen 80;
    server_name ccmanager.yourdomain.com;
    return 301 https://$server_name$request_uri;
}
```

#### 4. 部署应用

```bash
# 克隆代码（包含代码和数据）
cd /var/www
git clone <your-repo> ccmanager
cd ccmanager

# 配置 git 用户信息（用于数据自动提交）
git config user.name "CCManager Bot"
git config user.email "ccmanager@yourdomain.com"

# 确保数据目录存在
mkdir -p data/projects

# 安装依赖
pnpm install

# 构建前端
cd packages/web && pnpm build

# 配置环境变量
cat > packages/server/.env << 'EOF'
PORT=3001
CLAUDE_CODE_OAUTH_TOKEN=your_token_here
OPENAI_API_KEY=your_key_here
EOF

# 启动后端
cd packages/server
pm2 start dist/index.js --name ccmanager

# 开机自启
pm2 save
pm2 startup
```

#### 5. 安全配置

```bash
# 阿里云安全组规则
# 入站：443 (HTTPS), 80 (HTTP)
# 出站：22 (SSH 到项目服务器), 443 (API 调用)

# 服务器防火墙
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable
```

### 更新部署

```bash
#!/bin/bash
# deploy.sh

cd /var/www/ccmanager
git pull origin main

# 重新构建前端
cd packages/web && pnpm build

# 重启后端
pm2 restart ccmanager
```

---

## 开发测试脚本

### dev-deploy.sh

一键开发部署脚本，只需配置 setup-token 即可：

```bash
#!/bin/bash
# dev-deploy.sh
# 使用方法：./dev-deploy.sh

#============= 配置区域 =============
# 1. 你的 Claude Code setup-token（运行 claude setup-token 获取）
CLAUDE_CODE_OAUTH_TOKEN="clt_xxxxxxxxxx"

# 2. 远程服务器 SSH 配置
REMOTE_HOST="your-server-ip"
REMOTE_USER="root"
REMOTE_KEY="~/.ssh/id_rsa"  # SSH 私钥路径

# 3. 远程部署路径
REMOTE_PATH="/var/www/ccmanager"

# 4. OpenAI API Key（语音识别用）
OPENAI_API_KEY="sk-xxx"
#====================================

set -e

echo "🚀 CCManager 开发部署脚本"
echo "========================="

# 1. 本地构建
echo "📦 构建前端..."
cd packages/web && pnpm build && cd ../..

echo "📦 编译后端..."
cd packages/server && pnpm build && cd ../..

# 2. 同步到远程
echo "📤 同步文件到远程服务器..."
rsync -avz --exclude 'node_modules' --exclude '.git' \
  -e "ssh -i $REMOTE_KEY" \
  . $REMOTE_USER@$REMOTE_HOST:$REMOTE_PATH

# 3. 远程配置和启动
echo "⚙️ 远程配置..."
ssh -i $REMOTE_KEY $REMOTE_USER@$REMOTE_HOST << EOF
  cd $REMOTE_PATH

  # 安装依赖
  pnpm install --prod

  # 配置环境变量
  cat > packages/server/.env << 'ENVEOF'
PORT=3001
CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN
OPENAI_API_KEY=$OPENAI_API_KEY
ENVEOF

  # 配置 Claude Code（远程服务器上）
  mkdir -p ~/.claude
  echo '{"hasCompletedOnboarding": true}' > ~/.claude.json

  # 重启服务
  pm2 delete ccmanager 2>/dev/null || true
  cd packages/server
  pm2 start dist/index.js --name ccmanager

  echo "✅ 服务已启动"
  pm2 status
EOF

echo ""
echo "✅ 部署完成！"
echo "🌐 访问: https://$REMOTE_HOST (需要先配置 Nginx + SSL)"
echo "🔧 或本地开发: http://$REMOTE_HOST:3001"
```

### 本地开发启动脚本

```bash
#!/bin/bash
# dev.sh
# 本地开发用

# 配置
export CLAUDE_CODE_OAUTH_TOKEN="clt_xxxxxxxxxx"
export OPENAI_API_KEY="sk-xxx"

# 启动后端（开发模式）
echo "🚀 启动后端..."
cd packages/server
pnpm dev &

# 启动前端
echo "🚀 启动前端..."
cd ../web
pnpm dev
```

---

## 任务卡片 UI 设计

### 基础卡片（收起状态）
```
┌──────────────────────────────────────────┐
│  ● 待 Review                       ∨    │ ← 状态徽章 + 展开按钮
│  ─────────────────────────────────────── │
│  213  [Plan] 我对文档的细节有比         │ ← 任务ID + 标签 + 标题
│       较强迫症的需求，如中英文...        │
│  ─────────────────────────────────────── │
│  完成: 2月14日 00:19                     │ ← 时间戳
└──────────────────────────────────────────┘
```

### 展开卡片
```
┌──────────────────────────────────────────┐
│  ● 待 Review                       ∧    │
│  213  [Plan] 我对文档的细节有...        │
│                                          │
│  ## 概述                                 │ ← 展开内容（Markdown）
│  用户希望文档自动遵循中文排版规范...     │
│                                          │
│  完成: 2月14日 00:19                     │
│  [查看详情] [重试] [删除]                │ ← 操作按钮
└──────────────────────────────────────────┘
```

### 失败状态
```
┌──────────────────────────────────────────┐
│  ✕ 失败                            ∨    │ ← 红色
│  121  相册等功能有自己的 URL...          │
│  失败: 8天前                             │
│  [🔄 重试]  [🗑 删除]                     │
└──────────────────────────────────────────┘
```

---

## 语音输入 UI 设计

### 常态
```
┌────────────────────────────────────────────────┐
│  添加新任务...                         🎤  添加 │
└────────────────────────────────────────────────┘
```

### 录音中（内联）
```
┌────────────────────────────────────────────────┐
│  🔴 录音中 00:05                  [■ 停止] 添加 │
└────────────────────────────────────────────────┘
```

### 转写中
```
┌────────────────────────────────────────────────┐
│  ⏳ 正在转写语音...                        添加 │
└────────────────────────────────────────────────┘
```

### 转写完成
```
┌────────────────────────────────────────────────┐
│  帮我实现用户登录功能...               🎤  添加 │
└────────────────────────────────────────────────┘
```

---

## 首页/项目列表 UI 设计

### 项目列表
```
┌─────────────────────────────────────────────────────────┐
│  CCManager                                    ⚙️  👤   │
│─────────────────────────────────────────────────────────│
│                                                         │
│  我的项目                                    [+ 添加]   │
│                                                         │
│  ┌─────────────────┐  ┌─────────────────┐              │
│  │ 📁 Voice Notes  │  │ 📁 Blog Engine  │              │
│  │ ──────────────  │  │ ──────────────  │              │
│  │ 209 个任务      │  │ 45 个任务       │              │
│  │ ● 2 开发中      │  │ ● 1 开发中      │              │
│  │ ○ 3 待开发      │  │ ○ 0 待开发      │              │
│  │ 最近: 5分钟前   │  │ 最近: 2天前     │              │
│  └─────────────────┘  └─────────────────┘              │
└─────────────────────────────────────────────────────────┘
```

### 添加项目弹窗
```
┌───────────────────────────────────────────────┐
│  添加新项目                             [×]   │
│───────────────────────────────────────────────│
│  项目名称: [________________]                 │
│  SSH 连接: [user@192.168.1.100__]             │
│  SSH 密钥: [~/.ssh/id_rsa________]            │
│  项目路径: [/home/user/project___]            │
│                                               │
│  [测试连接]  ✅ 连接成功                      │
│───────────────────────────────────────────────│
│                      [取消]  [添加项目]       │
└───────────────────────────────────────────────┘
```

---

## 任务详情页面 UI 设计

点击任务卡片后，任务详情以 **底部弹出面板（Bottom Sheet）** 方式展示：
- iOS 风格，从底部滑出
- 覆盖约 80% 屏幕高度
- 顶部有拖动条，可上滑展开到全屏
- 下滑可收起/关闭
- 背景任务看板变暗但可见

```
项目页面（任务看板）
       │ 点击任务卡片
       ▼
┌─────────────────────────────────────────────────────────┐
│  （任务看板变暗）                                       │
│                                                         │
│                                                         │
├─ ═══════════════════════════════════════════════════ ──┤ ← 拖动条
│                                                         │
│  任务 #213                                  ● 已完成    │
│  任务描述 / 执行日志 / Git 提交 / 操作按钮             │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 已完成任务详情
```
┌─────────────────────────────────────────────────────────────────┐
│  ← 返回                                                   [×]   │
│─────────────────────────────────────────────────────────────────│
│  任务 #213                                      ● 已完成        │
│                                                                 │
│  ## 任务描述                                                    │
│  实现用户登录功能，支持 JWT 认证...                             │
│                                                                 │
│  ## 执行信息                                                    │
│  创建: 2024-02-14 00:15 | 完成: 00:19 | 耗时: 4分钟            │
│  分支: task-213                                                 │
│                                                                 │
│  ## 执行日志                              [展开全部] [复制]     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 🤖 分析任务需求...                                       │   │
│  │ 📂 Read: src/components/Login.tsx                        │   │
│  │ ✏️ Edit: src/components/Login.tsx (修改 12-35 行)        │   │
│  │ ✏️ Write: src/services/auth.ts (新建 78 行)              │   │
│  │ 🔧 Bash: npm test → ✅ 通过                              │   │
│  │ ✅ 任务完成                                              │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ## Git 提交                                                    │
│  commit abc1234 - feat: implement JWT authentication            │
│                                                                 │
│  [查看代码变更]  [重新执行]  [删除任务]                         │
└─────────────────────────────────────────────────────────────────┘
```

### 执行中任务详情
```
┌─────────────────────────────────────────────────────────────────┐
│  任务 #214                               ● 执行中  ⏱️ 2:35     │
│                                                                 │
│  ## 实时执行日志                                    [自动滚动]  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 🤖 分析问题原因...                                       │   │
│  │ 📂 Read: src/services/sync.ts                            │   │
│  │ 🤖 发现问题：图片加载是串行的...                         │   │
│  │ ✏️ Edit: src/services/image-loader.ts                    │   │
│  │ ▌                                        ← 光标闪烁      │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  [取消执行]                                                     │
└─────────────────────────────────────────────────────────────────┘
```

### 失败任务详情
```
┌─────────────────────────────────────────────────────────────────┐
│  任务 #121                                      ✕ 失败          │
│                                                                 │
│  ## 错误信息                                                    │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ ❌ Git merge 冲突                                        │   │
│  │ 冲突文件: src/components/Album.tsx, src/styles/album.css │   │
│  │ 分支 task-121 保留在服务器上，可手动解决后重试           │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  [重试（从头）]  [重试（从合并）]  [删除任务]                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 语音输入完整实现

### 前端录音

使用 Web Audio API + MediaRecorder：

```typescript
// hooks/useVoiceInput.ts
export function useVoiceInput() {
  const [isRecording, setIsRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const startRecording = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mediaRecorder = new MediaRecorder(stream, {
      mimeType: 'audio/webm;codecs=opus'  // iOS Safari 支持
    });

    mediaRecorder.ondataavailable = (e) => {
      chunksRef.current.push(e.data);
    };

    mediaRecorder.start(1000);  // 每秒收集一次数据
    mediaRecorderRef.current = mediaRecorder;
    setIsRecording(true);

    // 计时器
    const timer = setInterval(() => setDuration(d => d + 1), 1000);
    return () => clearInterval(timer);
  };

  const stopRecording = async (): Promise<Blob> => {
    return new Promise((resolve) => {
      const mediaRecorder = mediaRecorderRef.current!;
      mediaRecorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        chunksRef.current = [];
        resolve(blob);
      };
      mediaRecorder.stop();
      mediaRecorder.stream.getTracks().forEach(t => t.stop());
      setIsRecording(false);
      setDuration(0);
    });
  };

  return { isRecording, duration, startRecording, stopRecording };
}
```

### 后端 Whisper API 调用

```typescript
// routes/voice.ts
import OpenAI from 'openai';
import multer from 'multer';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } });  // 25MB 限制

router.post('/api/voice/transcribe', upload.single('audio'), async (req, res) => {
  try {
    const audioFile = req.file;
    if (!audioFile) {
      return res.status(400).json({ error: 'No audio file' });
    }

    // 转换为 Whisper 支持的格式
    const transcription = await openai.audio.transcriptions.create({
      file: new File([audioFile.buffer], 'audio.webm', { type: 'audio/webm' }),
      model: 'whisper-1',
      language: 'zh',  // 中文优化
    });

    res.json({ text: transcription.text });
  } catch (error) {
    console.error('Whisper API error:', error);
    res.status(500).json({ error: 'Transcription failed' });
  }
});
```

---

## JSON 文件并发写入

使用 `proper-lockfile` 库实现文件锁：

```typescript
// services/storage.ts
import lockfile from 'proper-lockfile';
import fs from 'fs/promises';

class JSONStorage {
  private basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  async read<T>(filename: string): Promise<T | null> {
    const filePath = `${this.basePath}/${filename}`;
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  async write<T>(filename: string, data: T): Promise<void> {
    const filePath = `${this.basePath}/${filename}`;

    // 确保目录存在
    await fs.mkdir(this.basePath, { recursive: true });

    // 获取文件锁
    const release = await lockfile.lock(filePath, {
      retries: { retries: 5, minTimeout: 100, maxTimeout: 1000 },
      stale: 10000,  // 10 秒后认为锁过期
    });

    try {
      await fs.writeFile(filePath, JSON.stringify(data, null, 2));
    } finally {
      await release();
    }
  }

  async update<T>(filename: string, updater: (data: T) => T): Promise<T> {
    const filePath = `${this.basePath}/${filename}`;

    const release = await lockfile.lock(filePath, {
      retries: { retries: 5, minTimeout: 100, maxTimeout: 1000 },
    });

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const data = JSON.parse(content) as T;
      const updated = updater(data);
      await fs.writeFile(filePath, JSON.stringify(updated, null, 2));
      return updated;
    } finally {
      await release();
    }
  }
}
```

---

## 任务取消机制

### 停止 Claude Code 进程

```typescript
// services/task.ts
class TaskExecutor {
  private runningProcesses: Map<string, {
    sshStream: ClientChannel;
    pid?: number;
  }> = new Map();

  async cancelTask(taskId: string): Promise<void> {
    const process = this.runningProcesses.get(taskId);
    if (!process) return;

    // 1. 发送 SIGTERM 信号
    if (process.pid) {
      process.sshStream.write(`kill -TERM ${process.pid}\n`);
    }

    // 2. 等待 5 秒
    await new Promise(r => setTimeout(r, 5000));

    // 3. 如果还在运行，强制结束
    if (this.runningProcesses.has(taskId)) {
      process.sshStream.write(`kill -9 ${process.pid}\n`);
      process.sshStream.close();
    }

    // 4. 更新任务状态
    await this.storage.update(`tasks/${taskId}.json`, (task: Task) => ({
      ...task,
      status: 'cancelled',
      completedAt: new Date().toISOString(),
    }));

    // 5. 清理 worktree（可选，保留以便恢复）
    // await this.cleanupWorktree(taskId);

    this.runningProcesses.delete(taskId);
  }

  // 获取远程进程 PID
  private async getRemotePid(sshStream: ClientChannel, command: string): Promise<number> {
    return new Promise((resolve) => {
      sshStream.write(`${command} & echo $!\n`);
      sshStream.once('data', (data: Buffer) => {
        const pid = parseInt(data.toString().trim());
        resolve(pid);
      });
    });
  }
}
```

---

## Git Worktree 完整操作

### Worktree 命名规则

```typescript
// 命名格式：task-{taskId}-{timestamp}
// 例如：task-213-20240214-001523

function generateWorktreeName(taskId: number): string {
  const timestamp = new Date().toISOString()
    .replace(/[-:T]/g, '')
    .slice(0, 15);  // 20240214001523
  return `task-${taskId}-${timestamp}`;
}

// 或者使用更简短的格式：task-{taskId}
// 如果同一任务可能重试多次，建议加时间戳避免冲突
```

### 创建 Worktree

```typescript
// services/git.ts
class GitWorktreeManager {
  async createWorktree(ssh: Client, project: Project, taskId: string): Promise<string> {
    const branchName = `task-${taskId}`;
    const worktreePath = `.worktrees/${branchName}`;
    const fullWorktreePath = `${project.projectPath}/${worktreePath}`;

    const commands = [
      // 1. 确保在主仓库目录
      `cd ${project.projectPath}`,

      // 2. 确保 .worktrees 目录存在
      `mkdir -p .worktrees`,

      // 3. 获取最新代码
      `git fetch origin main`,

      // 4. 创建 worktree 和分支
      `git worktree add -b ${branchName} ${worktreePath} origin/main`,
    ];

    const result = await this.execSSH(ssh, commands.join(' && '));

    if (result.exitCode !== 0) {
      throw new Error(`Failed to create worktree: ${result.stderr}`);
    }

    // 5. 生成 CLAUDE.md 限制规则
    await this.generateClaudeMd(ssh, fullWorktreePath, taskId);

    return fullWorktreePath;
  }

  // 生成 CLAUDE.md 限制规则
  private async generateClaudeMd(ssh: Client, worktreePath: string, taskId: string): Promise<void> {
    const claudeMdContent = `# CCManager 工作目录规则

## 当前任务
- 任务 ID: ${taskId}
- 工作目录: ${worktreePath}

## 严格限制

**你只能修改当前目录内的文件。**

### 禁止操作

1. ❌ 访问或修改其他 worktree（\`../.worktrees/task-xxx/\` 或 \`../task-xxx/\`）
2. ❌ 修改主分支文件（上级目录的 \`../src/\`, \`../package.json\` 等）
3. ❌ 修改系统配置文件（\`~/.bashrc\`, \`~/.gitconfig\` 等）
4. ❌ 安装全局包（\`npm install -g\`, \`pip install\` 不带 \`--user\`）
5. ❌ 访问敏感目录（\`~/.ssh\`, \`~/.aws\`, \`/etc/\`）
6. ❌ 使用绝对路径写入当前目录以外的位置

### 如需例外

如果任务确实需要执行上述操作，你必须：
1. 明确说明原因
2. 使用 [PERMISSION_REQUEST] 标记请求许可
3. 等待用户确认后再执行

示例：
\\\`\\\`\\\`
[PERMISSION_REQUEST]
操作: 安装全局 CLI 工具
原因: 项目需要 typescript 编译器
命令: npm install -g typescript
[/PERMISSION_REQUEST]
\\\`\\\`\\\`
`;

    // 写入 CLAUDE.md
    const escapedContent = claudeMdContent.replace(/'/g, "'\\''");
    await this.execSSH(ssh, `cat > ${worktreePath}/CLAUDE.md << 'CLAUDEMD_EOF'
${claudeMdContent}
CLAUDEMD_EOF`);
  }

  async mergeWorktree(ssh: Client, project: Project, taskId: string): Promise<MergeResult> {
    const branchName = `task-${taskId}`;
    const worktreePath = `.worktrees/${branchName}`;
    const fullWorktreePath = `${project.projectPath}/${worktreePath}`;

    // 1. 检查是否有提交
    const hasCommits = await this.execSSH(ssh, `
      cd ${fullWorktreePath}
      git log origin/main..HEAD --oneline | head -1
    `);

    if (!hasCommits.stdout.trim()) {
      return { success: true, message: 'No commits to merge' };
    }

    // 2. 尝试 rebase
    const rebaseResult = await this.execSSH(ssh, `
      cd ${fullWorktreePath}
      git fetch origin main
      git rebase origin/main
    `);

    if (rebaseResult.exitCode !== 0) {
      // Rebase 失败，中止并返回冲突信息
      await this.execSSH(ssh, `
        cd ${fullWorktreePath}
        git rebase --abort
      `);

      return {
        success: false,
        message: 'Rebase conflict',
        conflicts: this.parseConflicts(rebaseResult.stderr),
      };
    }

    // 3. 切换到 main 并 merge
    const mergeResult = await this.execSSH(ssh, `
      cd ${project.projectPath}
      git checkout main
      git merge ${branchName} --no-ff -m "Merge task-${taskId}"
      git push origin main
    `);

    if (mergeResult.exitCode !== 0) {
      return {
        success: false,
        message: 'Merge failed',
        error: mergeResult.stderr,
      };
    }

    return { success: true, message: 'Merged successfully' };
  }

  async cleanupWorktree(ssh: Client, project: Project, taskId: string): Promise<void> {
    const branchName = `task-${taskId}`;
    const worktreePath = `.worktrees/${branchName}`;

    await this.execSSH(ssh, `
      cd ${project.projectPath}
      git worktree remove ${worktreePath} --force
      git branch -D ${branchName}
    `);
  }
}
```

---

## 错误处理和恢复

### SSH 连接断开重连

```typescript
// services/ssh.ts
class SSHPool {
  async getConnection(project: Project, options?: { forceNew?: boolean }): Promise<Client> {
    const existing = this.connections.get(project.id);

    // 检查连接是否仍然有效
    if (existing && !options?.forceNew) {
      if (await this.isConnectionAlive(existing.client)) {
        existing.lastUsed = new Date();
        return existing.client;
      } else {
        // 连接已断开，移除并重新创建
        existing.client.end();
        this.connections.delete(project.id);
      }
    }

    // 创建新连接
    return this.createConnection(project);
  }

  private async isConnectionAlive(client: Client): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), 5000);

      client.exec('echo 1', (err, stream) => {
        clearTimeout(timeout);
        if (err) {
          resolve(false);
        } else {
          stream.on('data', () => {
            stream.close();
            resolve(true);
          });
          stream.on('error', () => resolve(false));
        }
      });
    });
  }

  private async createConnection(project: Project, retries = 3): Promise<Client> {
    for (let i = 0; i < retries; i++) {
      try {
        const client = new Client();
        await new Promise<void>((resolve, reject) => {
          client.on('ready', resolve);
          client.on('error', reject);
          client.connect({
            host: project.sshHost,
            username: project.sshUser,
            privateKey: fs.readFileSync(project.sshKeyPath!),
            readyTimeout: 10000,
            keepaliveInterval: 30000,
          });
        });

        this.connections.set(project.id, {
          client,
          lastUsed: new Date(),
          isInteractive: false,
        });

        return client;
      } catch (error) {
        if (i === retries - 1) throw error;
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));  // 指数退避
      }
    }
    throw new Error('Failed to connect after retries');
  }
}
```

### 任务执行失败恢复

```typescript
// services/task.ts
class TaskExecutor {
  async recoverInterruptedTasks(): Promise<void> {
    // 启动时检查中断的任务
    const tasks = await this.storage.read<Task[]>('tasks.json') || [];
    const interrupted = tasks.filter(t => t.status === 'running');

    for (const task of interrupted) {
      console.log(`Recovering interrupted task: ${task.id}`);

      // 检查 Claude Code 进程是否还在运行
      const isRunning = await this.checkRemoteProcess(task);

      if (isRunning) {
        // 重新订阅输出流
        await this.resubscribeTaskOutput(task);
      } else {
        // 标记为失败，让用户决定是否重试
        await this.storage.update(`tasks/${task.projectId}.json`, (tasks: Task[]) =>
          tasks.map(t => t.id === task.id ? {
            ...t,
            status: 'failed',
            error: 'Task interrupted (server restart)',
          } : t)
        );
      }
    }
  }
}
```

---

## 前端 WebSocket 重连

```typescript
// services/websocket.ts
class WebSocketClient {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000;
  private subscriptions: Set<string> = new Set();

  constructor(url: string) {
    this.url = url;
    this.connect();
  }

  private connect() {
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      console.log('WebSocket connected');
      this.reconnectAttempts = 0;

      // 重新订阅之前的任务
      for (const taskId of this.subscriptions) {
        this.send({ type: 'subscribe:task', taskId });
      }
    };

    this.ws.onclose = () => {
      console.log('WebSocket disconnected');
      this.scheduleReconnect();
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  }

  private scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnect attempts reached');
      return;
    }

    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;

    setTimeout(() => {
      console.log(`Reconnecting... (attempt ${this.reconnectAttempts})`);
      this.connect();
    }, delay);
  }

  subscribe(taskId: string) {
    this.subscriptions.add(taskId);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({ type: 'subscribe:task', taskId });
    }
  }

  unsubscribe(taskId: string) {
    this.subscriptions.delete(taskId);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({ type: 'unsubscribe:task', taskId });
    }
  }

  private send(data: any) {
    this.ws?.send(JSON.stringify(data));
  }
}
```

---

## CCManager 自身认证

使用简单的 API Key 认证（适合个人使用）：

### 配置

```typescript
// .env
CCMANAGER_API_KEY=your-secret-key-here
```

### 后端中间件

```typescript
// middleware/auth.ts
export function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers['x-api-key'] || req.query.apiKey;

  if (!process.env.CCMANAGER_API_KEY) {
    // 未配置 API Key，跳过认证（开发模式）
    return next();
  }

  if (apiKey !== process.env.CCMANAGER_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

// 应用到所有 API 路由
app.use('/api', apiKeyAuth);

// WebSocket 认证
wss.on('connection', (ws, req) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const apiKey = url.searchParams.get('apiKey');

  if (process.env.CCMANAGER_API_KEY && apiKey !== process.env.CCMANAGER_API_KEY) {
    ws.close(1008, 'Unauthorized');
    return;
  }
});
```

### 前端配置

```typescript
// services/api.ts
const API_KEY = import.meta.env.VITE_CCMANAGER_API_KEY;

export const api = {
  async fetch(url: string, options: RequestInit = {}) {
    return fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        'X-API-Key': API_KEY,
      },
    });
  },
};

// WebSocket 连接
const wsUrl = `wss://your-server.com/ws?apiKey=${API_KEY}`;
```

---

## 验证方案

1. **项目管理验证**：
   - 添加项目 -> SSH 测试连接 -> 显示在列表中

2. **任务执行验证**：
   - 创建普通任务 -> 观察实时输出 -> 查看完成状态
   - 查看 git log 确认 commit

3. **Plan 模式验证**：
   - 创建 Plan 模式任务 -> 查看 Plan 输出 -> 选择选项 -> 确认

4. **PWA 验证**：
   - iOS Safari 访问 -> 添加到主屏幕 -> 离线打开

5. **并发任务验证**：
   - 同时创建多个任务 -> 观察 worktree 隔离 -> 确认无冲突
