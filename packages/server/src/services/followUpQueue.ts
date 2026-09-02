import type { Runner } from '../types/index.js';
import { db } from './database.js';

// Per-task follow-up message queue
// When a task is actively running, follow-ups are queued here and merged when execution finishes.

interface QueuedMessage {
  id: number;
  prompt: string;
  images?: string[];
  runner?: Runner;
  model?: string;
  /** The user_message log this follow-up was written for, if known. */
  logId?: number;
  /** Attachment rows already stored for this row (legacy rows without a logId). */
  attachmentIds?: number[];
}

export function enqueue(
  taskId: number,
  prompt: string,
  images?: string[],
  runner?: Runner,
  model?: string,
  logId?: number
): void {
  db.prepare(`
    INSERT INTO task_followups (task_id, prompt, images, runner, model, log_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    taskId,
    prompt,
    images?.length ? JSON.stringify(images) : null,
    runner || null,
    model || null,
    logId ?? null,
  );
}

/**
 * Reads without consuming. Callers must only delete rows via removeByIds once a
 * dispatch has actually succeeded — the previous destructive dequeue discarded
 * prompts and images whenever a later precondition (session id, project,
 * reachable agent) turned out to fail.
 */
export function peekAll(taskId: number): QueuedMessage[] {
  const rows = db.prepare(`
    SELECT id, prompt, images, runner, model, log_id, attachment_ids
    FROM task_followups
    WHERE task_id = ?
    ORDER BY id ASC
  `).all(taskId) as Array<{
    id: number;
    prompt: string;
    images: string | null;
    runner: Runner | null;
    model: string | null;
    log_id: number | null;
    attachment_ids: string | null;
  }>;

  return rows.map((row) => {
    let images: string[] | undefined;
    try {
      images = row.images ? JSON.parse(row.images) as string[] : undefined;
    } catch {
      images = undefined;
    }
    let attachmentIds: number[] | undefined;
    try {
      attachmentIds = row.attachment_ids
        ? JSON.parse(row.attachment_ids) as number[]
        : undefined;
    } catch {
      attachmentIds = undefined;
    }
    return {
      id: row.id,
      prompt: row.prompt,
      images,
      runner: row.runner || undefined,
      model: row.model || undefined,
      logId: row.log_id ?? undefined,
      attachmentIds,
    };
  });
}

/** Remembers rows stored for a legacy queue entry so a retry does not re-insert. */
export function recordAttachmentIds(queueRowId: number, ids: number[]): void {
  db.prepare('UPDATE task_followups SET attachment_ids = ? WHERE id = ?')
    .run(JSON.stringify(ids), queueRowId);
}

export function removeByIds(ids: number[]): void {
  if (ids.length === 0) return;
  const remove = db.transaction(() => {
    const stmt = db.prepare('DELETE FROM task_followups WHERE id = ?');
    for (const id of ids) stmt.run(id);
  });
  remove();
}

export type { QueuedMessage };

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
