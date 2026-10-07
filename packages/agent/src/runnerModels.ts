import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { codexEnv, tcodexHome } from './runnerEnv.js';

export type Runner = 'claude' | 'claude-grok' | 'codex' | 'cursor' | 'qwen' | 'tclaude' | 'tcodex';

const execFileAsync = promisify(execFile);
const RUNNER_COMMANDS: Record<Runner, string> = {
  claude: 'claude',
  'claude-grok': 'claude-grok',
  codex: 'codex',
  cursor: 'agent',
  qwen: 'qwen',
  tclaude: 'tclaude',
  tcodex: 'tcodex',
};
const CURSOR_SDK_MIN_NODE = [22, 13] as const;
const CLAUDE_ALIAS_PATTERN = /'([a-z][a-z0-9-]*)'/g;
const TCLAUDE_UNAVAILABLE_MODEL = '__ccmanager_model_probe__';
const CAPABILITY_CACHE_TTL_MS = 30 * 60 * 1000;
// A missing CLI is usually a PATH glitch during boot rather than a permanent
// state, so let it re-probe far sooner than a known-good catalog.
const MISSING_CLI_CACHE_TTL_MS = 5 * 60 * 1000;
const CODEX_MODELS_TIMEOUT_MS = 60_000;
const PROBE_RETRY_DELAY_MS = 750;
const CAPABILITY_CACHE_PATH = process.env.CCM_MODEL_CACHE_PATH ||
  path.join(os.homedir(), '.ccm-agent-model-capabilities.json');
const capabilityCache = new Map<Runner, { expiresAt: number; capability: string }>();

export function isCurrentCapability(capability: string): boolean {
  const separator = capability.indexOf(':', 'models:'.length);
  if (!capability.startsWith('models:') || separator < 0) return false;
  try {
    const catalog = JSON.parse(capability.slice(separator + 1)) as {
      installed?: unknown;
      models?: unknown;
      modelOptions?: unknown;
    };
    if (catalog.installed !== true || !Array.isArray(catalog.models) || catalog.models.length === 0) {
      return true;
    }
    // Model metadata was introduced with reasoning-effort selection. Reject
    // older positive cache entries so an upgraded agent immediately re-probes
    // instead of hiding effort controls for the previous 30-minute TTL.
    return Array.isArray(catalog.modelOptions);
  } catch {
    return false;
  }
}

function loadCapabilityCache(): void {
  try {
    const parsed = JSON.parse(fs.readFileSync(CAPABILITY_CACHE_PATH, 'utf8')) as
      Partial<Record<Runner, { expiresAt?: unknown; capability?: unknown }>>;
    for (const [runner, value] of Object.entries(parsed)) {
      if (
        value &&
        typeof value.expiresAt === 'number' &&
        typeof value.capability === 'string' &&
        isCurrentCapability(value.capability)
      ) {
        capabilityCache.set(runner as Runner, {
          expiresAt: value.expiresAt,
          capability: value.capability,
        });
      }
    }
  } catch {
    // No persisted cache yet.
  }
}

function persistCapabilityCache(): void {
  try {
    fs.writeFileSync(
      CAPABILITY_CACHE_PATH,
      JSON.stringify(Object.fromEntries(capabilityCache), null, 2) + '\n',
      { mode: 0o600 },
    );
  } catch (error) {
    console.warn('[models] Failed to persist capability cache:', error instanceof Error ? error.message : error);
  }
}

loadCapabilityCache();

interface CodexModel {
  slug?: unknown;
  visibility?: unknown;
  supported_in_api?: unknown;
  supported_reasoning_levels?: unknown;
  default_reasoning_level?: unknown;
}

export interface ModelOption {
  id: string;
  efforts?: string[];
  defaultEffort?: string;
}

interface RunnerModelCatalog {
  installed: boolean;
  models: string[];
  modelOptions?: ModelOption[];
  message?: string;
}

function normalizeModels(models: string[]): string[] {
  return Array.from(new Set(models.map((model) => model.trim()).filter(Boolean)));
}

function cursorSdkNodeSupported(version = process.versions.node): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return major > CURSOR_SDK_MIN_NODE[0]
    || (major === CURSOR_SDK_MIN_NODE[0] && minor >= CURSOR_SDK_MIN_NODE[1]);
}

