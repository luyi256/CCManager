import path from 'path';
import type { Project } from '../types/index.js';

// Server-side path validation against a list of allowed path patterns
export function isPathAllowed(projectPath: string, allowedPaths: string[]): boolean {
  const normalized = path.posix.normalize(projectPath);
  return allowedPaths.some((allowed) => {
    // `/base/*` and `/base/**` also match the base directory itself, so a
    // project rooted at the allowed base is not rejected on a trailing slash.
    // `/*` is the whole filesystem.
    const pattern = allowed.endsWith('/**')
      ? allowed.slice(0, -3)
      : allowed.endsWith('/*') ? allowed.slice(0, -2) : allowed;
    const base = path.posix.normalize(pattern || '/');
    return normalized === base || normalized.startsWith(base.endsWith('/') ? base : base + '/');
  });
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
