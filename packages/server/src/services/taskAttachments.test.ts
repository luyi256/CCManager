import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateTaskImages } from './taskAttachments.js';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
const jpeg = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD';

describe('task image validation', () => {
  it('accepts supported image data URLs', () => {
    const images = validateTaskImages([png, jpeg]);
    assert.equal(images.length, 2);
    assert.equal(images[0].mimeType, 'image/png');
    assert.ok(images[0].byteSize > 0);
  });

  it('rejects unsupported or spoofed image data', () => {
    assert.throws(() => validateTaskImages(['data:image/svg+xml;base64,PHN2Zz4=']), /PNG, JPEG, GIF, or WebP/);
    assert.throws(() => validateTaskImages(['data:image/png;base64,aGVsbG8=']), /does not match/);
  });

  it('rejects too many images', () => {
    assert.throws(() => validateTaskImages(Array.from({ length: 9 }, () => png)), /at most 8/);
  });
});
