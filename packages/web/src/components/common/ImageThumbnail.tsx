import { Image as ImageIcon, X } from 'lucide-react';
import { useAttachmentUrl } from '../../hooks/useAttachmentUrl';

const SIZES = {
  sm: 'w-12 h-12',
  md: 'w-16 h-16',
} as const;

interface ImageThumbnailProps {
  src: string;
  alt: string;
  size?: keyof typeof SIZES;
  onRemove?: () => void;
  onClick?: () => void;
}

export default function ImageThumbnail({
  src,
  alt,
  size = 'sm',
  onRemove,
  onClick,
}: ImageThumbnailProps) {
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
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="absolute top-0 right-0 p-0.5 bg-dark-900/80 rounded-bl-lg text-dark-300 hover:text-white opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100 transition-opacity"
          aria-label={`Remove ${alt}`}
        >
          <X size={size === 'md' ? 12 : 10} />
        </button>
      )}
    </div>
  );
}

interface AttachmentThumbnailProps {
  taskId: number;
  attachmentId: number;
  alt: string;
  size?: keyof typeof SIZES;
}

/** A thumbnail for an already-sent attachment, fetched with the auth header. */
export function AttachmentThumbnail({
  taskId,
  attachmentId,
  alt,
  size = 'sm',
}: AttachmentThumbnailProps) {
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
