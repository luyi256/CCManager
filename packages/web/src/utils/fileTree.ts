/** Project-relative paths use `/` separators; '' is the project root. */
export function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

export function isSameOrDescendant(path: string, ancestor: string): boolean {
  return ancestor === '' || path === ancestor || path.startsWith(`${ancestor}/`);
}

/** Drop directories that disappeared, together with everything expanded below them. */
export function pruneExpanded(expanded: string[], missing: string[]): string[] {
  if (missing.length === 0) return expanded;
  return expanded.filter((dir) => !missing.some((gone) => gone !== '' && isSameOrDescendant(dir, gone)));
}

/** Folders that must be expanded for `path` (file or folder) to be visible in the tree. */
export function ancestorDirs(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
}

const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cc',
  'cpp', 'hpp', 'cs', 'swift', 'php', 'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml', 'xml', 'html', 'css',
  'scss', 'less', 'vue', 'svelte', 'sql', 'lua', 'r', 'scala', 'dart', 'ini', 'cfg', 'conf', 'proto',
]);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg']);
const TEXT_EXTENSIONS = new Set(['md', 'markdown', 'txt', 'rst', 'log', 'csv', 'tsv']);

export type FileIconKind = 'code' | 'image' | 'text' | 'other';

export function fileIconKind(name: string): FileIconKind {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if (CODE_EXTENSIONS.has(ext)) return 'code';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  return 'other';
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
