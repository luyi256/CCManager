import { ClaudeExecutor } from './executor.js';
import { CodexExecutor } from './codexExecutor.js';
import { CursorExecutor } from './cursorExecutor.js';
import { DockerExecutor } from './docker.js';
import type { DockerConfig, TaskRequest } from './types.js';

export type Executor = ClaudeExecutor | CodexExecutor | CursorExecutor | DockerExecutor;

/**
 * Create the executor for a task runner first, then project executor.
 * Docker execution currently wraps Claude Code only, so Codex uses the
 * local Codex CLI even when the project executor is docker.
 */
export function createExecutor(
  task: TaskRequest,
  options: { executor?: 'local' | 'docker'; dockerConfig?: DockerConfig }
): Executor {
  const taskExecutor = options.executor ?? 'local';
  if (task.runner === 'codex' || task.runner === 'tcodex') {
    return new CodexExecutor(undefined, task.runner === 'tcodex' ? 'tcodex' : 'codex');
  }
  if (task.runner === 'cursor') {
    // Use Cursor's supported SDK instead of scraping CLI output. It provides
    // typed streaming, image inputs, durable agent IDs, and resume/cancel.
    return new CursorExecutor();
  }
  if (task.runner === 'claude-grok') {
    // claude-grok is a host-side Claude Code wrapper with its own local
    // router/config, so it must not be replaced by the plain Docker image.
    return new ClaudeExecutor(undefined, 'claude-grok');
  }
  if (task.runner === 'qwen') {
    return new ClaudeExecutor(undefined, 'qwen');
  }
  if (task.runner === 'tclaude') {
    return new ClaudeExecutor(undefined, 'tclaude');
  }
  if (taskExecutor === 'docker' && options.dockerConfig) {
    const dockerConfig = task.dockerImage
      ? { ...options.dockerConfig, image: task.dockerImage }
      : options.dockerConfig;
    return new DockerExecutor(dockerConfig);
  }
  return new ClaudeExecutor();
}
