import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

export type Runner = 'claude' | 'claude-grok' | 'codex' | 'qwen' | 'tclaude' | 'tcodex';

const execFileAsync = promisify(execFile);
const RUNNER_COMMANDS: Record<Runner, string> = {
  claude: 'claude',
  'claude-grok': 'claude',
  codex: 'codex',
  qwen: 'qwen',
  tclaude: 'tclaude',
  tcodex: 'tcodex',
};
const CLAUDE_ALIAS_PATTERN = /'([a-z][a-z0-9-]*)'/g;
const TCLAUDE_UNAVAILABLE_MODEL = '__ccmanager_model_probe__';

interface CodexModel {
  slug?: unknown;
  visibility?: unknown;
  supported_in_api?: unknown;
}

interface RunnerModelCatalog {
  installed: boolean;
  models: string[];
  message?: string;
}

function normalizeModels(models: string[]): string[] {
  return Array.from(new Set(models.map((model) => model.trim()).filter(Boolean)));
}

async function runCli(
  runner: Runner,
  args: string[],
  timeout = 10_000
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(RUNNER_COMMANDS[runner], args, {
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env },
  });
  return { stdout, stderr };
}

export function parseCodexCatalog(raw: string): string[] {
  const parsed = JSON.parse(raw) as { models?: CodexModel[] };
  if (!Array.isArray(parsed.models)) return [];
  return normalizeModels(parsed.models
    .filter((model) => model.visibility === 'list' && model.supported_in_api === true)
    .map((model) => typeof model.slug === 'string' ? model.slug : ''));
}

function readCodexConfig(runner: 'codex' | 'tcodex'): {
  model?: string;
  modelProvider?: string;
} {
  const configDir = runner === 'tcodex'
    ? process.env.TCODEX_HOME || path.join(os.homedir(), '.tcodex')
    : path.join(os.homedir(), '.codex');
  try {
    const raw = fs.readFileSync(path.join(configDir, 'config.toml'), 'utf8');
    return {
      model: raw.match(/^model\s*=\s*["']([^"']+)["']/m)?.[1],
      modelProvider: raw.match(/^model_provider\s*=\s*["']([^"']+)["']/m)?.[1],
    };
  } catch {
    return {};
  }
}

async function listCodexModels(runner: 'codex' | 'tcodex'): Promise<string[]> {
  const configured = readCodexConfig(runner);
  // A custom provider has no standard remote model catalog. Its configured
  // model is the only locally verified slug; the bundled OpenAI catalog would
  // otherwise advertise models that the custom gateway may reject.
  if (configured.modelProvider && configured.modelProvider !== 'openai') {
    return configured.model ? [configured.model] : [];
  }

  const { stdout } = await runCli(runner, ['debug', 'models'], 30_000);
  return normalizeModels([
    ...(configured.model ? [configured.model] : []),
    ...parseCodexCatalog(stdout),
  ]);
}

function getTClaudeDaemonPort(): number | null {
  const daemonPath = path.join(os.homedir(), '.tclaude', 'daemon.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(daemonPath, 'utf8')) as { port?: unknown };
    return typeof parsed.port === 'number' && Number.isInteger(parsed.port) ? parsed.port : null;
  } catch {
    return null;
  }
}

export function parseTClaudeAvailableModels(output: string): string[] {
  const match = output.match(/Available models:\s*([^\n\r]+)/i);
  return match ? normalizeModels(match[1].split(',')) : [];
}

async function listTClaudeModels(): Promise<string[]> {
  try {
    await runCli('tclaude', ['--', '--model', TCLAUDE_UNAVAILABLE_MODEL, '--version'], 15_000);
  } catch (error) {
    const output = error instanceof Error
      ? `${(error as Error & { stdout?: string }).stdout ?? ''}\n${(error as Error & { stderr?: string }).stderr ?? ''}`
      : String(error);
    const models = parseTClaudeAvailableModels(output);
    if (models.length > 0) return models;
  }

  const port = getTClaudeDaemonPort();
  if (port === null) return [];
  const response = await fetch(`http://127.0.0.1:${port}/v1/models`, {
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) return [];
  const parsed = await response.json() as { data?: Array<{ id?: unknown }> };
  if (!Array.isArray(parsed.data)) return [];
  return normalizeModels(parsed.data.map((model) => typeof model.id === 'string' ? model.id : ''));
}

function getClaudeConfiguredModels(): string[] {
  const models: string[] = [];
  const envModel = process.env.ANTHROPIC_MODEL;
  if (envModel) models.push(envModel);

  const settingsPath = path.join(
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    'settings.json'
  );
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      model?: unknown;
      availableModels?: unknown;
    };
    if (typeof parsed.model === 'string') models.push(parsed.model);
    if (Array.isArray(parsed.availableModels)) {
      models.push(...parsed.availableModels.filter((model): model is string => typeof model === 'string'));
    }
  } catch {
    // Missing or malformed optional settings do not make Claude unavailable.
  }
  return models;
}

