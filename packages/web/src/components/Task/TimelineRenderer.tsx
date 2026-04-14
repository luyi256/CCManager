import { useState } from 'react';
import {
  MessageSquare,
  Send,
  ChevronRight,
  ChevronDown,
} from 'lucide-react';
import SafeMarkdown from '../common/SafeMarkdown';

// Timeline item types
export interface TimelineItem {
  id: string;
  type: 'output' | 'tool_use' | 'tool_result' | 'user_message';
  timestamp: number;
  content: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  toolStatus?: 'pending' | 'running' | 'completed';
}

// Safe JSON stringify that handles circular references
export function safeStringify(obj: unknown, indent = 2): string {
  const seen = new WeakSet();
  try {
    return JSON.stringify(
      obj,
      (_key, value) => {
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) {
            return '[Circular]';
          }
          seen.add(value);
        }
        return value;
      },
      indent
    );
  } catch {
    return String(obj);
  }
}

// Single collapsible tool call
export function ToolCallItem({ item, defaultExpanded = false }: { item: TimelineItem; defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const inputStr = safeStringify(item.toolInput);
  const resultStr = item.toolResult != null
    ? (typeof item.toolResult === 'string' ? item.toolResult : safeStringify(item.toolResult))
    : null;

  return (
    <div className="flex-1 min-w-0">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 w-full text-left group"
      >
        {expanded
          ? <ChevronDown size={14} className="text-green-400 flex-shrink-0" />
          : <ChevronRight size={14} className="text-green-400 flex-shrink-0" />
        }
        <span className="font-medium text-green-400 text-sm">
          {item.toolName}
        </span>
        {item.toolStatus && (
          <span className={`text-xs ${
            item.toolStatus === 'completed' ? 'text-green-500' :
            item.toolStatus === 'running' ? 'text-blue-400 animate-pulse' :
            'text-dark-500'
          }`}>
            {item.toolStatus}
          </span>
        )}
        {!expanded && (
          <span className="text-xs text-dark-600 ml-auto truncate max-w-[50%]">
            {inputStr.length > 60 ? inputStr.slice(0, 60) + '...' : inputStr}
          </span>
        )}
      </button>
      {expanded && (
        <div className="mt-1 ml-5">
          <pre className="text-xs text-dark-400 bg-dark-900 p-2 rounded overflow-x-auto whitespace-pre-wrap break-all">
            {inputStr}
          </pre>
          {resultStr != null && (
            <div className="mt-2">
              <span className="text-xs text-dark-500">Result:</span>
              <pre className="text-xs text-dark-300 bg-dark-900 p-2 rounded overflow-x-auto whitespace-pre-wrap break-all mt-1">
                {resultStr.length > 500 ? resultStr.slice(0, 500) + '...' : resultStr}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Grouped display for consecutive tool calls
export function ToolCallGroup({ items }: { items: TimelineItem[] }) {
  const [expanded, setExpanded] = useState(false);

  if (items.length === 1) {
    return <ToolCallItem item={items[0]} />;
  }

  const lastItem = items[items.length - 1];
  const hiddenCount = items.length - 1;

  return (
    <div className="flex-1 min-w-0">
      {expanded && (
        <div className="space-y-2 mb-2">
          {items.slice(0, -1).map((item) => (
            <ToolCallItem key={item.id} item={item} />
          ))}
        </div>
      )}
      <ToolCallItem item={lastItem} defaultExpanded={false} />
      <button
        onClick={() => setExpanded(!expanded)}
        className="mt-1 ml-5 text-xs text-dark-500 hover:text-dark-300 transition-colors"
      >
        {expanded ? 'Hide' : `Show ${hiddenCount} more tool call${hiddenCount > 1 ? 's' : ''}`}
      </button>
    </div>
  );
}

// Group consecutive tool_use items in timeline
export type GroupedItem =
  | { type: 'single'; item: TimelineItem }
  | { type: 'tool_group'; items: TimelineItem[] };

export function groupTimeline(timeline: TimelineItem[]): GroupedItem[] {
  const groups: GroupedItem[] = [];
  let toolBuffer: TimelineItem[] = [];

  const flushTools = () => {
    if (toolBuffer.length === 0) return;
    if (toolBuffer.length === 1) {
      groups.push({ type: 'single', item: toolBuffer[0] });
    } else {
      groups.push({ type: 'tool_group', items: [...toolBuffer] });
    }
    toolBuffer = [];
  };

  for (const item of timeline) {
    if (item.type === 'tool_use' || item.type === 'tool_result') {
      if (item.type === 'tool_use') {
        toolBuffer.push(item);
      }
      // tool_result items are already embedded in tool_use via toolResult, skip standalone
    } else {
      flushTools();
      groups.push({ type: 'single', item });
    }
  }
  flushTools();
  return groups;
}

// Render a grouped timeline
export function TimelineView({ grouped, userMessageLabel }: {
  grouped: GroupedItem[];
  userMessageLabel?: (item: TimelineItem) => string;
}) {
  const getLabel = userMessageLabel || ((item: TimelineItem) =>
    item.id === 'initial-prompt' ? 'Prompt' : 'Follow-up'
  );

  return (
    <div className="divide-y divide-dark-700">
      {grouped.map((group, gi) => {
        if (group.type === 'tool_group') {
          return (
            <div key={`group-${gi}`} className="p-3">
              <ToolCallGroup items={group.items} />
            </div>
          );
        }
        const item = group.item;
        return (
          <div key={item.id} className="p-3">
            {item.type === 'output' ? (
              <div className="flex gap-2">
                <MessageSquare size={14} className="text-blue-400 flex-shrink-0 mt-1" />
                <div className="flex-1 min-w-0 prose prose-invert prose-sm max-w-none break-words">
                  <SafeMarkdown>{item.content}</SafeMarkdown>
                </div>
              </div>
            ) : item.type === 'user_message' ? (
              <div className="flex gap-2 bg-primary-500/10 rounded-lg -mx-1 px-1 py-1">
                <Send size={14} className="text-primary-400 flex-shrink-0 mt-1" />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-primary-400 uppercase mb-1">
                    {getLabel(item)}
                  </div>
                  <p className="text-dark-200 break-words whitespace-pre-wrap">{item.content}</p>
                </div>
              </div>
            ) : item.type === 'tool_use' ? (
              <ToolCallItem item={item} />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
