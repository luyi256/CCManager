export interface PendingAttachment {
  id: string;
  /**
   * Images are plain data URLs. Other files carry their name as a data URL
   * parameter (`data:application/pdf;name=paper.pdf;base64,...`) so the name
   * survives queueing, retries and dispatch without a separate field.
   */
  dataUrl: string;
  name: string;
  byteSize: number;
  isImage: boolean;
}

export const MAX_IMAGE_COUNT = 8;
export const MAX_ATTACHMENT_COUNT = 16;
export const MAX_TOTAL_ATTACHMENT_BYTES = 36 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Prompt used when a message has attachments but no text. */
export function defaultAttachmentPrompt(items: PendingAttachment[]): string {
  const noun = items.every((item) => item.isImage) ? 'image' : 'file';
  return `Please analyze the ${items.length} attached ${noun}${items.length === 1 ? '' : 's'}.`;
}

function attachmentId(): string {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function readDataUrl(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error(`Could not read ${file.name || 'file'}`));
    reader.onerror = () => reject(reader.error || new Error(`Could not read ${file.name || 'file'}`));
    reader.readAsDataURL(file);
  });
}

export async function readAttachmentFiles(
  files: Iterable<File>,
  existing: PendingAttachment[] = [],
): Promise<{ images: PendingAttachment[]; error?: string }> {
  const selected = Array.from(files);
  if (existing.length + selected.length > MAX_ATTACHMENT_COUNT) {
    return { images: existing, error: `You can attach at most ${MAX_ATTACHMENT_COUNT} files.` };
  }

  const next = [...existing];
  let totalBytes = existing.reduce((sum, item) => sum + item.byteSize, 0);
  let imageCount = existing.filter((item) => item.isImage).length;
  for (const file of selected) {
    totalBytes += file.size;
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      return { images: existing, error: 'Attachments exceed the 36 MB total request limit.' };
    }
    if (file.size === 0) {
      return { images: existing, error: `${file.name || 'File'} is empty.` };
    }
    const isImage = SUPPORTED_IMAGE_TYPES.has(file.type);
    if (isImage && ++imageCount > MAX_IMAGE_COUNT) {
      return { images: existing, error: `You can attach at most ${MAX_IMAGE_COUNT} images.` };
    }
    const raw = await readDataUrl(file);
    const name = file.name || (isImage ? `image-${Date.now()}` : `file-${Date.now()}`);
    const dataUrl = isImage
      ? raw
      : `data:${file.type || 'application/octet-stream'};name=${encodeURIComponent(name)};base64,${raw.slice(raw.indexOf(',') + 1)}`;
    next.push({ id: attachmentId(), dataUrl, name, byteSize: file.size, isImage });
  }
  return { images: next };
}
