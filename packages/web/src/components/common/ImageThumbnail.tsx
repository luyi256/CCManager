import { useState } from 'react';
import { FileText, Image as ImageIcon, Loader2, X } from 'lucide-react';
import { useAttachmentUrl } from '../../hooks/useAttachmentUrl';
import * as api from '../../services/api';

const SIZES = {
  sm: 'w-12 h-12',
  md: 'w-16 h-16',
} as const;

const FILE_SIZES = {
  sm: 'h-12 max-w-[10rem]',
  md: 'h-16 max-w-[12rem]',
} as const;

interface ImageThumbnailProps {
  src: string;
  alt: string;
  size?: keyof typeof SIZES;
  onRemove?: () => void;
  onClick?: () => void;
  /** Non-image attachments render as a named file tile instead of a preview. */
  isImage?: boolean;
}

function RemoveButton({ alt, size, onRemove }: { alt: string; size: keyof typeof SIZES; onRemove: () => void }) {
  return (
    <button
      type="button"
      onClick={onRemove}
      className="absolute top-0 right-0 p-0.5 bg-dark-900/80 rounded-bl-lg text-dark-300 hover:text-white opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100 transition-opacity"
      aria-label={`Remove ${alt}`}
    >
      <X size={size === 'md' ? 12 : 10} />
    </button>
  );
}

function FileTile({
  name,
  size,
  onRemove,
  onClick,
  busy = false,
}: {
  name: string;
  size: keyof typeof SIZES;
  onRemove?: () => void;
  onClick?: () => void;
  busy?: boolean;
}) {
  return (
    <div
      className={`relative group ${FILE_SIZES[size]} rounded-lg border border-dark-600 bg-dark-800 flex items-center gap-1.5 px-2 ${
        onClick ? 'cursor-pointer hover:border-dark-500' : ''
      }`}
      onClick={onClick}
      title={name}
    >
      {busy
        ? <Loader2 size={16} className="flex-shrink-0 animate-spin text-dark-400" />
        : <FileText size={16} className="flex-shrink-0 text-dark-400" />}
      <span className="truncate text-xs text-dark-300">{name}</span>
      {onRemove && <RemoveButton alt={name} size={size} onRemove={onRemove} />}
    </div>
  );
}

export default function ImageThumbnail({
  src,
  alt,
  size = 'sm',
  onRemove,
  onClick,
  isImage = true,
}: ImageThumbnailProps) {
  if (!isImage) return <FileTile name={alt} size={size} onRemove={onRemove} onClick={onClick} />;
  return (
    <div
      className={`relative group ${SIZES[size]} rounded-lg overflow-hidden border border-dark-600 bg-dark-800`}
    >
      <img
        src={src}
        alt={alt}
        loading="lazy"
        onClick={onClick}
        className={`w-full h-full object-cover ${onClick ? 'cursor-zoom-in' : ''}`}
      />
      {onRemove && <RemoveButton alt={alt} size={size} onRemove={onRemove} />}
    </div>
  );
}

interface AttachmentThumbnailProps {
  taskId: number;
  attachmentId: number;
  alt: string;
  size?: keyof typeof SIZES;
  mimeType?: string;
  fileName?: string;
}

/** A thumbnail for an already-sent attachment, fetched with the auth header. */
export function AttachmentThumbnail(props: AttachmentThumbnailProps) {
  return props.fileName
    ? <AttachmentFile {...props} fileName={props.fileName} />
    : <AttachmentImage {...props} />;
}

function AttachmentImage({ taskId, attachmentId, alt, size = 'sm' }: AttachmentThumbnailProps) {
  const { url, isError } = useAttachmentUrl(taskId, attachmentId);

  // Never render a broken <img>: show a placeholder or a muted icon instead.
  if (!url) {
    return (
      <div
        className={`${SIZES[size]} rounded-lg border border-dark-600 flex items-center justify-center ${
          isError ? 'bg-dark-800' : 'bg-dark-700 animate-pulse'
        }`}
        title={isError ? `${alt} could not be loaded` : alt}
      >
        {isError && <ImageIcon size={14} className="text-dark-500" />}
      </div>
    );
  }

  return (
    <ImageThumbnail
      src={url}
      alt={alt}
      size={size}
      onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
    />
  );
}

/** Files can be large, so they are only fetched when the user downloads them. */
function AttachmentFile({ taskId, attachmentId, size = 'sm', fileName }: AttachmentThumbnailProps & { fileName: string }) {
  const [busy, setBusy] = useState(false);
  const download = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const blob = await api.fetchAttachmentBlob(taskId, attachmentId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      console.error(`Failed to download ${fileName}:`, error);
    } finally {
      setBusy(false);
    }
  };
  return <FileTile name={fileName} size={size} onClick={() => void download()} busy={busy} />;
}
