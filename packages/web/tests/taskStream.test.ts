import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TaskStreamEvent, TaskStreamSnapshot } from '../src/types';
import {
  applyTaskStreamEvent,
  applyTaskStreamSnapshot,
  createTaskStreamModel,
  phaseForTaskStatus,
} from '../src/utils/taskStream';

function textEvent(overrides: Partial<TaskStreamEvent> = {}): TaskStreamEvent {
  return {
    version: 1,
    taskId: 7,
    eventId: 'event-1',
    kind: 'text',
    timestamp: '2026-07-31T12:00:00Z',
    blockId: 'assistant-1',
    mode: 'delta',
    text: 'Hello',
    ...overrides,
  };
}

describe('task stream model', () => {
  it('merges incremental text by block id and offset', () => {
    let model = createTaskStreamModel(7);
    model = applyTaskStreamEvent(model, textEvent({ text: 'Hel' }));
    model = applyTaskStreamEvent(model, textEvent({
      eventId: 'event-2',
      text: 'lo',
      offset: 3,
    }));

    assert.equal(model.messages.length, 1);
    assert.equal(model.messages[0].text, 'Hello');
    assert.equal(model.phase, 'thinking');
  });

  it('merges sequential deltas by run when the server omits block ids', () => {
    let model = createTaskStreamModel(7);
    model = applyTaskStreamEvent(model, textEvent({
      eventId: 'delta-1',
      blockId: undefined,
      runId: 'run-7',
      text: 'Hel',
    }));
    model = applyTaskStreamEvent(model, textEvent({
      eventId: 'delta-2',
      blockId: undefined,
      runId: 'run-7',
      text: 'lo',
    }));

    assert.equal(model.messages.length, 1);
    assert.equal(model.messages[0].text, 'Hello');
  });

  it('updates tool lifecycle without duplicating the tool call', () => {
    let model = createTaskStreamModel(7);
    model = applyTaskStreamEvent(model, {
      version: 1,
      taskId: 7,
      eventId: 'tool-start',
      kind: 'tool',
      timestamp: '2026-07-31T12:00:01Z',
      tool: { id: 'tool-1', name: 'bash', input: { command: 'pwd' }, status: 'running' },
    });
    model = applyTaskStreamEvent(model, {
      version: 1,
      taskId: 7,
      eventId: 'tool-end',
      kind: 'tool',
      timestamp: '2026-07-31T12:00:02Z',
      tool: { id: 'tool-1', name: 'bash', result: '/workspace', status: 'completed' },
    });

    assert.equal(model.toolCalls.length, 1);
    assert.equal(model.toolCalls[0].status, 'completed');
    assert.equal(model.toolCalls[0].result, '/workspace');
    assert.equal(model.phase, 'thinking');
  });

  it('hydrates from a snapshot and keeps the highest cursor', () => {
    const snapshot: TaskStreamSnapshot = {
      version: 1,
      taskId: 7,
      cursor: 12,
      phase: 'tool',
      generatedAt: '2026-07-31T12:00:03Z',
      events: [
        textEvent({ logId: 9, mode: 'snapshot', text: 'Recovered output' }),
      ],
    };

    const model = applyTaskStreamSnapshot(createTaskStreamModel(7), snapshot);
    assert.equal(model.hydrated, true);
    assert.equal(model.cursor, 12);
    assert.equal(model.phase, 'tool');
    assert.equal(model.messages[0].text, 'Recovered output');
  });

  it('does not let replayed history overwrite the snapshot lifecycle phase', () => {
    const snapshot: TaskStreamSnapshot = {
      version: 1,
      taskId: 7,
      cursor: 4,
      phase: 'completed',
      generatedAt: '2026-07-31T12:00:03Z',
      events: [
        textEvent({
          eventId: 'replayed-output',
          logId: 4,
          mode: 'snapshot',
          text: 'Final answer',
          replay: true,
        }),
      ],
    };

    const model = applyTaskStreamSnapshot(createTaskStreamModel(7), snapshot);
    assert.equal(model.phase, 'completed');
    assert.equal(model.messages[0].text, 'Final answer');
  });

  it('uses a new run snapshot phase instead of stale local phase', () => {
    const current = {
      ...createTaskStreamModel(7),
      phase: 'completed' as const,
      runId: 'old-run',
      messages: [{ id: 'old', text: 'Old output', timestamp: 1 }],
    };
    const snapshot: TaskStreamSnapshot = {
      version: 1,
      taskId: 7,
      cursor: 0,
      phase: 'starting',
      runId: 'new-run',
      generatedAt: '2026-07-31T12:00:04Z',
      events: [],
    };

    const next = applyTaskStreamSnapshot(current, snapshot);
    assert.equal(next.phase, 'starting');
    assert.deepEqual(next.messages, []);
  });

  it('maps task status to visible phases', () => {
    assert.equal(phaseForTaskStatus('pending'), 'queued');
    assert.equal(phaseForTaskStatus('running'), 'starting');
    assert.equal(phaseForTaskStatus('waiting_permission'), 'waiting');
    assert.equal(phaseForTaskStatus('completed_with_warnings'), 'completed');
    assert.equal(phaseForTaskStatus('cancelled'), 'cancelled');
  });

  it('keeps live activity visible when a polling running status arrives', () => {
    let model = createTaskStreamModel(7);
    model = applyTaskStreamEvent(model, textEvent({ text: 'Streaming' }));
    assert.equal(model.phase, 'thinking');
    assert.equal(phaseForTaskStatus('running'), 'starting');
  });
});
