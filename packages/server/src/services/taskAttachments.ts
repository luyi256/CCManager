import { db } from './database.js';

const MAX_IMAGE_COUNT = 8;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 30 * 1024 * 1024;
const IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\r\n]+)$/;

export interface ParsedImage {
  dataUrl: string;
  mimeType: string;
  byteSize: number;
}

function hasValidSignature(mimeType: string, bytes: Buffer): boolean {
  if (mimeType === 'image/png') {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (mimeType === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === 'image/gif') {
    const header = bytes.subarray(0, 6).toString('ascii');
    return header === 'GIF87a' || header === 'GIF89a';
  }
  if (mimeType === 'image/webp') {
    return bytes.length >= 12 &&
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  return false;
}

export function validateTaskImages(value: unknown): ParsedImage[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('Images must be an array');
  if (value.length > MAX_IMAGE_COUNT) throw new Error(`A task can include at most ${MAX_IMAGE_COUNT} images`);

  let totalBytes = 0;
  return value.map((item, index) => {
    if (typeof item !== 'string') throw new Error(`Image ${index + 1} is invalid`);
    const match = item.match(IMAGE_DATA_URL);
    if (!match) throw new Error(`Image ${index + 1} must be PNG, JPEG, GIF, or WebP`);
    const mimeType = match[1];
    const normalizedBase64 = match[2].replace(/\s/g, '');
    const bytes = Buffer.from(normalizedBase64, 'base64');
    if (!bytes.length || !hasValidSignature(mimeType, bytes)) {
      throw new Error(`Image ${index + 1} content does not match ${mimeType}`);
    }
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`Image ${index + 1} exceeds the 10 MB limit`);
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Images exceed the 30 MB total limit');
    return {
      dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`,
      mimeType,
      byteSize: bytes.length,
    };
  });
}

export function replaceTaskImages(taskId: number, value: unknown): string[] {
  const images = validateTaskImages(value);
  const replace = db.transaction(() => {
    db.prepare('DELETE FROM task_attachments WHERE task_id = ?').run(taskId);
    const insert = db.prepare(`
      INSERT INTO task_attachments (task_id, position, mime_type, byte_size, data_url)
      VALUES (?, ?, ?, ?, ?)
    `);
    images.forEach((image, position) => {
      insert.run(taskId, position, image.mimeType, image.byteSize, image.dataUrl);
    });
  });
  replace();
  return images.map((image) => image.dataUrl);
}

export function getTaskImages(taskId: number): string[] {
  const rows = db.prepare(`
    SELECT data_url FROM task_attachments
    WHERE task_id = ?
    ORDER BY position ASC
  `).all(taskId) as Array<{ data_url: string }>;
  return rows.map((row) => row.data_url);
}
