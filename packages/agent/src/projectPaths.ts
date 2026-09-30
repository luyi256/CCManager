import { existsSync } from 'fs';
import { readdir, realpath } from 'fs/promises';
import { resolve } from 'path';

function normalized(path: string): string {
  return resolve(path).replace(/\/+$/, '') || '/';
}

function distributedShareSuffix(path: string): string | null {
  return normalized(path).match(/^\/apdcephfs_[^/]+\/(share_[^/]+\/.+)$/)?.[1] || null;
}

function isSameOrWorktreePath(cwd: string, root: string): boolean {
  return cwd === root ||
    cwd.startsWith(`${root}/.worktrees/`) ||
    cwd.startsWith(`${root}/.qwen/worktrees/`);
}

/**
 * Return paths that address the same project on this host. Besides symlinks,
 * Tencent's shared Ceph volumes can expose one share through several
 * `/apdcephfs_<cluster>/share_<id>/...` mount aliases.
 */
export async function equivalentProjectPaths(projectPath: string): Promise<string[]> {
  const paths = new Set<string>([normalized(projectPath)]);
  try {
    paths.add(normalized(await realpath(projectPath)));
  } catch {
    // The configured path may be temporarily unavailable.
  }

  const suffix = distributedShareSuffix(projectPath);
  if (suffix) {
    try {
      const roots = await readdir('/');
      for (const root of roots) {
        if (!root.startsWith('apdcephfs_')) continue;
        const candidate = `/${root}/${suffix}`;
        if (existsSync(candidate)) paths.add(normalized(candidate));
      }
    } catch {
      // Mount alias discovery is best effort.
    }
  }
  return Array.from(paths);
}

export async function pathBelongsToProject(
  cwd: string | undefined,
  acceptedPaths: string[],
): Promise<boolean> {
  if (!cwd) return true;
  const normalizedCwd = normalized(cwd);
  const cwdShareSuffix = distributedShareSuffix(normalizedCwd);
  for (const candidate of acceptedPaths) {
    const root = normalized(candidate);
    if (isSameOrWorktreePath(normalizedCwd, root)) return true;
    const rootShareSuffix = distributedShareSuffix(root);
    if (cwdShareSuffix && rootShareSuffix && (
      cwdShareSuffix === rootShareSuffix ||
      cwdShareSuffix.startsWith(`${rootShareSuffix}/.worktrees/`) ||
      cwdShareSuffix.startsWith(`${rootShareSuffix}/.qwen/worktrees/`)
    )) return true;
  }

  try {
    const realCwd = normalized(await realpath(cwd));
    return acceptedPaths.some((candidate) => isSameOrWorktreePath(realCwd, normalized(candidate)));
  } catch {
    return false;
  }
}

export function projectPathToStoreName(projectPath: string, trimHyphens = false): string {
  const value = projectPath.replace(/[^a-zA-Z0-9]/g, '-');
  return trimHyphens ? value.replace(/^-+|-+$/g, '') : value;
}
