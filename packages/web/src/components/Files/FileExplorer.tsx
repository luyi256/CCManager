import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  File,
  FileCode,
  FileImage,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  RefreshCw,
  X,
} from 'lucide-react';
import clsx from 'clsx';
import FileViewer from './FileViewer';
import { useDirListing, useFileSync } from '../../hooks/useProjectFiles';
import { useWebSocket } from '../../contexts/WebSocketContext';
import { ancestorDirs, fileIconKind, joinPath, pruneExpanded, type FileIconKind } from '../../utils/fileTree';
import type { FileEntry } from '../../services/api';

interface FileExplorerProps {
  projectId: string;
  projectPath: string;
  onClose: () => void;
}

const TREE_MIN = 200;
const VIEWER_MIN = 320;
const MAIN_MIN = 360;

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function useStoredState<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => readStored(key, fallback));
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage full or disabled; state still works for this session.
    }
  }, [key, value]);
  return [value, setValue] as const;
}

function useIsDesktop(): boolean {
  const query = '(min-width: 768px)';
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return matches;
}

/** Drag handle on the left edge of a right-docked column. */
function ResizeHandle({ width, onResize, min, max }: {
  width: number;
  onResize: (width: number) => void;
  min: number;
  max: () => number;
}) {
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const onMove = (move: PointerEvent) => {
      onResize(Math.round(Math.min(Math.max(startWidth + startX - move.clientX, min), Math.max(min, max()))));
    };
    const onUp = () => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  };
  return (
    <div
      onPointerDown={onPointerDown}
      className="absolute left-0 top-0 bottom-0 w-1.5 -translate-x-1/2 cursor-col-resize z-10 hover:bg-primary-500/40 active:bg-primary-500/60 touch-none"
      role="separator"
      aria-orientation="vertical"
    />
  );
}

const FILE_ICONS: Record<FileIconKind, typeof File> = {
  code: FileCode,
  image: FileImage,
  text: FileText,
  other: File,
};

interface TreeContext {
  projectId: string;
  expanded: Set<string>;
  selected: string | null;
  toggle: (path: string) => void;
  openFile: (path: string) => void;
}

/** Leaf rows skip the chevron's width so their icons line up with folder icons. */
function rowPadding(depth: number, leaf = false) {
  return { paddingLeft: 8 + depth * 12 + (leaf ? 18 : 0) };
}

const FileRow = memo(function FileRow({ entry, path, depth, ctx }: {
  entry: FileEntry;
  path: string;
  depth: number;
  ctx: TreeContext;
}) {
  const Icon = FILE_ICONS[fileIconKind(entry.name)];
  const selected = ctx.selected === path;
  return (
    <button
      role="treeitem"
      aria-selected={selected}
      onClick={() => ctx.openFile(path)}
      className={clsx(
        'w-full flex items-center gap-1 h-[24px] pr-2 text-left text-[13px] truncate',
        selected ? 'bg-primary-500/20 text-dark-50' : 'text-dark-300 hover:bg-dark-800',
      )}
      style={rowPadding(depth, true)}
      title={path}
    >
      <Icon size={14} className="shrink-0 text-dark-500" />
      <span className={clsx('truncate', entry.symlink && 'italic')}>{entry.name}</span>
    </button>
  );
});

function DirNode({ entry, path, depth, ctx }: {
  entry: FileEntry;
  path: string;
  depth: number;
  ctx: TreeContext;
}) {
  const open = ctx.expanded.has(path);
  return (
    <div role="group">
      <button
        role="treeitem"
        aria-expanded={open}
        onClick={() => ctx.toggle(path)}
        className="w-full flex items-center gap-1 h-[24px] pr-2 text-left text-[13px] text-dark-200 hover:bg-dark-800 truncate"
        style={rowPadding(depth)}
        title={path}
      >
        {open ? <ChevronDown size={14} className="shrink-0 text-dark-500" /> : <ChevronRight size={14} className="shrink-0 text-dark-500" />}
        {open ? <FolderOpen size={14} className="shrink-0 text-sky-400" /> : <Folder size={14} className="shrink-0 text-sky-400" />}
        <span className={clsx('truncate', entry.symlink && 'italic')}>{entry.name}</span>
      </button>
      {open && <DirChildren path={path} depth={depth + 1} ctx={ctx} />}
    </div>
  );
}

function DirChildren({ path, depth, ctx }: { path: string; depth: number; ctx: TreeContext }) {
  const { data, isLoading, error, refetch } = useDirListing(ctx.projectId, path);
  const pad = rowPadding(depth, true);

  if (isLoading) {
    return (
      <div className="flex items-center gap-1.5 h-[24px] text-xs text-dark-500" style={pad}>
        <Loader2 size={12} className="animate-spin" /> Loading…
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="flex items-center gap-2 min-h-[24px] py-0.5 pr-2 text-xs text-red-400" style={pad}>
        <span className="truncate" title={error instanceof Error ? error.message : undefined}>
          {error instanceof Error ? error.message : 'Could not load folder'}
        </span>
        <button onClick={() => refetch()} className="shrink-0 underline text-dark-300 hover:text-dark-100">Retry</button>
      </div>
    );
  }
  return (
    <>
      {data.entries.length === 0 && (
        <div className="h-[24px] flex items-center text-xs italic text-dark-600" style={pad}>Empty folder</div>
      )}
      {data.entries.map((entry) => {
        const childPath = joinPath(path, entry.name);
        return entry.type === 'dir'
          ? <DirNode key={`d:${entry.name}`} entry={entry} path={childPath} depth={depth} ctx={ctx} />
          : <FileRow key={`f:${entry.name}`} entry={entry} path={childPath} depth={depth} ctx={ctx} />;
      })}
      {data.truncated && (
        <div className="h-[24px] flex items-center text-xs text-amber-400" style={pad}>
          Showing the first {data.entries.length} items
        </div>
      )}
    </>
  );
}

