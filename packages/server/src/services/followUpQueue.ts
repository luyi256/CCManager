// Per-task follow-up message queue
// When a task is actively running, follow-ups are queued here and merged when execution finishes.

interface QueuedMessage {
  prompt: string;
  images?: string[];
}

const queues = new Map<number, QueuedMessage[]>();

export function enqueue(taskId: number, prompt: string, images?: string[]): void {
  if (!queues.has(taskId)) queues.set(taskId, []);
  queues.get(taskId)!.push({ prompt, images });
}

export function dequeue(taskId: number): QueuedMessage | undefined {
  const q = queues.get(taskId);
  if (!q || q.length === 0) return undefined;
  return q.shift();
}

export function hasQueued(taskId: number): boolean {
  const q = queues.get(taskId);
  return !!q && q.length > 0;
}

export function queueSize(taskId: number): number {
  return queues.get(taskId)?.length ?? 0;
}

export function clear(taskId: number): void {
  queues.delete(taskId);
}