async function runCli(
  runner: Runner,
  args: string[],
  timeout = 10_000
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(RUNNER_COMMANDS[runner], args, {
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    env: runner === 'codex' || runner === 'tcodex' ? codexEnv(runner) : { ...process.env },
  });
  return { stdout, stderr };
}

function extractCodexCatalog(raw: string): CodexModel[] {
  // Wrappers such as tCodex can print an update notice before/after the JSON
  // payload. Parse the first complete object containing `models` rather than
  // requiring stdout to be pure JSON.
  const marker = raw.indexOf('{"models"');
  if (marker < 0) throw new SyntaxError('Model catalog JSON not found');
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let index = marker; index < raw.length; index++) {
    const char = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      end = index + 1;
      break;
    }
  }
  if (end < 0) throw new SyntaxError('Model catalog JSON is incomplete');
  const parsed = JSON.parse(raw.slice(marker, end)) as { models?: CodexModel[] };
  return Array.isArray(parsed.models) ? parsed.models : [];
}

export function parseCodexCatalog(raw: string): string[] {
  return parseCodexModelOptions(raw).map((model) => model.id);
}

export function parseCodexModelOptions(raw: string): ModelOption[] {
  return extractCodexCatalog(raw)
    .filter((model) =>
      model.visibility === 'list' &&
      model.supported_in_api === true &&
      typeof model.slug === 'string' &&
      model.slug.trim()
    )
    .map((model) => {
      const levels = Array.isArray(model.supported_reasoning_levels)
        ? model.supported_reasoning_levels
          .map((level) => level && typeof level === 'object'
            ? (level as { effort?: unknown }).effort
            : undefined)
          .filter((effort): effort is string => typeof effort === 'string' && Boolean(effort))
        : [];
      const option: ModelOption = { id: (model.slug as string).trim() };
      if (levels.length > 0) option.efforts = normalizeModels(levels);
      if (
        typeof model.default_reasoning_level === 'string' &&
        levels.includes(model.default_reasoning_level)
      ) {
        option.defaultEffort = model.default_reasoning_level;
      }
      return option;
    });
}

