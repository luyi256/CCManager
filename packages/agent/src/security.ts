import path from 'path';
import fs from 'fs';
import type { AgentConfig } from './types.js';

export function validatePath(projectPath: string, config: AgentConfig): void {
  // Resolve the path first
  const normalizedPath = path.resolve(projectPath);

  // Check for symlink traversal (Bug #20 fix)
  try {
    const realPath = fs.realpathSync(normalizedPath);
    if (realPath !== normalizedPath) {
      // Path contains symlinks, validate the real path as well
      validatePathInternal(realPath, config);
    }
  } catch (err) {
    // Path doesn't exist yet, which is OK for new projects
    // But still validate the normalized path
  }

  validatePathInternal(normalizedPath, config);
}

/** True when `target` is `base` or inside it; `base` may be the filesystem root. */
function isWithin(target: string, base: string): boolean {
  if (target === base) return true;
  return target.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
}

/**
 * Base directory of an allowed-path entry. `/base/*` and `/base/**` also match
 * the base itself, so a project rooted directly at the allowed base (e.g.
 * project "/home/user/" with allow "/home/user/*") is accepted. `/*` means the
 * whole filesystem, not the agent's working directory.
 */
function allowedBase(allowedPath: string): string {
  const pattern = allowedPath.endsWith('/**')
    ? allowedPath.slice(0, -3)
    : allowedPath.endsWith('/*') ? allowedPath.slice(0, -2) : allowedPath;
  return path.resolve(pattern || path.sep);
}

function validatePathInternal(normalizedPath: string, config: AgentConfig): void {

  // Check blocked paths first
  if (config.blockedPaths) {
    for (const blocked of config.blockedPaths) {
      if (isWithin(normalizedPath, path.resolve(blocked))) {
        throw new Error(`Path is blocked: ${normalizedPath}`);
      }
    }
  }

  // Check allowed paths
  const allowed = config.allowedPaths.some((allowedPath) => isWithin(normalizedPath, allowedBase(allowedPath)));

  if (!allowed) {
    throw new Error(
      `Path not in allowed list: ${normalizedPath}. Allowed: ${config.allowedPaths.join(', ')}`
    );
  }
}

export function sanitizeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const allowedVars = [
    'PATH',
    'HOME',
    'USER',
    'SHELL',
    'TERM',
    'LANG',
    'LC_ALL',
    'TMPDIR',
    'NODE_ENV',
    // Claude Code authentication
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    // XDG directories (for config/cache)
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
  ];

  for (const key of allowedVars) {
    if (process.env[key]) {
      env[key] = process.env[key];
    }
  }

  return env;
}
