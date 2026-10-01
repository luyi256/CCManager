import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultAttachmentPrompt, getTaskImagesForDispatch, isImageAttachment, validateTaskAttachments as validateTaskImages } from './taskAttachments.js';

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

  it('does not impose a per-image limit below the total request bound', () => {
    const largePng = `data:image/png;base64,${Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.alloc(11 * 1024 * 1024),
    ]).toString('base64')}`;
    const images = validateTaskImages([largePng]);
    assert.ok(images[0].byteSize > 10 * 1024 * 1024);
  });

  it('accepts named files of any type and keeps their sanitized name', () => {
    const pdf = `data:application/pdf;name=${encodeURIComponent('../审稿 意见.pdf')};base64,${Buffer.from('%PDF-1.7').toString('base64')}`;
    const [file] = validateTaskImages([pdf]);
    assert.equal(file.mimeType, 'application/pdf');
    assert.equal(file.fileName, '.._审稿 意见.pdf');
    assert.equal(isImageAttachment(file.dataUrl), false);
    assert.equal(isImageAttachment(png), true);
    assert.equal(defaultAttachmentPrompt([png, file.dataUrl]), 'Please analyze the 2 attached files.');
    assert.equal(defaultAttachmentPrompt([png]), 'Please analyze the 1 attached image.');
  });

  it('falls back to a generic type for an unusable file type', () => {
    const [file] = validateTaskImages([`data:;name=notes;base64,${Buffer.from('x').toString('base64')}`]);
    assert.equal(file.mimeType, 'application/octet-stream');
  });

  it('does not resend images with a generic continue prompt', () => {
    assert.equal(getTaskImagesForDispatch(-1, false), undefined);
  });
});