export function parseClaudeHelpModels(output: string, configuredModels: string[] = []): string[] {
  const lines = output.split('\n');
  const modelLine = lines.findIndex((line) => line.includes('--model <model>'));
  const modelHelp = modelLine >= 0 ? lines.slice(modelLine, modelLine + 5).join('\n') : '';
  const aliases: string[] = [];
  for (const match of modelHelp.matchAll(CLAUDE_ALIAS_PATTERN)) {
    if (match[1] !== 'latest') aliases.push(match[1]);
  }
  return normalizeModels([...configuredModels, ...aliases]);
}

async function listClaudeModels(): Promise<string[]> {
  const { stdout, stderr } = await runCli('claude', ['--help']);
  return parseClaudeHelpModels(`${stdout}\n${stderr}`, getClaudeConfiguredModels());
}

async function listQwenModels(): Promise<string[]> {
  // Qwen Code does not expose a stable non-interactive catalog in the installed
  // CLI contract. Confirm installation via help and offer only the CLI default
  // rather than inventing provider-specific model names.
  await runCli('qwen', ['--help']);
  return [];
}

export function parseXaiModels(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return normalizeModels(data
    .map((model) =>
      model && typeof model === 'object' && typeof (model as { id?: unknown }).id === 'string'
        ? (model as { id: string }).id
        : ''
    )
    .filter((model) => model.startsWith('grok-')));
}

async function listClaudeGrokModels(): Promise<string[]> {
  await runCli('claude-grok', ['--version']);
  const apiKey = process.env.XAI_API_KEY;
  const fallback = process.env.XAI_DEFAULT_MODEL || 'grok-4.6';
  if (!apiKey) return [];

  const baseUrl = (process.env.XAI_ANTHROPIC_BASE_URL || 'https://api.x.ai').replace(/\/+$/, '');
  try {
    const response = await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return [fallback];
    const models = parseXaiModels(await response.json());
    return normalizeModels([fallback, ...models]);
  } catch {
    return [fallback];
  }
}

async function listRunnerModels(runner: Runner): Promise<string[]> {
  switch (runner) {
    case 'codex':
    case 'tcodex':
      return listCodexModels(runner);
    case 'tclaude':
      return listTClaudeModels();
    case 'claude':
      return listClaudeModels();
    case 'claude-grok':
      return listClaudeGrokModels();
    case 'qwen':
      return listQwenModels();
  }
}

export async function discoverRunnerModelCapabilities(): Promise<string[]> {
  const runners = Object.keys(RUNNER_COMMANDS) as Runner[];
  const entries = await Promise.all(runners.map(async (runner) => {
    let catalog: RunnerModelCatalog;
    if (runner === 'claude-grok' && !process.env.XAI_API_KEY) {
      return `models:${runner}:${JSON.stringify({
        installed: false,
        models: [],
        message: 'Set XAI_API_KEY or xaiApiKey on this agent to enable Claude Grok',
      })}`;
    }
    try {
      catalog = {
        installed: true,
        models: await listRunnerModels(runner),
      };
    } catch (error) {
      const code = error instanceof Error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
      if (code !== 'ENOENT') {
        console.warn(
          `[models] Failed to discover ${runner} models:`,
          error instanceof Error ? error.message : error
        );
      }
      catalog = {
        installed: code !== 'ENOENT',
        models: [],
      };
    }
    return `models:${runner}:${JSON.stringify(catalog)}`;
  }));
  return entries;
}
