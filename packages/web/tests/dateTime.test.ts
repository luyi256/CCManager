import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatRelativeTime,
  getTimestamp,
  parseServerDate,
} from '../src/utils/dateTime';

describe('server date handling', () => {
  it('treats timezone-less SQLite timestamps as UTC', () => {
    assert.equal(
      parseServerDate('2026-07-31 12:34:56')?.toISOString(),
      '2026-07-31T12:34:56.000Z'
    );
  });

  it('does not append a second timezone to ISO timestamps', () => {
    assert.equal(
      parseServerDate('2026-07-31T12:34:56.000Z')?.toISOString(),
      '2026-07-31T12:34:56.000Z'
    );
    assert.equal(
      parseServerDate('2026-07-31T20:34:56+08:00')?.toISOString(),
      '2026-07-31T12:34:56.000Z'
    );
  });

  it('returns safe fallbacks for invalid timestamps', () => {
    assert.equal(parseServerDate('not-a-date'), null);
    assert.equal(getTimestamp('not-a-date'), 0);
    assert.equal(formatRelativeTime('not-a-date'), 'Unknown');
  });

  it('clamps future timestamps instead of showing negative relative time', () => {
    assert.equal(formatRelativeTime('2026-07-31T12:01:00Z', Date.parse('2026-07-31T12:00:00Z')), 'just now');
  });
});
