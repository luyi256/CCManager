import type { Runner } from '../types/index.js';

const MODEL_CAPABILITY_PREFIX = 'models:';

export interface RunnerModelCatalog {
  installed: boolean;
  models: string[];
  message?: string;
}

export function getRunnerModelCatalog(
  capabilities: string[],
  runner: Runner
): RunnerModelCatalog | null {
  const prefix = `${MODEL_CAPABILITY_PREFIX}${runner}:`;
  const encoded = capabilities.find((capability) => capability.startsWith(prefix));
  if (!encoded) return null;

  try {
    const parsed = JSON.parse(encoded.slice(prefix.length));
    // Backward compatibility for early agents that reported a bare string[].
    if (Array.isArray(parsed)) {
      if (parsed.some((model) => typeof model !== 'string')) return null;
      return {
        installed: true,
        models: Array.from(new Set(parsed.map((model) => model.trim()).filter(Boolean))),
      };
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.installed !== 'boolean' ||
      !Array.isArray(parsed.models) ||
      parsed.models.some((model: unknown) => typeof model !== 'string') ||
      (parsed.message !== undefined && typeof parsed.message !== 'string')
    ) {
      return null;
    }
    const catalog: RunnerModelCatalog = {
      installed: parsed.installed,
      models: Array.from(new Set(
        parsed.models.map((model: string) => model.trim()).filter(Boolean)
      )),
    };
    if (parsed.message !== undefined) catalog.message = parsed.message;
    return catalog;
  } catch {
    return null;
  }
}

export function validateRunnerSelection(
  capabilities: string[],
  runner: Runner,
  value: unknown
): { model?: string; error?: string } {
  const catalog = getRunnerModelCatalog(capabilities, runner);
  if (catalog === null) return {};
  if (!catalog.installed) {
    return { error: catalog.message || `${runner} CLI is not installed on this agent` };
  }
  if (value === undefined || value === null || value === '') return {};
  if (typeof value !== 'string' || !value.trim()) {
    return { error: 'Model must be a non-empty string' };
  }

  const model = value.trim();
  if (!catalog.models.includes(model)) {
    return {
      error: `Model "${model}" is not supported by ${runner} on this agent`,
    };
  }
  return { model };
}
