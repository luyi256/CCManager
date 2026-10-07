import crypto from 'crypto';

/**
 * Session transcripts and file previews can be several megabytes. Returning
 * them through a Socket.IO acknowledgement blocks the agent connection long
 * enough on slow links to miss heartbeats, so agents upload them over HTTP
 * instead and the pending request is resolved here.
 */
interface PendingUpload {
  agentId: string;
  resolve: (body: unknown) => void;
}

const pending = new Map<string, PendingUpload>();

export function expectAgentUpload(agentId: string): {
  id: string;
  promise: Promise<unknown>;
  cancel: () => void;
} {
  const id = crypto.randomBytes(16).toString('hex');
  const promise = new Promise<unknown>((resolve) => {
    pending.set(id, { agentId, resolve });
  });
  return { id, promise, cancel: () => pending.delete(id) };
}

/** Returns false when no request is waiting for this upload from this agent. */
export function completeAgentUpload(id: string, agentId: string, body: unknown): boolean {
  const entry = pending.get(id);
  if (!entry || entry.agentId !== agentId) return false;
  pending.delete(id);
  entry.resolve(body);
  return true;
}
