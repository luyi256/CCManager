export interface PendingImage {
  id: string;
  dataUrl: string;
  name: string;
  byteSize: number;
}

export const MAX_IMAGE_COUNT = 8;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 30 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function imageId(): string {
  return `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function readImageFiles(
  files: Iterable<File>,
  existing: PendingImage[] = [],
): Promise<{ images: PendingImage[]; error?: string }> {
  const selected = Array.from(files);
  if (existing.length + selected.length > MAX_IMAGE_COUNT) {
    return { images: existing, error: `You can attach at most ${MAX_IMAGE_COUNT} images.` };
  }

  const next = [...existing];
  let totalBytes = existing.reduce((sum, image) => sum + image.byteSize, 0);
  for (const file of selected) {
    if (!SUPPORTED_IMAGE_TYPES.has(file.type)) {
      return { images: existing, error: `${file.name || 'Image'} is not a supported PNG, JPEG, GIF, or WebP file.` };
    }
    if (file.size > MAX_IMAGE_BYTES) {
      return { images: existing, error: `${file.name || 'Image'} exceeds the 10 MB limit.` };
    }
    totalBytes += file.size;
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
      return { images: existing, error: 'Attached images exceed the 30 MB total limit.' };
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('Could not read image'));
      reader.onerror = () => reject(reader.error || new Error('Could not read image'));
      reader.readAsDataURL(file);
    });
    next.push({
      id: imageId(),
      dataUrl,
      name: file.name || `image-${Date.now()}`,
      byteSize: file.size,
    });
  }
  return { images: next };
}
