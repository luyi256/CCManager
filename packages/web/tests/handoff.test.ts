import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitHandoffPrompt } from '../src/utils/handoff';

test('a handed-off prompt shows only the user message and its source task', () => {
  const prompt = [
    'Please continue with opus',
    '',
    '---',
    'Context: this continues CCManager task #274, which ran on tCodex (gpt-6-astra). The earlier conversation is below.',
    '',
    '<previous_conversation>',
    '[User]\nFix it',
    '</previous_conversation>',
  ].join('\n');

  assert.deepEqual(splitHandoffPrompt(prompt), { message: 'Please continue with opus', sourceTaskId: 274 });
});

test('an ordinary prompt is left as is', () => {
  assert.deepEqual(splitHandoffPrompt('Fix the bug\n\n---\nnotes'), { message: 'Fix the bug\n\n---\nnotes' });
});
