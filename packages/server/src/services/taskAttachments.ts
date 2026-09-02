import { db } from './database.js';

const MAX_IMAGE_COUNT = 8;
// No per-image product limit. Keep only a total bound that fits below the
// Express JSON body limit after base64 expansion and leaves room for prompts.
const MAX_TOTAL_BYTES = 36 * 1024 * 1024;
export const ATTACHMENT_RETENTION_DAYS = 30;
const IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\r\n]+)$/;

export interface ParsedImage {
  dataUrl: string;
  mimeType: string;
  byteSize: number;
}

function hasValidSignature(mimeType: string, bytes: Buffer): boolean {
  if (mimeType === 'image/png') {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (mimeType === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === 'image/gif') {
    const header = bytes.subarray(0, 6).toString('ascii');
    return header === 'GIF87a' || header === 'GIF89a';
  }
  if (mimeType === 'image/webp') {
    return bytes.length >= 12 &&
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  return false;
}

export function validateTaskImages(value: unknown): ParsedImage[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('Images must be an array');
  if (value.length > MAX_IMAGE_COUNT) throw new Error(`A task can include at most ${MAX_IMAGE_COUNT} images`);

  let totalBytes = 0;
  return value.map((item, index) => {
    if (typeof item !== 'string') throw new Error(`Image ${index + 1} is invalid`);
    const match = item.match(IMAGE_DATA_URL);
    if (!match) throw new Error(`Image ${index + 1} must be PNG, JPEG, GIF, or WebP`);
    const mimeType = match[1];
    const normalizedBase64 = match[2].replace(/\s/g, '');
    const bytes = Buffer.from(normalizedBase64, 'base64');
    if (!bytes.length || !hasValidSignature(mimeType, bytes)) {
      throw new Error(`Image ${index + 1} content does not match ${mimeType}`);
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Images exceed the 36 MB total request limit');
    return {
      dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`,
      mimeType,
      byteSize: bytes.length,
    };
  });
}

export interface AttachmentMeta {
  id: number;
  logId: number | null;
  position: number;
  mimeType: string;
  byteSize: number;
}

/**
 * Stores a new generation of attachments for a task.
 *
 * Rows are never deleted — the previous generation is only deactivated — so a
 * follow-up message no longer erases the images attached to earlier ones. The
 * new rows append at MAX(position)+1 to respect UNIQUE(task_id, position).
 *
 * Pass activate: false when the images belong to a queued follow-up that has not
 * been dispatched yet, so getTaskImages keeps returning the in-flight run's set.
 */
export function replaceTaskImages(
  taskId: number,
  value: unknown,
  logId: number | null = null,
  opts: { activate?: boolean } = {}
): { dataUrls: string[]; ids: number[] } {
  const activate = opts.activate !== false;
  const images = validateTaskImages(value);
  const ids: number[] = [];

  const store = db.transaction(() => {
    if (activate) {
      db.prepare('UPDATE task_attachments SET active = 0 WHERE task_id = ? AND active = 1').run(taskId);
    }
    const { nextPosition } = db.prepare(
      'SELECT COALESCE(MAX(position) + 1, 0) AS nextPosition FROM task_attachments WHERE task_id = ?'
    ).get(taskId) as { nextPosition: number };

    const insert = db.prepare(`
      INSERT INTO task_attachments (task_id, position, mime_type, byte_size, data_url, log_id, active)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    images.forEach((image, offset) => {
      const result = insert.run(
        taskId,
        nextPosition + offset,
        image.mimeType,
        image.byteSize,
        image.dataUrl,
        logId,
        activate ? 1 : 0,
      );
      ids.push(Number(result.lastInsertRowid));
    });
  });
  store();

  return { dataUrls: images.map((image) => image.dataUrl), ids };
}

/** The set that should be sent to the agent for the current run. */
export function getTaskImages(taskId: number): string[] {
  const rows = db.prepare(`
    SELECT data_url FROM task_attachments
    WHERE task_id = ? AND active = 1
    ORDER BY position ASC
  `).all(taskId) as Array<{ data_url: string }>;
  return rows.map((row) => row.data_url);
}

/** Metadata for every generation, for display. Never returns base64. */
export function listTaskAttachments(taskId: number): AttachmentMeta[] {
  const rows = db.prepare(`
    SELECT id, log_id, position, mime_type, byte_size FROM task_attachments
    WHERE task_id = ?
    ORDER BY position ASC
  `).all(taskId) as Array<{
    id: number;
    log_id: number | null;
    position: number;
    mime_type: string;
    byte_size: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    logId: row.log_id,
    position: row.position,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
  }));
}

/** Scoped by task so the route gets ownership validation for free. */
export function getAttachmentForTask(
  taskId: number,
  attachmentId: number
): { mimeType: string; buffer: Buffer } | null {
  const row = db.prepare(`
    SELECT mime_type, data_url FROM task_attachments
    WHERE task_id = ? AND id = ?
  `).get(taskId, attachmentId) as { mime_type: string; data_url: string } | undefined;
  if (!row) return null;

  const base64 = row.data_url.slice(row.data_url.indexOf(',') + 1);
  return { mimeType: row.mime_type, buffer: Buffer.from(base64, 'base64') };
}

export function bindAttachmentsToLog(ids: number[], logId: number): void {
  if (ids.length === 0) return;
  const bind = db.transaction(() => {
    const stmt = db.prepare('UPDATE task_attachments SET log_id = ? WHERE id = ?');
    for (const id of ids) stmt.run(logId, id);
  });
  bind();
}

/**
 * Deletes superseded attachment bytes older than the retention window.
 *
 * Only rows that are both inactive (a newer generation replaced them) and
 * unbound (no user_message references them, so nothing can display them) are
 * eligible — anything still dispatchable or still rendered in a timeline stays.
 * Without this, base64 accumulates forever since replaceTaskImages appends.
 */
export function pruneStaleAttachments(retentionDays = ATTACHMENT_RETENTION_DAYS): number {
  const result = db.prepare(`
    DELETE FROM task_attachments
    WHERE active = 0
      AND log_id IS NULL
      AND created_at < datetime('now', ?)
  `).run(`-${retentionDays} days`);
  return result.changes;
}

/** Promotes previously queued rows into the active dispatch set. */
export function activateAttachments(taskId: number, ids: number[]): void {
  const activate = db.transaction(() => {
    db.prepare('UPDATE task_attachments SET active = 0 WHERE task_id = ? AND active = 1').run(taskId);
    if (ids.length === 0) return;
    const stmt = db.prepare('UPDATE task_attachments SET active = 1 WHERE task_id = ? AND id = ?');
    for (const id of ids) stmt.run(taskId, id);
  });
  activate();
}
