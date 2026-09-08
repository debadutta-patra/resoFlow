/**
 * Pure helpers for the file browser modal.
 *
 * Kept out of the component so they can be tested directly: the project has no
 * DOM test environment, only vitest over plain modules.
 */

export interface FileItem {
  name: string;
  /** Canonical path, sent back to the API. Not necessarily what the user sees. */
  path: string;
  /** The same location as the user's own machine spells it. Display only. */
  display_path: string;
  is_dir: boolean;
  is_symlink?: boolean;
  size?: number | null;
  modified?: number | null;
}

export interface RootInfo {
  name: string;
  path: string;
  display_path: string;
}

export interface Breadcrumb {
  /** The permitted root containing the path, when one does. */
  root: RootInfo | null;
  /** Path segments below that root (or the whole path when there is no root). */
  segments: string[];
}

export type SelectType = 'directory' | 'file';

const stripTrailingSlash = (p: string): string => (p.length > 1 ? p.replace(/\/$/, '') : p);

export const normalizeExtensions = (fileExtension?: string | string[]): string[] => {
  if (!fileExtension) return [];
  return Array.isArray(fileExtension) ? fileExtension : [fileExtension];
};

export const matchesExtension = (name: string, extensions: string[]): boolean =>
  extensions.length === 0 || extensions.some(ext => name.endsWith(ext));

export const formatSize = (bytes?: number | null): string => {
  if (bytes === null || bytes === undefined) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
};

export const formatModified = (epochSeconds?: number | null): string => {
  if (epochSeconds === null || epochSeconds === undefined) return '';
  return new Date(epochSeconds * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
};

/**
 * Whether an entry can be chosen as the modal's result.
 *
 * In file mode a directory counts: Bruker spectra are directories (pdata
 * trees), not single files, and the extension filter must not exclude them.
 */
export const isSelectable = (
  item: FileItem,
  selectType: SelectType,
  extensions: string[]
): boolean => {
  if (item.name === '..') return false;
  if (selectType === 'directory') return item.is_dir;
  return item.is_dir || matchesExtension(item.name, extensions);
};

/** Entries to show for a given select type, before any name filter. */
export const applyTypeFilter = (
  items: FileItem[],
  selectType: SelectType,
  extensions: string[]
): FileItem[] =>
  items.filter(item => {
    if (selectType === 'directory') return item.is_dir;
    // Directories are kept regardless of extension so the tree can be walked.
    if (!item.is_dir) return matchesExtension(item.name, extensions);
    return true;
  });

/** Narrow a listing by a case-insensitive substring of the entry name. */
export const applyNameFilter = (items: FileItem[], filter: string): FileItem[] => {
  const needle = filter.trim().toLowerCase();
  if (!needle) return items;
  return items.filter(item => item.name === '..' || item.name.toLowerCase().includes(needle));
};

/**
 * Build a breadcrumb trail, trimmed to the deepest permitted root containing
 * the path. Segments above a root are omitted deliberately: browsing to them
 * would be refused, so offering them as links would only produce errors.
 */
export const buildBreadcrumb = (displayPath: string, roots: RootInfo[]): Breadcrumb | null => {
  if (!displayPath) return null;

  const containing = roots
    .filter(r => {
      const rootPath = stripTrailingSlash(r.display_path);
      return displayPath === rootPath || displayPath.startsWith(rootPath + '/');
    })
    .sort((a, b) => b.display_path.length - a.display_path.length)[0];

  if (!containing) {
    return { root: null, segments: displayPath.split('/').filter(Boolean) };
  }

  const rest = displayPath
    .slice(stripTrailingSlash(containing.display_path).length)
    .split('/')
    .filter(Boolean);
  return { root: containing, segments: rest };
};

/** The display path a breadcrumb segment points at. `index` of -1 means the root. */
export const crumbTarget = (breadcrumb: Breadcrumb, index: number): string | null => {
  if (index < 0) return breadcrumb.root ? breadcrumb.root.display_path : null;
  const base = breadcrumb.root ? stripTrailingSlash(breadcrumb.root.display_path) : '';
  return `${base}/${breadcrumb.segments.slice(0, index + 1).join('/')}`;
};

/**
 * Next index for arrow-key navigation, skipping the parent (`..`) row.
 *
 * The parent row is reachable by click and by Backspace, but it must not
 * absorb the first ArrowDown: it cannot be selected, so landing there looks
 * like the key did nothing, and a following Enter would navigate up instead of
 * opening the entry the user thought they were on.
 *
 * Returns `from` unchanged when there is nowhere further to go.
 */
export const nextNavigableIndex = (
  items: FileItem[],
  from: number,
  delta: number
): number => {
  let i = from;
  for (let guard = 0; guard <= items.length; guard++) {
    i += delta;
    if (i < 0 || i >= items.length) return from;
    if (items[i].name !== '..') return i;
  }
  return from;
};

/** First index arrow navigation should land on, or -1 when there is none. */
export const firstNavigableIndex = (items: FileItem[]): number =>
  nextNavigableIndex(items, -1, 1);
