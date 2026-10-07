import { createHash } from 'crypto';
import fs from 'fs';
import { open, readdir, realpath, stat } from 'fs/promises';
import path from 'path';
import { validatePath } from './security.js';
import type { AgentConfig } from './types.js';

/** Hidden like VS Code's default `files.exclude`. */
const EXCLUDED_NAMES = new Set(['.git', '.svn', '.hg', 'CVS', '.DS_Store', 'Thumbs.db']);
export const MAX_DIR_ENTRIES = 5000;
export const MAX_TEXT_BYTES = 1024 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8000;
const MAX_SYNC_DIRS = 200;

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

export interface FileAccessRequest {
  projectPath: string;
  /** Project-level allowed paths, merged with the agent's own list. */
  allowedPaths?: string[];
}

export interface FileEntry {
  name: string;
  type: 'file' | 'dir';
  symlink?: boolean;
}

export interface DirListing {
  path: string;
  etag: string;
  entries: FileEntry[];
  truncated?: boolean;
}

export type FileContent = {
  path: string;
  etag: string;
  size: number;
  mtime: string;
} & (
  | { kind: 'text'; content: string; truncated?: boolean }
  | { kind: 'image'; content: string; mime: string }
  | { kind: 'binary' }
  | { kind: 'too_large' }
);

export interface SyncRequest extends FileAccessRequest {
  dirs: Array<{ path: string; etag?: string }>;
  file?: { path: string; etag?: string };
}

export interface SyncResult {
  /** Only directories whose listing changed. */
  changed: DirListing[];
  /** Directories that no longer exist or became unreadable. */
  missing: string[];
  file?: { path: string; changed: boolean; missing?: boolean };
}

export class FileAccessError extends Error {
  constructor(message: string, readonly code: 'not_found' | 'denied' | 'invalid' | 'not_a_directory' | 'not_a_file') {
    super(message);
  }
}

function isWithin(target: string, base: string): boolean {
  return target === base || target.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
}

function effectiveConfig(config: AgentConfig, request: FileAccessRequest): AgentConfig {
  return request.allowedPaths?.length
    ? { ...config, allowedPaths: [...config.allowedPaths, ...request.allowedPaths] }
    : config;
}

/** Normalize a project-relative path to `a/b/c` form ('' is the project root). */
export function normalizeRelativePath(relPath: string | undefined): string {
  const raw = (relPath ?? '').replace(/\\/g, '/');
  if (raw.includes('\0')) throw new FileAccessError('Invalid path', 'invalid');
  if (raw.startsWith('/')) throw new FileAccessError('Path must be relative to the project', 'invalid');
  const normalized = path.posix.normalize(raw || '.');
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new FileAccessError('Path escapes the project', 'denied');
  }
  return normalized === '.' ? '' : normalized.replace(/\/+$/, '');
}

/**
 * Resolve a project-relative path to an absolute one that stays inside the
 * project after following symlinks and honours the agent's path policy.
 */
export async function resolveProjectPath(
  config: AgentConfig,
  request: FileAccessRequest,
  relPath: string | undefined,
): Promise<{ rel: string; abs: string }> {
  const rel = normalizeRelativePath(relPath);
  const policy = effectiveConfig(config, request);
  const root = path.resolve(request.projectPath);
  try {
    validatePath(root, policy);
  } catch (error) {
    throw new FileAccessError(error instanceof Error ? error.message : String(error), 'denied');
  }

  const abs = rel ? path.join(root, rel) : root;
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await realpath(root);
    realTarget = await realpath(abs);
  } catch {
    throw new FileAccessError(`Not found: ${rel || '.'}`, 'not_found');
  }
  if (!isWithin(realTarget, realRoot)) {
    throw new FileAccessError(`Path leaves the project: ${rel}`, 'denied');
  }
  try {
    validatePath(abs, policy);
  } catch (error) {
    throw new FileAccessError(error instanceof Error ? error.message : String(error), 'denied');
  }
  return { rel, abs: realTarget };
}

