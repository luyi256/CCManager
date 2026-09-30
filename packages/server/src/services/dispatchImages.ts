import crypto from 'crypto';

/**
 * Images above this size are not sent inside `task:execute`. On slow links a
 * multi-megabyte Socket.IO packet outlasts the heartbeat timeout, drops the
 * agent connection, and turns every dispatch into a recovery loop. Instead the
 * agent downloads them over a separate HTTP request.
 */
export const INLINE_IMAGE_BYTES = 256 * 1024;

const STAGED_TTL_MS = 60 * 60 * 1000;

interface StagedImages {
  agentId: string;
  taskId: number;
  images: string[];
  expiresAt: number;
}

const staged = new Map<string, StagedImages>();

function prune(now = Date.now()): void {
  for (const [id, entry] of staged) {
    if (entry.expiresAt <= now) staged.delete(id);
  }
}

export function imagesByteSize(images: string[]): number {
  return images.reduce((total, image) => total + image.length, 0);
}

/** Stage images for one agent; a newer dispatch of the same task replaces older ones. */
export function stageDispatchImages(agentId: string, taskId: number, images: string[]): string {
  prune();
  for (const [id, entry] of staged) {
    if (entry.agentId === agentId && entry.taskId === taskId) staged.delete(id);
  }
  const id = crypto.randomBytes(16).toString('hex');
  staged.set(id, { agentId, taskId, images, expiresAt: Date.now() + STAGED_TTL_MS });
  return id;
}

/** Kept until expiry so an agent can retry an interrupted download. */
export function getStagedDispatchImages(id: string, agentId: string): string[] | null {
  prune();
  const entry = staged.get(id);
  if (!entry || entry.agentId !== agentId) return null;
  return entry.images;
}
