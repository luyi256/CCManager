import type { Runner } from '../types/index.js';

const MODEL_CAPABILITY_PREFIX = 'models:';

export interface RunnerModelCatalog {
  installed: boolean;
  models: string[];
  modelOptions?: Array<{ id: string; efforts?: string[]; defaultEffort?: string }>;
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
      (parsed.message !== undefined && typeof parsed.message !== 'string') ||
      (parsed.modelOptions !== undefined && !Array.isArray(parsed.modelOptions))
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
    if (Array.isArray(parsed.modelOptions)) {
      catalog.modelOptions = parsed.modelOptions.flatMap((option: unknown) => {
        if (!option || typeof option !== 'object') return [];
        const item = option as { id?: unknown; efforts?: unknown; defaultEffort?: unknown };
        if (typeof item.id !== 'string' || !item.id.trim()) return [];
        const normalized: { id: string; efforts?: string[]; defaultEffort?: string } = {
          id: item.id.trim(),
        };
        if (Array.isArray(item.efforts)) {
          normalized.efforts = Array.from(new Set(item.efforts
            .filter((effort): effort is string => typeof effort === 'string')
            .map((effort) => effort.trim())
            .filter(Boolean)));
        }
        if (typeof item.defaultEffort === 'string' && item.defaultEffort.trim()) {
          normalized.defaultEffort = item.defaultEffort.trim();
        }
        return [normalized];
      });
    }
    return catalog;
  } catch {
    return null;
  }
}

export function validateReasoningEffort(
  capabilities: string[],
  runner: Runner,
  model: string | undefined,
  value: unknown,
): { reasoningEffort?: string; error?: string } {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value !== 'string' || !value.trim()) {
    return { error: 'Effort must be a non-empty string' };
  }
  const effort = value.trim();
  const catalog = getRunnerModelCatalog(capabilities, runner);
  if (!catalog?.installed || !model) {
    return { reasoningEffort: effort };
  }
  const option = catalog.modelOptions?.find((item) => item.id === model);
  if (!option?.efforts?.length) {
    return { error: `Model "${model}" does not expose selectable effort on ${runner}` };
  }
  if (!option.efforts.includes(effort)) {
    return { error: `Effort "${effort}" is not supported by model "${model}"` };
  }
  return { reasoningEffort: effort };
}

function acceptRequestedModel(value: unknown): { model?: string; error?: string } {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value !== 'string' || !value.trim()) {
    return { error: 'Model must be a non-empty string' };
  }
  return { model: value.trim() };
}

/**
 * Fails open on purpose. A runner's catalog can be missing or momentarily empty
 * (agent predates model reporting, or its probe timed out), and rejecting the
 * request in that case used to 400 before attachments were persisted — losing
 * the user's uploaded images. Only a genuine mismatch against a known catalog,
 * or a CLI that is definitively absent, is worth blocking.
 *
 * Note the asymmetry: routes/sessions.ts never validates models at all, so it
 * has always been fail-open.
 */
export function validateRunnerSelection(
  capabilities: string[],
  runner: Runner,
  value: unknown
): { model?: string; error?: string } {
  const catalog = getRunnerModelCatalog(capabilities, runner);

  // The agent never reported a catalog (older agent, or malformed capability).
  if (catalog === null) {
    const accepted = acceptRequestedModel(value);
    if (accepted.model) {
      console.warn(
        `[models] Agent reported no catalog for ${runner}; ` +
        `accepting requested model "${accepted.model}" unvalidated`
      );
    }
    return accepted;
  }

  if (!catalog.installed) {
    return { error: catalog.message || `${runner} CLI is not installed on this agent` };
  }

  const accepted = acceptRequestedModel(value);
  if (accepted.error || !accepted.model) return accepted;

  if (catalog.models.length === 0) {
    console.warn(
      `[models] ${runner} reported an empty model catalog; ` +
      `accepting requested model "${accepted.model}" unvalidated`
    );
    return { model: accepted.model };
  }

  if (!catalog.models.includes(accepted.model)) {
    return {
      error: `Model "${accepted.model}" is not supported by ${runner} on this agent`,
    };
  }
  return { model: accepted.model };
}
