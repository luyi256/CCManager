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

function validatePathInternal(normalizedPath: string, config: AgentConfig): void {

  // Check blocked paths first
  if (config.blockedPaths) {
    for (const blocked of config.blockedPaths) {
      const normalizedBlocked = path.resolve(blocked);
      if (
        normalizedPath === normalizedBlocked ||
        normalizedPath.startsWith(normalizedBlocked + path.sep)
      ) {
        throw new Error(`Path is blocked: ${normalizedPath}`);
      }
    }
  }

  // Check allowed paths
  let allowed = false;
  for (const allowedPath of config.allowedPaths) {
    // Handle glob patterns like /home/user/projects/*
    if (allowedPath.endsWith('/*')) {
      const basePath = path.resolve(allowedPath.slice(0, -2));
      if (normalizedPath.startsWith(basePath + path.sep)) {
        allowed = true;
        break;
      }
    } else if (allowedPath.endsWith('/**')) {
      const basePath = path.resolve(allowedPath.slice(0, -3));
      if (
        normalizedPath === basePath ||
        normalizedPath.startsWith(basePath + path.sep)
      ) {
        allowed = true;
        break;
      }
    } else {
      const normalizedAllowed = path.resolve(allowedPath);
      if (normalizedPath === normalizedAllowed) {
        allowed = true;
        break;
      }
    }
  }

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
