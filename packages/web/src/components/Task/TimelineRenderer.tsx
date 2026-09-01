import { useState } from 'react';
import {
  MessageSquare,
  Send,
  ChevronRight,
  ChevronDown,
  Terminal,
  Loader2,
  Brain,
  Wrench,
  Clock3,
  CheckCircle2,
  XCircle,
  CircleSlash,
  Wifi,
} from 'lucide-react';
import SafeMarkdown from '../common/SafeMarkdown';
import type { TaskStreamPhase } from '../../types';
import {
  groupTimeline,
  safeStringify,
  type GroupedItem,
  type TimelineItem,
} from '../../utils/timeline';

export { groupTimeline, safeStringify };
export type { GroupedItem, TimelineItem };

const PHASE_META: Record<TaskStreamPhase, {
  label: string;
  className: string;
  icon: typeof Loader2;
  spin?: boolean;
}> = {
  connecting: { label: 'Connecting to live updates', className: 'text-dark-400', icon: Wifi },
  queued: { label: 'Queued', className: 'text-amber-400', icon: Clock3 },
  starting: { label: 'Starting runner', className: 'text-blue-400', icon: Loader2, spin: true },
  recovering: { label: 'Recovering after reconnect', className: 'text-amber-400', icon: Loader2, spin: true },
  thinking: { label: 'Thinking', className: 'text-purple-400', icon: Brain },
  tool: { label: 'Using tools', className: 'text-green-400', icon: Wrench },
  waiting: { label: 'Waiting for input', className: 'text-amber-400', icon: Clock3 },
  completed: { label: 'Completed', className: 'text-green-400', icon: CheckCircle2 },
  failed: { label: 'Failed', className: 'text-red-400', icon: XCircle },
  cancelled: { label: 'Cancelled', className: 'text-dark-400', icon: CircleSlash },
};

export function StreamPhaseIndicator({ phase }: { phase: TaskStreamPhase }) {
  const meta = PHASE_META[phase];
  const Icon = meta.icon;
  return (
    <div
      className={`flex items-center gap-1.5 text-xs ${meta.className}`}
      role="status"
      aria-live="polite"
      data-stream-phase={phase}
    >
      <Icon
        size={13}
        className={
          meta.spin
            ? 'animate-spin'
            : phase === 'thinking' || phase === 'tool'
              ? 'animate-pulse'
              : ''
        }
      />
      <span>{meta.label}</span>
    </div>
  );
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
            item.toolStatus === 'failed' ? 'text-red-400' :
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

function ToolResultItem({ item }: { item: TimelineItem }) {
  const result = typeof item.toolResult === 'string'
    ? item.toolResult
    : safeStringify(item.toolResult ?? item.content);
  return (
    <div className="flex gap-2 text-sm">
      <Terminal size={14} className="text-green-500 flex-shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-dark-500 uppercase mb-1">Tool result</div>
        <pre className="text-xs text-dark-300 bg-dark-900 p-2 rounded overflow-x-auto whitespace-pre-wrap break-words">
          {result}
        </pre>
      </div>
    </div>
  );
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
            <div key={`group-${gi}`} className="p-3" data-entry-id={group.items[0]?.id}>
              <ToolCallGroup items={group.items} />
            </div>
          );
        }
        const item = group.item;
        return (
          <div key={item.id} className="p-3" data-entry-id={item.id}>
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
            ) : item.type === 'tool_result' ? (
              <ToolResultItem item={item} />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
