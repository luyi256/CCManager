import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * Task attachments arrive as base64 data URLs. Images are unnamed and handed to
 * runners natively; any other file carries a `name` parameter
 * (`data:application/pdf;name=paper.pdf;base64,...`) and is saved to disk so
 * the runner can read it with its own tools.
 */
const DATA_URL = /^data:([^;,]*)((?:;[^;,]*)*?);base64,(.*)$/s;

export interface AttachedFile {
  name: string;
  data: Buffer;
}

function nameParameter(parameters: string): string | undefined {
  for (const parameter of parameters.split(';')) {
    if (!parameter.startsWith('name=')) continue;
    try {
      return decodeURIComponent(parameter.slice(5));
    } catch {
      return parameter.slice(5);
    }
  }
  return undefined;
}

function safeFileName(name: string): string {
  const cleaned = path.basename(name.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'attachment';
}

export function splitAttachments(dataUrls: string[] | undefined): { images: string[]; files: AttachedFile[] } {
  const images: string[] = [];
  const files: AttachedFile[] = [];
  for (const dataUrl of dataUrls || []) {
    const match = dataUrl.match(DATA_URL);
    const name = match ? nameParameter(match[2]) : undefined;
    if (!match || !name) {
      images.push(dataUrl);
      continue;
    }
    files.push({ name: safeFileName(name), data: Buffer.from(match[3], 'base64') });
  }
  return { images, files };
}

function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Save files under `dir`, keeping their names. Re-sending the same file reuses
 * it; a different file with a taken name gets a numbered suffix.
 */
export function saveAttachedFiles(dir: string, files: AttachedFile[]): string[] {
  if (files.length === 0) return [];
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return files.map((file) => {
    const ext = path.extname(file.name);
    const stem = file.name.slice(0, file.name.length - ext.length);
    for (let index = 0; ; index++) {
      const candidate = path.join(dir, index === 0 ? file.name : `${stem}-${index}${ext}`);
      if (!fs.existsSync(candidate)) {
        fs.writeFileSync(candidate, file.data, { mode: 0o600 });
        return candidate;
      }
      if (sha256(fs.readFileSync(candidate)) === sha256(file.data)) return candidate;
    }
  });
}

export function describeAttachedFiles(paths: string[]): string {
  if (paths.length === 0) return '';
  const noun = paths.length === 1 ? 'file' : 'files';
  return `\n\nI've attached ${paths.length} ${noun}. They are saved at:\n${paths.map((file) => `- ${file}`).join('\n')}`;
}
