import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  groupTimeline,
  safeStringify,
  type TimelineItem,
} from '../src/utils/timeline';

describe('timeline grouping', () => {
  it('joins a persisted tool result to its matching tool call', () => {
    const timeline: TimelineItem[] = [
      {
        id: 'tool-row',
        type: 'tool_use',
        timestamp: 1,
        content: '',
        toolCallId: 'call-1',
        toolName: 'bash',
        toolInput: { command: 'pwd' },
        toolStatus: 'running',
      },
      {
        id: 'result-row',
        type: 'tool_result',
        timestamp: 2,
        content: '',
        toolCallId: 'call-1',
        toolResult: '/workspace',
      },
    ];

    assert.deepEqual(groupTimeline(timeline), [{
      type: 'single',
      item: {
        ...timeline[0],
        toolResult: '/workspace',
        toolStatus: 'completed',
      },
    }]);
  });

  it('keeps unmatched tool results visible instead of dropping them', () => {
    const result: TimelineItem = {
      id: 'orphan-result',
      type: 'tool_result',
      timestamp: 1,
      content: '',
      toolCallId: 'missing',
      toolResult: 'command output',
    };

    assert.deepEqual(groupTimeline([result]), [{ type: 'single', item: result }]);
  });

  it('concatenates incremental output fragments without separators', () => {
    const first: TimelineItem = { id: 'a', type: 'output', timestamp: 1, content: 'Hel' };
    const second: TimelineItem = { id: 'b', type: 'output', timestamp: 2, content: 'lo' };
    const grouped = groupTimeline([first, second]);

    assert.equal(grouped[0].type, 'single');
    if (grouped[0].type === 'single') {
      assert.equal(grouped[0].item.content, 'Hello');
    }
  });
});

describe('safeStringify', () => {
  it('handles circular values and undefined', () => {
    const value: { self?: unknown } = {};
    value.self = value;
    assert.match(safeStringify(value), /\[Circular\]/);
    assert.equal(safeStringify(undefined), 'undefined');
  });
});
