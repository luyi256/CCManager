import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canSendFollowUpForTask, hasResumeSession, isTaskActive } from '../src/utils/taskResume';

describe('task follow-up availability', () => {
  it('allows follow-up while a task is active even before a session id is available', () => {
    assert.equal(isTaskActive('running'), true);
    assert.equal(canSendFollowUpForTask({ status: 'running' }), true);
  });

  it('allows follow-up after successful completion when the task has a resumable session', () => {
    const task = {
      status: 'completed' as const,
      gitInfo: JSON.stringify({ sessionId: 'session-212' }),
    };

    assert.equal(hasResumeSession(task), true);
    assert.equal(canSendFollowUpForTask(task), true);
  });

  it('keeps follow-up visible after completion even before refreshed session metadata arrives', () => {
    assert.equal(canSendFollowUpForTask({ status: 'completed' }), true);
  });

  it('does not require valid session metadata to render the follow-up control', () => {
    assert.equal(hasResumeSession({ gitInfo: '{broken-json' }), false);
    assert.equal(canSendFollowUpForTask({ status: 'completed', gitInfo: '{broken-json' }), true);
  });

  it('allows retryable failed tasks to continue when a resumable session exists', () => {
    assert.equal(
      canSendFollowUpForTask({
        status: 'failed',
        gitInfo: JSON.stringify({ sessionId: 'session-after-failure' }),
      }),
      true
    );
  });
});