function readCodexConfig(runner: 'codex' | 'tcodex'): {
  model?: string;
  modelProvider?: string;
} {
  const configDir = runner === 'tcodex'
    ? tcodexHome()
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

async function listCodexModels(runner: 'codex' | 'tcodex'): Promise<ModelOption[]> {
  const configured = readCodexConfig(runner);
  // A custom provider has no standard remote model catalog. Its configured
  // model is the only locally verified slug; the bundled OpenAI catalog would
  // otherwise advertise models that the custom gateway may reject.
  if (configured.modelProvider && configured.modelProvider !== 'openai') {
    return configured.model ? [{ id: configured.model }] : [];
  }

  const { stdout } = await runCli(runner, ['debug', 'models'], CODEX_MODELS_TIMEOUT_MS);
  const options = parseCodexModelOptions(stdout);
  if (configured.model && !options.some((option) => option.id === configured.model)) {
    options.unshift({ id: configured.model });
  }
  return options;
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

async function listCursorModels(): Promise<ModelOption[]> {
  // The SDK is Cursor's stable integration surface; unlike CLI text parsing it
  // returns the account's canonical model IDs directly.
  if (!cursorSdkNodeSupported()) {
    const error = new Error(
      `Cursor SDK requires Node.js ${CURSOR_SDK_MIN_NODE.join('.')} or newer (current: ${process.versions.node})`
    ) as NodeJS.ErrnoException;
    error.code = 'ENOTSUP';
    throw error;
  }
  const { Cursor } = await import('@cursor/sdk');
  if (!process.env.CURSOR_API_KEY) {
    const auth = await Cursor.auth.status();
    if (auth.status !== 'logged-in') {
      const error = new Error('Configure CURSOR_API_KEY or run the Cursor SDK login on this agent');
      error.name = 'AuthenticationError';
      throw error;
    }
  }
  const models = await Cursor.models.list();
  return models.map((model) => {
    const parameter = model.parameters?.find((candidate) =>
      candidate.id === 'effort' || candidate.id === 'reasoning'
    );
    const defaultVariant = model.variants?.find((variant) => variant.isDefault);
    const defaultEffort = defaultVariant?.params.find((param) =>
      param.id === 'effort' || param.id === 'reasoning'
    )?.value;
    const option: ModelOption = { id: model.id };
    if (parameter?.values?.length) {
      option.efforts = parameter.values.map((value) => value.value);
    }
    if (defaultEffort) option.defaultEffort = defaultEffort;
    return option;
  });
}

export function parseClaudeGrokSettings(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const overrides = (payload as { modelOverrides?: unknown }).modelOverrides;
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return [];
  return normalizeModels(Object.values(overrides)
    .filter((model): model is string => typeof model === 'string')
    .map(toGrokDisplayModel)
    .filter(Boolean));
}

export function toGrokDisplayModel(model: string): string {
  return model.match(/(grok(?:-[A-Za-z0-9.]+)+)$/i)?.[1] || model;
}

export function resolveClaudeGrokModel(
  requestedModel: string,
  payload: unknown
): string {
  if (!payload || typeof payload !== 'object') return requestedModel;
  const overrides = (payload as { modelOverrides?: unknown }).modelOverrides;
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return requestedModel;

  const entries = Object.entries(overrides)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  if (entries.some(([alias]) => alias === requestedModel)) return requestedModel;
  const target = entries.find(([, model]) =>
    model === requestedModel || toGrokDisplayModel(model) === requestedModel
  )?.[1];
  if (!target) return requestedModel;

  // Claude Code derives its local context window from the selected Claude
  // role, not from third-party model metadata or CLAUDE_CODE_MAX_CONTEXT_TOKENS.
  // Prefer a configured [1m] alias so Grok's 500K window can use the wrapper's
  // 450K autocompact threshold instead of being blocked at the 200K default.
  const aliases = entries
    .filter(([, model]) => model === target)
    .map(([alias]) => alias);
  return aliases.find((alias) => /\[1m\]$/i.test(alias))
    || aliases[0]
    || target;
}

export function resolveConfiguredClaudeGrokModel(requestedModel: string): string {
  const settingsPath = process.env.CLAUDE_GROK_SETTINGS ||
    path.join(os.homedir(), '.config', 'distill-grok', 'claude-settings.json');
  try {
    return resolveClaudeGrokModel(
      requestedModel,
      JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    );
  } catch {
    return requestedModel;
  }
}

async function listClaudeGrokModels(): Promise<string[]> {
  await runCli('claude-grok', ['--version']);
  const settingsPath = process.env.CLAUDE_GROK_SETTINGS ||
    path.join(os.homedir(), '.config', 'distill-grok', 'claude-settings.json');
  try {
    return parseClaudeGrokSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
  } catch {
    return [];
  }
}

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function optionsFromModels(models: string[], efforts?: string[]): ModelOption[] {
  return models.map((id) => ({ id, ...(efforts?.length ? { efforts } : {}) }));
}

async function listRunnerModels(runner: Runner): Promise<ModelOption[]> {
  switch (runner) {
    case 'codex':
    case 'tcodex':
      return listCodexModels(runner);
    case 'tclaude':
      return optionsFromModels(await listTClaudeModels(), CLAUDE_EFFORTS);
    case 'cursor':
      return listCursorModels();
    case 'claude':
      return optionsFromModels(await listClaudeModels(), CLAUDE_EFFORTS);
    case 'claude-grok':
      return optionsFromModels(await listClaudeGrokModels(), CLAUDE_EFFORTS);
    case 'qwen':
      return optionsFromModels(await listQwenModels());
  }
}

/**
 * Why a probe distinguishes "missing" from "transient": caching a timeout or a
 * boot-time PATH glitch as an empty catalog makes the manager reject the user's
 * model for the whole TTL, which previously discarded uploaded images with it.
 */
export type ProbeOutcome =
  | { kind: 'models'; models: ModelOption[] }
  | { kind: 'missing'; message?: string }
  | { kind: 'unavailable'; message: string }
  | { kind: 'transient'; message: string };

export function buildRunnerCatalog(runner: Runner, outcome: ProbeOutcome): RunnerModelCatalog {
  if (outcome.kind === 'models') {
    return {
      installed: true,
      models: outcome.models.map((model) => model.id),
      modelOptions: outcome.models,
    };
  }
  if (outcome.kind === 'missing') {
    return {
      installed: false,
      models: [],
      message: outcome.message ??
        `Install or expose the local ${RUNNER_COMMANDS[runner]} command on this agent`,
    };
  }
  if (outcome.kind === 'unavailable') {
    return { installed: false, models: [], message: outcome.message };
  }
  // Installed, but the catalog could not be read this time. Advertising an empty
  // list keeps the runner selectable; the manager accepts unverified models.
  return { installed: true, models: [] };
}

/** Returns null when an outcome must NOT be cached. */
export function capabilityCacheTtl(outcome: ProbeOutcome): number | null {
  if (outcome.kind === 'models') {
    // An empty list is legitimate for runners without a catalog contract
    // (qwen, claude-grok) and cheap to re-derive, so don't freeze it.
    return outcome.models.length > 0 ? CAPABILITY_CACHE_TTL_MS : null;
  }
  if (outcome.kind === 'missing') return MISSING_CLI_CACHE_TTL_MS;
  return null;
}

async function probeRunner(runner: Runner): Promise<ProbeOutcome> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return { kind: 'models', models: await listRunnerModels(runner) };
    } catch (error) {
      const code = error instanceof Error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
      if (code === 'ENOENT') return { kind: 'missing' };
      if (code === 'ENOTSUP') {
        return { kind: 'unavailable', message: error instanceof Error ? error.message : String(error) };
      }
      if (
        runner === 'cursor' &&
        (error instanceof Error && (
          error.name === 'AuthenticationError' ||
          /api key|authenticat|logged.?out|unauthorized/i.test(error.message)
        ))
      ) {
        return {
          kind: 'unavailable',
          message: 'Configure CURSOR_API_KEY or run the Cursor SDK login on this agent',
        };
      }

      const message = error instanceof Error ? error.message : String(error);
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, PROBE_RETRY_DELAY_MS));
        continue;
      }
      console.warn(`[models] Failed to discover ${runner} models:`, message);
      return { kind: 'transient', message };
    }
  }
  return { kind: 'transient', message: 'Model probe exhausted retries' };
}

