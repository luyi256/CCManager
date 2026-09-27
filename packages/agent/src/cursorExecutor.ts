import { EventEmitter } from 'events';
import type { InteractionUpdate, ModelSelection, Run, SDKAgent, SDKImage, SDKMessage, SDKModel } from '@cursor/sdk';
import type { TaskRequest } from './types.js';

const DEFAULT_TASK_TIMEOUT = 4 * 60 * 60 * 1000;

const MAX_CURSOR_IMAGE_COUNT = 5;
const MAX_CURSOR_IMAGE_BYTES = 15 * 1024 * 1024;

export function parseCursorImage(dataUrl: string): SDKImage | null {
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/);
  if (!match) return null;
  if (Buffer.from(match[2], 'base64').length > MAX_CURSOR_IMAGE_BYTES) {
    throw new Error('Cursor supports images up to 15 MB each');
  }
  return { mimeType: match[1], data: match[2] };
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(stringifyValue(error));
}

function cursorToolResult(toolCall: { result?: unknown }): unknown {
  return toolCall.result ?? toolCall;
}

async function loadCursorSdk(): Promise<typeof import('@cursor/sdk')> {
  try {
    return await import('@cursor/sdk');
  } catch (error) {
    throw new Error(
      'Cursor SDK could not be loaded. Cursor runner requires Node.js 22.13 or newer.',
      { cause: error },
    );
  }
}

export function selectCursorModel(models: SDKModel[], requested: string | undefined): ModelSelection | null {
  if (requested) return { id: requested };
  const selected = models.find((model) => model.id !== 'auto-smart') ?? models[0];
  if (!selected) return null;
  const defaultVariant = selected.variants?.find((variant) => variant.isDefault);
  return {
    id: selected.id,
    ...(defaultVariant?.params?.length ? { params: defaultVariant.params } : {}),
  };
}

async function resolveModel(requested: string | undefined): Promise<ModelSelection> {
  if (requested) return { id: requested };
  const { Cursor } = await loadCursorSdk();
  const selected = selectCursorModel(await Cursor.models.list(), requested);
  if (!selected) throw new Error('Cursor did not return any models for this account');
  return selected;
}

export class CursorExecutor extends EventEmitter {
  private currentTaskId: number | null = null;
  private sessionId: string | null = null;
  private agent: SDKAgent | null = null;
  private run: Run | null = null;
  private timeoutHandle: NodeJS.Timeout | null = null;
  private cancelled = false;
  private activeToolCalls = new Set<string>();
  private finalResult = '';