function compareEntries(a: FileEntry, b: FileEntry): number {
  if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

function listingEtag(entries: FileEntry[], truncated: boolean): string {
  const hash = createHash('sha1');
  for (const entry of entries) hash.update(`${entry.type}${entry.symlink ? 'l' : ''}:${entry.name}\n`);
  if (truncated) hash.update('truncated');
  return hash.digest('hex').slice(0, 16);
}

async function readListing(abs: string, rel: string): Promise<DirListing> {
  let dirents: fs.Dirent[];
  try {
    dirents = await readdir(abs, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOTDIR') throw new FileAccessError(`Not a directory: ${rel}`, 'not_a_directory');
    if (code === 'ENOENT') throw new FileAccessError(`Not found: ${rel || '.'}`, 'not_found');
    throw new FileAccessError(`Cannot read directory: ${rel || '.'}`, 'denied');
  }

  const visible = dirents.filter((dirent) => !EXCLUDED_NAMES.has(dirent.name));
  const entries = await Promise.all(visible.map(async (dirent): Promise<FileEntry> => {
    if (dirent.isSymbolicLink()) {
      try {
        const target = await stat(path.join(abs, dirent.name));
        return { name: dirent.name, type: target.isDirectory() ? 'dir' : 'file', symlink: true };
      } catch {
        return { name: dirent.name, type: 'file', symlink: true };
      }
    }
    return { name: dirent.name, type: dirent.isDirectory() ? 'dir' : 'file' };
  }));
  entries.sort(compareEntries);
  const truncated = entries.length > MAX_DIR_ENTRIES;
  const kept = truncated ? entries.slice(0, MAX_DIR_ENTRIES) : entries;
  return {
    path: rel,
    etag: listingEtag(kept, truncated),
    entries: kept,
    ...(truncated ? { truncated } : {}),
  };
}

export async function listDirectory(
  config: AgentConfig,
  request: FileAccessRequest & { path?: string },
): Promise<DirListing> {
  const { rel, abs } = await resolveProjectPath(config, request, request.path);
  return readListing(abs, rel);
}

function fileEtag(info: fs.Stats): string {
  return `${info.size.toString(36)}-${Math.floor(info.mtimeMs).toString(36)}`;
}

async function readHead(abs: string, bytes: number): Promise<Buffer> {
  const handle = await open(abs, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function statFile(abs: string, rel: string): Promise<fs.Stats> {
  let info: fs.Stats;
  try {
    info = await stat(abs);
  } catch {
    throw new FileAccessError(`Not found: ${rel}`, 'not_found');
  }
  if (!info.isFile()) throw new FileAccessError(`Not a file: ${rel}`, 'not_a_file');
  return info;
}

/**
 * Read a file for preview. With a matching `etag` only `{ notModified }` is
 * returned so revalidating an open file costs a single stat.
 */
export async function readProjectFile(
  config: AgentConfig,
  request: FileAccessRequest & { path: string; etag?: string },
): Promise<FileContent | { path: string; etag: string; notModified: true }> {
  const { rel, abs } = await resolveProjectPath(config, request, request.path);
  if (!rel) throw new FileAccessError('Not a file: .', 'not_a_file');
  const info = await statFile(abs, rel);
  const etag = fileEtag(info);
  if (request.etag && request.etag === etag) return { path: rel, etag, notModified: true };

  const meta = { path: rel, etag, size: info.size, mtime: info.mtime.toISOString() };
  const mime = IMAGE_MIME[path.extname(rel).toLowerCase()];
  if (mime) {
    if (info.size > MAX_IMAGE_BYTES) return { ...meta, kind: 'too_large' };
    const data = await readHead(abs, info.size);
    return { ...meta, kind: 'image', mime, content: data.toString('base64') };
  }

  const head = await readHead(abs, Math.min(info.size, MAX_TEXT_BYTES));
  if (head.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { ...meta, kind: 'binary' };
  const truncated = info.size > MAX_TEXT_BYTES;
  // Drop a multi-byte character cut by the size cap instead of rendering U+FFFD.
  let text = head.toString('utf8');
  if (truncated && text.endsWith('\uFFFD')) text = text.slice(0, -1);
  return { ...meta, kind: 'text', content: text, ...(truncated ? { truncated } : {}) };
}

/** Revalidate many directories and the open file in one round trip. */
export async function syncProjectFiles(config: AgentConfig, request: SyncRequest): Promise<SyncResult> {
  const result: SyncResult = { changed: [], missing: [] };
  const dirs = (request.dirs || []).slice(0, MAX_SYNC_DIRS);
  await Promise.all(dirs.map(async ({ path: relPath, etag }) => {
    try {
      const listing = await listDirectory(config, { ...request, path: relPath });
      if (listing.etag !== etag) result.changed.push(listing);
    } catch {
      result.missing.push(relPath);
    }
  }));
  if (request.file) {
    try {
      const { rel, abs } = await resolveProjectPath(config, request, request.file.path);
      const info = await statFile(abs, rel);
      result.file = { path: request.file.path, changed: fileEtag(info) !== request.file.etag };
    } catch {
      result.file = { path: request.file.path, changed: true, missing: true };
    }
  }
  return result;
}

const WATCH_DEBOUNCE_MS = 300;
const MAX_WATCHED_DIRS = 200;

interface ProjectWatch {
  watchers: Map<string, fs.FSWatcher>;
  changed: Set<string>;
  timer: NodeJS.Timeout | null;
}

/**
 * Watches only the directories a user has expanded, non-recursively. That
 * keeps inotify usage proportional to what is on screen; network filesystems
 * that deliver no events are covered by the client's periodic sync.
 */
export class ProjectFileWatcher {
  private projects = new Map<string, ProjectWatch>();

  constructor(
    private config: AgentConfig,
    private onChange: (projectId: string, dirs: string[]) => void,
  ) {}

  async set(projectId: string, request: FileAccessRequest, dirs: string[]): Promise<void> {
    const wanted = new Map<string, string>();
    for (const dir of dirs.slice(0, MAX_WATCHED_DIRS)) {
      try {
        const { rel, abs } = await resolveProjectPath(this.config, request, dir);
        wanted.set(rel, abs);
      } catch {
        // Gone or not permitted; the client's sync reports it.
      }
    }

    let watch = this.projects.get(projectId);
    if (wanted.size === 0) {
      if (watch) this.clear(projectId);
      return;
    }
    if (!watch) {
      watch = { watchers: new Map(), changed: new Set(), timer: null };
      this.projects.set(projectId, watch);
    }
    for (const [rel, watcher] of watch.watchers) {
      if (!wanted.has(rel)) {
        watcher.close();
        watch.watchers.delete(rel);
      }
    }
    for (const [rel, abs] of wanted) {
      if (watch.watchers.has(rel)) continue;
      try {
        const watcher = fs.watch(abs, { persistent: false }, () => this.record(projectId, rel));
        watcher.on('error', () => {
          watcher.close();
          if (watch!.watchers.get(rel) === watcher) watch!.watchers.delete(rel);
          this.record(projectId, rel);
        });
        watch.watchers.set(rel, watcher);
      } catch {
        // Out of inotify watches or unsupported filesystem; polling covers it.
      }
    }
  }

  private record(projectId: string, dir: string): void {
    const watch = this.projects.get(projectId);
    if (!watch) return;
    watch.changed.add(dir);
    if (watch.timer) return;
    watch.timer = setTimeout(() => {
      watch.timer = null;
      const dirs = Array.from(watch.changed);
      watch.changed.clear();
      if (dirs.length > 0) this.onChange(projectId, dirs);
    }, WATCH_DEBOUNCE_MS);
  }

  clear(projectId: string): void {
    const watch = this.projects.get(projectId);
    if (!watch) return;
    for (const watcher of watch.watchers.values()) watcher.close();
    if (watch.timer) clearTimeout(watch.timer);
    this.projects.delete(projectId);
  }

  clearAll(): void {
    for (const projectId of Array.from(this.projects.keys())) this.clear(projectId);
  }
}
