import { useMemo, useState, type ReactNode } from 'react';
import { ArrowLeft, Check, Code2, Copy, Eye, Loader2, RefreshCw, X } from 'lucide-react';
import SafeMarkdown from '../common/SafeMarkdown';
import { useFileContent } from '../../hooks/useProjectFiles';
import { formatRelativeTime } from '../../utils/dateTime';
import { formatBytes, isMarkdownPath } from '../../utils/fileTree';

interface FileViewerProps {
  projectId: string;
  path: string;
  onClose: () => void;
  /** Mobile: return to the tree instead of closing the file. */
  onBack?: () => void;
}

function TextView({ content }: { content: string }) {
  const gutter = useMemo(() => {
    let lines = 1;
    for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) lines++;
    return Array.from({ length: lines }, (_, index) => index + 1).join('\n');
  }, [content]);

  return (
    <div className="flex-1 min-h-0 overflow-auto font-mono text-[12.5px] leading-5">
      <div className="flex min-w-max py-2">
        <pre className="sticky left-0 select-none bg-dark-900 pl-3 pr-3 text-right text-dark-600 border-r border-dark-800">{gutter}</pre>
        <pre className="pl-4 pr-8 text-dark-200">{content}</pre>
      </div>
    </div>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="flex-1 flex items-center justify-center p-6 text-center text-sm text-dark-400">
      <div>{children}</div>
    </div>
  );
}

export default function FileViewer({ projectId, path, onClose, onBack }: FileViewerProps) {
  const { data, isLoading, isFetching, error, refetch } = useFileContent(projectId, path);
  const [preview, setPreview] = useState(true);
  const [copied, setCopied] = useState(false);
  const markdown = isMarkdownPath(path) && data?.kind === 'text';
  const name = path.split('/').pop() || path;
  const dir = path.slice(0, path.length - name.length);

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied outside secure contexts.
    }
  };

  let body: ReactNode;
  if (isLoading) {
    body = <Notice><Loader2 size={18} className="animate-spin inline" /></Notice>;
  } else if (error || !data) {
    body = (
      <Notice>
        <p className="text-red-400">{error instanceof Error ? error.message : 'Could not load file'}</p>
        <button onClick={() => refetch()} className="btn btn-secondary mt-3 text-xs">Try again</button>
      </Notice>
    );
  } else if (data.kind === 'binary') {
    body = <Notice>Binary file ({formatBytes(data.size)}) — preview not available.</Notice>;
  } else if (data.kind === 'too_large') {
    body = <Notice>File is too large to preview ({formatBytes(data.size)}).</Notice>;
  } else if (data.kind === 'image') {
    body = (
      <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center p-6 bg-[repeating-conic-gradient(#1e293b_0%_25%,#0f172a_0%_50%)] bg-[length:16px_16px]">
        <img src={`data:${data.mime};base64,${data.content}`} alt={name} className="max-w-full max-h-full object-contain" />
      </div>
    );
  } else if (data.content.length === 0) {
    body = <Notice>Empty file</Notice>;
  } else if (markdown && preview) {
    body = (
      <div className="flex-1 min-h-0 overflow-auto px-6 py-4 text-sm text-dark-200">
        <SafeMarkdown>{data.content}</SafeMarkdown>
      </div>
    );
  } else {
    body = <TextView content={data.content} />;
  }

  return (
    <div className="flex flex-col h-full min-w-0 bg-dark-900">
      <div className="flex items-center gap-2 px-3 h-10 border-b border-dark-700 bg-dark-850 shrink-0">
        {onBack && (
          <button onClick={onBack} className="btn btn-ghost p-1.5" aria-label="Back to files">
            <ArrowLeft size={16} />
          </button>
        )}
        <div className="min-w-0 flex-1 truncate font-mono text-xs" title={path}>
          <span className="text-dark-500">{dir}</span>
          <span className="text-dark-100">{name}</span>
        </div>
        {data && (
          <span className="hidden sm:inline shrink-0 text-[11px] text-dark-500" title={new Date(data.mtime).toLocaleString()}>
            {formatBytes(data.size)} · {formatRelativeTime(data.mtime)}
          </span>
        )}
        {isFetching && !isLoading && <Loader2 size={14} className="animate-spin text-dark-500 shrink-0" />}
        {markdown && (
          <button
            onClick={() => setPreview((value) => !value)}
            className="btn btn-ghost p-1.5"
            title={preview ? 'Show source' : 'Show preview'}
            aria-label={preview ? 'Show source' : 'Show preview'}
          >
            {preview ? <Code2 size={15} /> : <Eye size={15} />}
          </button>
        )}
        <button onClick={copyPath} className="btn btn-ghost p-1.5" title="Copy relative path" aria-label="Copy relative path">
          {copied ? <Check size={15} className="text-green-400" /> : <Copy size={15} />}
        </button>
        <button onClick={() => refetch()} className="btn btn-ghost p-1.5" title="Reload file" aria-label="Reload file">
          <RefreshCw size={15} />
        </button>
        {!onBack && (
          <button onClick={onClose} className="btn btn-ghost p-1.5" title="Close file" aria-label="Close file">
            <X size={15} />
          </button>
        )}
      </div>
      {data?.kind === 'text' && data.truncated && (
        <div className="px-3 py-1.5 text-[11px] text-amber-300 bg-amber-500/10 border-b border-amber-500/20 shrink-0">
          Preview truncated to the first 1 MB of {formatBytes(data.size)}.
        </div>
      )}
      {body}
    </div>
  );
}
