export interface TimelineItem {
  id: string;
  type: 'output' | 'tool_use' | 'tool_result' | 'user_message';
  timestamp: number;
  content: string;
  logId?: number;
  toolCallId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  toolStatus?: 'pending' | 'running' | 'completed' | 'failed';
}

export type GroupedItem =
  | { type: 'single'; item: TimelineItem }
  | { type: 'tool_group'; items: TimelineItem[] };

export function safeStringify(obj: unknown, indent = 2): string {
  const seen = new WeakSet<object>();
  try {
    const serialized = JSON.stringify(
      obj,
      (_key, value) => {
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) return '[Circular]';
          seen.add(value);
        }
        return value;
      },
      indent
    );
    return serialized ?? String(obj);
  } catch {
    return String(obj);
  }
}

function reconcileToolResults(timeline: TimelineItem[]): TimelineItem[] {
  const items = timeline.map((item) => ({ ...item }));
  const tools = new Map<string, TimelineItem>();
  const consumedResults = new Set<string>();

  for (const item of items) {
    if (item.type !== 'tool_use') continue;
    tools.set(item.toolCallId || item.id, item);
  }

  for (const item of items) {
    if (item.type !== 'tool_result' || !item.toolCallId) continue;
    const tool = tools.get(item.toolCallId);
    if (!tool) continue;
    tool.toolResult = item.toolResult ?? item.content;
    tool.toolStatus = 'completed';
    consumedResults.add(item.id);
  }

  return items.filter((item) => !consumedResults.has(item.id));
}

export function groupTimeline(timeline: TimelineItem[]): GroupedItem[] {
  const groups: GroupedItem[] = [];
  let toolBuffer: TimelineItem[] = [];
  let outputBuffer: TimelineItem | null = null;

  const flushTools = () => {
    if (toolBuffer.length === 0) return;
    groups.push(toolBuffer.length === 1
      ? { type: 'single', item: toolBuffer[0] }
      : { type: 'tool_group', items: [...toolBuffer] });
    toolBuffer = [];
  };

  const flushOutput = () => {
    if (!outputBuffer) return;
    groups.push({ type: 'single', item: outputBuffer });
    outputBuffer = null;
  };

  for (const item of reconcileToolResults(timeline)) {
    if (item.type === 'tool_use') {
      flushOutput();
      toolBuffer.push(item);
    } else if (item.type === 'output') {
      flushTools();
      if (outputBuffer) {
        const previous = outputBuffer as TimelineItem;
        outputBuffer = {
          ...previous,
          id: `${previous.id}-${item.id}`,
          timestamp: item.timestamp,
          content: `${previous.content}${item.content}`,
        };
      } else {
        outputBuffer = item;
      }
    } else {
      flushTools();
      flushOutput();
      groups.push({ type: 'single', item });
    }
  }

  flushTools();
  flushOutput();
  return groups;
}