  constructor(private taskTimeout: number = DEFAULT_TASK_TIMEOUT) {
    super();
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  async execute(task: TaskRequest, workingDir: string): Promise<void> {
    this.currentTaskId = task.taskId;
    this.cancelled = false;
    this.finalResult = '';
    this.activeToolCalls.clear();

    const { Agent } = await loadCursorSdk();
    const model = await resolveModel(task.model);
    const options = {
      model,
      local: { cwd: workingDir, enableAgentRetries: true },
      mode: task.isPlanMode ? 'plan' as const : 'agent' as const,
    };

    try {
      this.agent = task.continueSession && task.sessionId
        ? await Agent.resume(task.sessionId, options)
        : await Agent.create(options);
      this.sessionId = this.agent.agentId;
      this.emit('session_id', this.sessionId);

      if ((task.images?.length ?? 0) > MAX_CURSOR_IMAGE_COUNT) {
        throw new Error(`Cursor supports at most ${MAX_CURSOR_IMAGE_COUNT} images per message`);
      }
      const images = (task.images || [])
        .map(parseCursorImage)
        .filter((image): image is SDKImage => image !== null);
      const message = images.length > 0
        ? { text: task.prompt, images }
        : task.prompt;
      this.run = await this.agent.send(message, {
        mode: task.isPlanMode ? 'plan' : 'agent',
        onDelta: ({ update }) => this.handleDelta(update),
      });

      const timeout = new Promise<never>((_, reject) => {
        this.timeoutHandle = setTimeout(() => {
          const error = new Error(`Task execution timed out after ${this.taskTimeout / 1000} seconds`);
          this.emit('error', error);
          void this.run?.cancel();
          reject(error);
        }, this.taskTimeout);
      });

      const result = await Promise.race([
        this.consumeRun(this.run),
        timeout,
      ]);
      if (result.status === 'error') {
        throw new Error(result.error?.message || 'Cursor agent run failed');
      }
      if (result.status === 'cancelled') {
        if (this.cancelled) return;
        throw new Error('Cursor agent run was cancelled');
      }
      if (result.result && this.finalResult.length === 0) {
        this.emit('output', result.result);
      }
      this.emit('exit', 0);
    } finally {
      if (this.timeoutHandle) {
        clearTimeout(this.timeoutHandle);
        this.timeoutHandle = null;
      }
      this.run = null;
      this.agent?.close();
      this.agent = null;
      this.currentTaskId = null;
    }
  }

  private async consumeRun(run: Run): Promise<Awaited<ReturnType<Run['wait']>>> {
    // onDelta provides low-latency text and tool lifecycle events. Consume the
    // public stream too so status/auth errors are not hidden by SDK internals,
    // then read the terminal result from the same run.
    for await (const event of run.stream()) this.handleMessage(event);
    return run.wait();
  }

  private handleDelta(update: InteractionUpdate): void {
    switch (update.type) {
      case 'text-delta':
        this.finalResult += update.text;
        this.emit('output', update.text);
        break;
      case 'tool-call-started':
        this.activeToolCalls.add(update.callId);
        this.emit('tool_use', {
          id: update.callId,
          name: update.toolCall.type,
          input: update.toolCall.args,
        });
        break;
      case 'tool-call-completed':
        this.activeToolCalls.delete(update.callId);
        this.emit('tool_result', {
          id: update.callId,
          result: cursorToolResult(update.toolCall),
        });
        break;
      default:
        break;
    }
  }

  private handleMessage(event: SDKMessage): void {
    if (event.type === 'system' && event.agent_id && event.agent_id !== this.sessionId) {
      this.sessionId = event.agent_id;
      this.emit('session_id', event.agent_id);
      return;
    }
    // onDelta is the primary event source. Fall back to normalized messages if
    // a runtime does not expose deltas.
    if (event.type === 'assistant' && this.finalResult.length === 0) {
      for (const block of event.message.content) {
        if (block.type === 'text') {
          this.finalResult += block.text;
          this.emit('output', block.text);
        }
      }
      return;
    }
    if (event.type === 'tool_call') {
      if (event.status === 'running' && !this.activeToolCalls.has(event.call_id)) {
        this.activeToolCalls.add(event.call_id);
        this.emit('tool_use', {
          id: event.call_id,
          name: event.name,
          input: event.args,
        });
      } else if (event.status !== 'running' && this.activeToolCalls.has(event.call_id)) {
        this.activeToolCalls.delete(event.call_id);
        this.emit('tool_result', {
          id: event.call_id,
          result: event.result ?? event.status,
        });
      }
      return;
    }
    if (event.type === 'status' && event.status === 'ERROR') {
      this.emit('error', new Error(event.message || 'Cursor agent run failed'));
    } else if (event.type === 'task' && event.text) {
      this.emit('output', stringifyValue(event.text));
    }
  }

  sendInput(input: string): void {
    if (!this.run?.steer) return;
    void this.run.steer(input).catch((error) => {
      this.emit('error', normalizeError(error));
    });
  }

  cancel(): void {
    this.cancelled = true;
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    void this.run?.cancel();
  }

  get isRunning(): boolean {
    return this.run !== null;
  }

  get taskId(): number | null {
    return this.currentTaskId;
  }
}
