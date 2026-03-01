import cron from 'node-cron';
import * as storage from './storage.js';
import { agentPool } from './agentPool.js';
import { broadcast } from '../websocket/index.js';
import type { Task } from '../types/index.js';

// Maximum number of retries for waiting tasks before marking as failed
const MAX_WAIT_RETRIES = 20; // ~100 minutes with 5 minute intervals

// Track retry counts for waiting tasks
const waitRetryCount = new Map<number, number>();

// Simple lock mechanism to prevent race conditions (Bug #18 fix)
const taskLocks = new Set<number>();

function acquireLock(taskId: number): boolean {
  if (taskLocks.has(taskId)) {
    return false;
  }
  taskLocks.add(taskId);
  return true;
}

function releaseLock(taskId: number): void {
  taskLocks.delete(taskId);
}

export function startWaitingTaskChecker(): void {
  // Check every minute
  cron.schedule('* * * * *', async () => {
    await checkWaitingTasks();
  });

  console.log('Waiting task checker started');
}

async function checkWaitingTasks(): Promise<void> {
  try {
    const projects = await storage.getProjects();

    for (const project of projects) {
      const tasks = await storage.getTasks(project.id);
      const waitingTasks = tasks.filter(
        (t) => t.status === 'waiting' && t.waitingUntil
      );

      for (const task of waitingTasks) {
        const waitUntil = new Date(task.waitingUntil!);
        if (new Date() >= waitUntil) {
          await resumeTask(project.id, task);
        }
      }
    }
  } catch (error) {
    console.error('Error checking waiting tasks:', error);
  }
}

async function resumeTask(projectId: string, task: Task): Promise<void> {
  console.log(`Resuming task ${task.id} (was waiting for: ${task.waitReason})`);

  const project = await storage.getProject(projectId);
  if (!project) {
    console.error(`Project ${projectId} not found`);
    return;
  }

  // Check if agent is connected
  const agent = agentPool.getAgent(project.agentId);
  if (!agent) {
    // Track retry count (Bug #12 fix)
    const retries = (waitRetryCount.get(task.id) || 0) + 1;
    waitRetryCount.set(task.id, retries);

    if (retries >= MAX_WAIT_RETRIES) {
      console.error(`Task ${task.id} exceeded max wait retries (${MAX_WAIT_RETRIES}), marking as failed`);
      task.status = 'failed';
      task.error = `Agent ${project.agentId} not available after ${MAX_WAIT_RETRIES} retries`;
      task.completedAt = new Date().toISOString();
      await storage.saveTask(projectId, task);
      waitRetryCount.delete(task.id);
      return;
    }

    console.log(`Agent ${project.agentId} not available for task ${task.id}, will retry later (attempt ${retries}/${MAX_WAIT_RETRIES})`);
    // Extend wait time by 5 minutes
    task.waitingUntil = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    await storage.saveTask(projectId, task);
    return;
  }

  // Resume the task
  const continuePrompt = `
The previous task was waiting for: "${task.waitReason}"

Please check if the operation has completed. If yes, continue with the remaining work.
If not completed, use the [WAITING]...[/WAITING] format to specify new wait time.
`;

  task.status = 'running';
  task.waitReason = undefined;
  task.waitingUntil = undefined;
  task.checkCommand = undefined;
  task.startedAt = new Date().toISOString();
  await storage.saveTask(projectId, task);

  // Dispatch to agent with continue prompt
  const dispatched = agentPool.dispatchTask(project.agentId, {
    taskId: task.id,
    projectId: project.id,
    projectPath: project.projectPath,
    prompt: continuePrompt,
    isPlanMode: task.isPlanMode,
    worktreeBranch: task.worktreeBranch,
    postTaskHook: project.postTaskHook,
  });

  if (dispatched) {
    // Clear retry count on successful dispatch
    waitRetryCount.delete(task.id);
  } else {
    task.status = 'waiting';
    task.waitingUntil = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    task.waitReason = 'Agent not available';
    await storage.saveTask(projectId, task);
  }
}

// Check for dependent tasks that can now start
export async function checkDependentTasks(completedTaskId: number): Promise<void> {
  try {
    const projects = await storage.getProjects();

    for (const project of projects) {
      const tasks = await storage.getTasks(project.id);
      const dependentTasks = tasks.filter(
        (t) => t.dependsOn === completedTaskId && t.status === 'pending'
      );

      for (const task of dependentTasks) {
        // Bug #18 fix: Acquire lock to prevent race condition
        if (!acquireLock(task.id)) {
          console.log(`Task ${task.id} is already being processed, skipping`);
          continue;
        }

        try {
          // Re-fetch task to ensure we have the latest state
          const currentTask = await storage.getTaskById(task.id);
          if (!currentTask || currentTask.status !== 'pending') {
            console.log(`Task ${task.id} is no longer pending, skipping`);
            continue;
          }

          console.log(`Starting dependent task ${task.id}`);

          // Check if agent is connected
          const agent = agentPool.getAgent(project.agentId);
          if (!agent) {
            console.log(`Agent ${project.agentId} not connected for dependent task ${task.id}`);
            continue;
          }

          // Try to dispatch first, only update status if successful (consistent with other fixes)
          const dispatched = agentPool.dispatchTask(project.agentId, {
            taskId: currentTask.id,
            projectId: project.id,
            projectPath: project.projectPath,
            prompt: currentTask.prompt,
            isPlanMode: currentTask.isPlanMode,
            worktreeBranch: currentTask.worktreeBranch,
            postTaskHook: project.postTaskHook,
          });

          if (dispatched) {
            currentTask.status = 'running';
            currentTask.startedAt = new Date().toISOString();
            await storage.saveTask(project.id, currentTask);
          }
        } finally {
          releaseLock(task.id);
        }
      }
    }
  } catch (error) {
    console.error('Error checking dependent tasks:', error);
  }
}
