import os from 'os';
import path from 'path';

/**
 * Variables a coding-agent session sets for its own child processes. When the
 * agent is (re)started from inside such a session they leak into every runner,
 * e.g. making Codex attach to the parent's thread and sandbox, or making a
 * CLI believe it is nested inside another agent.
 */
const PARENT_SESSION_VARS = [
  'CODEX_THREAD_ID',
  'CODEX_CI',
  'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED',
  'CODEX_PERMISSION_PROFILE',
  'CODEX_MANAGED_BY_NPM',
  'CODEX_MANAGED_PACKAGE_ROOT',
  'CURSOR_CONVERSATION_ID',
  'CURSOR_REQUEST_ID',
  'CURSOR_AGENT',
  'CURSOR_INVOKED_AS',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
];

export function scrubParentSessionEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed = PARENT_SESSION_VARS.filter((name) => name in env);
  for (const name of removed) delete env[name];
  return removed;
}

export function tcodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.TCODEX_HOME || path.join(os.homedir(), '.tcodex');
}

/** Environment for spawning a Codex-family CLI. */
export function codexEnv(runner: 'codex' | 'tcodex', base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  // tCodex launchers export CODEX_HOME=~/.tcodex. Upstream Codex inheriting it
  // would run with tCodex's provider config and write into its session store.
  if (runner === 'codex' && env.CODEX_HOME && path.resolve(env.CODEX_HOME) === path.resolve(tcodexHome(env))) {
    env.CODEX_HOME = path.join(os.homedir(), '.codex');
  }
  return env;
}
