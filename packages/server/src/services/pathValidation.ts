import path from 'path';
import type { Project } from '../types/index.js';

// Server-side path validation against a list of allowed path patterns
export function isPathAllowed(projectPath: string, allowedPaths: string[]): boolean {
  const normalized = path.posix.normalize(projectPath);
  for (const allowed of allowedPaths) {
    if (allowed.endsWith('/*')) {
      const base = path.posix.normalize(allowed.slice(0, -2));
      if (normalized.startsWith(base + '/')) return true;
    } else if (allowed.endsWith('/**')) {
      const base = path.posix.normalize(allowed.slice(0, -3));
      if (normalized === base || normalized.startsWith(base + '/')) return true;
    } else {
      const normalizedAllowed = path.posix.normalize(allowed);
      if (normalized === normalizedAllowed || normalized.startsWith(normalizedAllowed + '/')) return true;
    }
  }
  return false;
}

// Build effective allowedPaths to send to agent.
// Includes project's configured allowedPaths + the exact projectPath,
// so the agent can validate even without updated merge logic.
export function buildTaskAllowedPaths(project: Project): string[] | undefined {
  if (!project.allowedPaths?.length) return undefined;
  if (!isPathAllowed(project.projectPath, project.allowedPaths)) return undefined;
  const paths = [...project.allowedPaths];
  if (!paths.includes(project.projectPath)) {
    paths.push(project.projectPath);
  }
  return paths;
}