const ALL_RUNNERS = Object.keys(RUNNER_COMMANDS) as Runner[];
const advertisedCapabilities = new Map<Runner, string>();
/** Runners whose last probe failed transiently and advertise an empty catalog. */
const failedRunners = new Set<Runner>();

/** Probes one runner and records the result; returns true if the cache changed. */
async function probeAndRecord(runner: Runner): Promise<boolean> {
  const outcome = await probeRunner(runner);
  const capability = `models:${runner}:${JSON.stringify(buildRunnerCatalog(runner, outcome))}`;
  advertisedCapabilities.set(runner, capability);
  if (outcome.kind === 'transient') failedRunners.add(runner);
  else failedRunners.delete(runner);
  const ttl = capabilityCacheTtl(outcome);
  if (ttl === null) {
    // Never leave a stale negative behind for the next process to load.
    return capabilityCache.delete(runner);
  }
  capabilityCache.set(runner, { expiresAt: Date.now() + ttl, capability });
  return true;
}

export async function discoverRunnerModelCapabilities(): Promise<string[]> {
  let dirty = false;
  await Promise.all(ALL_RUNNERS.map(async (runner) => {
    const cached = capabilityCache.get(runner);
    if (cached && cached.expiresAt > Date.now()) {
      advertisedCapabilities.set(runner, cached.capability);
      failedRunners.delete(runner);
      return;
    }
    if (await probeAndRecord(runner)) dirty = true;
  }));
  if (dirty) persistCapabilityCache();
  return ALL_RUNNERS.map((runner) => advertisedCapabilities.get(runner)!);
}

/**
 * Re-probe only runners whose last probe failed transiently; healthy catalogs
 * are left alone. Returns the full capability list if anything changed.
 */
export async function refreshFailedRunnerModels(): Promise<string[] | null> {
  if (failedRunners.size === 0) return null;
  const runners = Array.from(failedRunners);
  const before = runners.map((runner) => advertisedCapabilities.get(runner));
  let dirty = false;
  await Promise.all(runners.map(async (runner) => {
    if (await probeAndRecord(runner)) dirty = true;
  }));
  if (dirty) persistCapabilityCache();
  const changed = runners.some((runner, index) => advertisedCapabilities.get(runner) !== before[index]);
  return changed ? ALL_RUNNERS.map((runner) => advertisedCapabilities.get(runner)!) : null;
}