export default function FileExplorer({ projectId, projectPath, onClose }: FileExplorerProps) {
  const queryClient = useQueryClient();
  const { watchFiles, unwatchFiles, connectionGeneration } = useWebSocket();
  const isDesktop = useIsDesktop();
  const [expandedList, setExpandedList] = useStoredState<string[]>(`ccm_files_expanded:${projectId}`, []);
  const [openFile, setOpenFile] = useStoredState<string | null>(`ccm_files_open:${projectId}`, null);
  const [treeWidth, setTreeWidth] = useStoredState('ccm_files_tree_width', 280);
  const [viewerWidth, setViewerWidth] = useStoredState('ccm_files_viewer_width', Math.round(window.innerWidth * 0.38));
  const [mobileShowsFile, setMobileShowsFile] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const expanded = useMemo(() => new Set(expandedList), [expandedList]);
  // Folders inside a collapsed parent are remembered but not on screen.
  const visibleExpanded = useMemo(
    () => expandedList.filter((dir) => ancestorDirs(dir).every((ancestor) => expanded.has(ancestor))),
    [expandedList, expanded],
  );

  const toggle = useCallback((path: string) => {
    setExpandedList((current) => current.includes(path)
      ? current.filter((dir) => dir !== path)
      : [...current, path]);
  }, [setExpandedList]);

  const open = useCallback((path: string) => {
    setOpenFile(path);
    setMobileShowsFile(true);
  }, [setOpenFile]);

  const onMissing = useCallback((missing: string[]) => {
    setExpandedList((current) => pruneExpanded(current, missing));
  }, [setExpandedList]);

  const sync = useFileSync(projectId, visibleExpanded, openFile, onMissing);

  const watchKey = visibleExpanded.join('\n');
  useEffect(() => {
    watchFiles(projectId, ['', ...(watchKey ? watchKey.split('\n') : [])]);
  }, [projectId, watchKey, connectionGeneration, watchFiles]);
  useEffect(() => () => unwatchFiles(), [unwatchFiles]);

  const refresh = async () => {
    await sync();
    await queryClient.refetchQueries({
      queryKey: ['files'],
      predicate: (query) => query.state.status === 'error' && query.queryKey[2] === projectId,
    });
  };

  const ctx: TreeContext = useMemo(() => ({
    projectId,
    expanded,
    selected: openFile,
    toggle,
    openFile: open,
  }), [projectId, expanded, openFile, toggle, open]);

  const rootName = projectPath.replace(/\/+$/, '').split('/').pop() || projectPath;

  const tree = (
    <div className="flex flex-col h-full min-w-0 bg-dark-850">
      <div className="flex items-center gap-1 pl-3 pr-1.5 h-10 border-b border-dark-700 shrink-0">
        <span className="flex-1 truncate text-[11px] font-semibold uppercase tracking-wider text-dark-400" title={projectPath}>
          {rootName}
        </span>
        <button onClick={refresh} className="btn btn-ghost p-1.5" title="Refresh" aria-label="Refresh files">
          <RefreshCw size={14} />
        </button>
        <button onClick={() => setExpandedList([])} className="btn btn-ghost p-1.5" title="Collapse folders" aria-label="Collapse folders">
          <ChevronsDownUp size={14} />
        </button>
        <button onClick={onClose} className="btn btn-ghost p-1.5" title="Close explorer" aria-label="Close explorer">
          <X size={14} />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto py-1" role="tree" aria-label="Project files">
        <DirChildren path="" depth={0} ctx={ctx} />
      </div>
    </div>
  );

  const closeFile = () => {
    setOpenFile(null);
    setMobileShowsFile(false);
  };

  if (!isDesktop) {
    return (
      <div className="fixed inset-0 top-14 z-40 flex flex-col bg-dark-900" role="dialog" aria-label="Project files">
        {openFile && mobileShowsFile
          ? <FileViewer projectId={projectId} path={openFile} onClose={closeFile} onBack={() => setMobileShowsFile(false)} />
          : tree}
      </div>
    );
  }

  const availableWidth = () => (panelRef.current?.parentElement?.clientWidth ?? window.innerWidth);
  return (
    <div ref={panelRef} className="flex h-full shrink-0 border-l border-dark-700">
      {openFile && (
        <div className="relative h-full border-r border-dark-700" style={{ width: viewerWidth }}>
          <ResizeHandle
            width={viewerWidth}
            onResize={setViewerWidth}
            min={VIEWER_MIN}
            max={() => availableWidth() - treeWidth - MAIN_MIN}
          />
          <FileViewer key={openFile} projectId={projectId} path={openFile} onClose={closeFile} />
        </div>
      )}
      <div className="relative h-full" style={{ width: treeWidth }}>
        <ResizeHandle
          width={treeWidth}
          onResize={setTreeWidth}
          min={TREE_MIN}
          max={() => availableWidth() - (openFile ? viewerWidth : 0) - MAIN_MIN}
        />
        {tree}
      </div>
    </div>
  );
}