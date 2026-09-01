import type { Runner } from '../types/index.js';
import { db } from './database.js';

// Per-task follow-up message queue
// When a task is actively running, follow-ups are queued here and merged when execution finishes.

interface QueuedMessage {
  prompt: string;
  images?: string[];
  runner?: Runner;
  model?: string;
}

export function enqueue(
  taskId: number,
  prompt: string,
  images?: string[],
  runner?: Runner,
  model?: string
): void {
  db.prepare(`
    INSERT INTO task_followups (task_id, prompt, images, runner, model)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    taskId,
    prompt,
    images?.length ? JSON.stringify(images) : null,
    runner || null,
    model || null,
  );
}

export function dequeue(taskId: number): QueuedMessage | undefined {
  const take = db.transaction(() => {
    const row = db.prepare(`
      SELECT id, prompt, images, runner, model
      FROM task_followups
      WHERE task_id = ?
      ORDER BY id ASC
      LIMIT 1
    `).get(taskId) as {
      id: number;
      prompt: string;
      images: string | null;
      runner: Runner | null;
      model: string | null;
    } | undefined;
    if (!row) return undefined;
    db.prepare('DELETE FROM task_followups WHERE id = ?').run(row.id);
    let images: string[] | undefined;
    try {
      images = row.images ? JSON.parse(row.images) as string[] : undefined;
    } catch {
      images = undefined;
    }
    return {
      prompt: row.prompt,
      images,
      runner: row.runner || undefined,
      model: row.model || undefined,
    };
  });
  return take();
}

export function hasQueued(taskId: number): boolean {
  return Boolean(db.prepare('SELECT 1 FROM task_followups WHERE task_id = ? LIMIT 1').get(taskId));
}

export function queueSize(taskId: number): number {
  const row = db.prepare('SELECT COUNT(*) AS count FROM task_followups WHERE task_id = ?')
    .get(taskId) as { count: number };
  return row.count;
}

export function clear(taskId: number): void {
  db.prepare('DELETE FROM task_followups WHERE task_id = ?').run(taskId);
}
