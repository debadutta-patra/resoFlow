import { describe, it, expect } from 'vitest';
import {
  normalizeExtensions,
  matchesExtension,
  formatSize,
  formatModified,
  isSelectable,
  applyTypeFilter,
  applyNameFilter,
  buildBreadcrumb,
  crumbTarget,
  nextNavigableIndex,
  firstNavigableIndex,
  type FileItem,
  type RootInfo,
} from './fileBrowser';

const file = (name: string, extra: Partial<FileItem> = {}): FileItem => ({
  name,
  path: `/data/projects/${name}`,
  display_path: `/home/lab/data/${name}`,
  is_dir: false,
  ...extra,
});

const dir = (name: string, extra: Partial<FileItem> = {}): FileItem =>
  file(name, { is_dir: true, ...extra });

describe('fileBrowser', () => {
  describe('normalizeExtensions', () => {
    it('accepts a single extension, a list, or nothing', () => {
      expect(normalizeExtensions()).toEqual([]);
      expect(normalizeExtensions('.ft2')).toEqual(['.ft2']);
      expect(normalizeExtensions(['.ft2', '.ft3'])).toEqual(['.ft2', '.ft3']);
    });
  });

  describe('matchesExtension', () => {
    it('matches any of the given extensions', () => {
      expect(matchesExtension('spectrum.ft2', ['.ft2', '.ft3'])).toBe(true);
      expect(matchesExtension('spectrum.ft3', ['.ft2', '.ft3'])).toBe(true);
      expect(matchesExtension('notes.txt', ['.ft2', '.ft3'])).toBe(false);
    });

    it('accepts everything when no extension is configured', () => {
      expect(matchesExtension('anything.xyz', [])).toBe(true);
    });
  });

  describe('formatSize', () => {
    it('scales through units and omits a fraction for bytes', () => {
      expect(formatSize(0)).toBe('0 B');
      expect(formatSize(512)).toBe('512 B');
      expect(formatSize(1024)).toBe('1.0 KB');
      expect(formatSize(1536)).toBe('1.5 KB');
      expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB');
    });

    it('renders nothing when there is no size (directories, broken links)', () => {
      expect(formatSize(null)).toBe('');
      expect(formatSize(undefined)).toBe('');
    });
  });

  describe('formatModified', () => {
    it('renders nothing when the entry could not be stat-ed', () => {
      expect(formatModified(null)).toBe('');
      expect(formatModified(undefined)).toBe('');
    });

    it('renders a date for an epoch timestamp', () => {
      expect(formatModified(0)).not.toBe('');
    });
  });

  describe('isSelectable', () => {
    it('never selects the parent entry', () => {
      expect(isSelectable(dir('..'), 'directory', [])).toBe(false);
      expect(isSelectable(dir('..'), 'file', [])).toBe(false);
    });

    it('takes only directories in directory mode', () => {
      expect(isSelectable(dir('project_a'), 'directory', [])).toBe(true);
      expect(isSelectable(file('notes.txt'), 'directory', [])).toBe(false);
    });

    it('takes matching files in file mode', () => {
      expect(isSelectable(file('a.ft2'), 'file', ['.ft2'])).toBe(true);
      expect(isSelectable(file('a.txt'), 'file', ['.ft2'])).toBe(false);
    });

    it('still takes directories in file mode, for Bruker pdata trees', () => {
      expect(isSelectable(dir('pdata'), 'file', ['.ft2'])).toBe(true);
    });
  });

  describe('applyTypeFilter', () => {
    it('shows only directories when picking a directory', () => {
      const items = [dir('..'), dir('sub'), file('a.ft2')];
      expect(applyTypeFilter(items, 'directory', []).map(i => i.name)).toEqual(['..', 'sub']);
    });

    it('keeps directories when picking a file so the tree can be walked', () => {
      const items = [dir('..'), dir('sub'), file('a.ft2'), file('b.txt')];
      expect(applyTypeFilter(items, 'file', ['.ft2']).map(i => i.name)).toEqual([
        '..',
        'sub',
        'a.ft2',
      ]);
    });

    it('honours several extensions at once', () => {
      const items = [file('a.ft2'), file('b.ft3'), file('c.txt')];
      expect(applyTypeFilter(items, 'file', ['.ft2', '.ft3']).map(i => i.name)).toEqual([
        'a.ft2',
        'b.ft3',
      ]);
    });
  });

  describe('applyNameFilter', () => {
    it('matches case-insensitive substrings', () => {
      const items = [file('DRB3D1.ft2'), file('drb5d2.ft2'), file('other.ft2')];
      expect(applyNameFilter(items, 'drb').map(i => i.name)).toEqual([
        'DRB3D1.ft2',
        'drb5d2.ft2',
      ]);
    });

    it('always keeps the parent entry so navigation stays possible', () => {
      const items = [dir('..'), file('a.ft2')];
      expect(applyNameFilter(items, 'zzz').map(i => i.name)).toEqual(['..']);
    });

    it('is a no-op for blank input', () => {
      const items = [file('a.ft2'), file('b.ft2')];
      expect(applyNameFilter(items, '   ')).toHaveLength(2);
    });
  });

  describe('nextNavigableIndex', () => {
    const withParent = [dir('..'), dir('alpha'), file('b.ft2'), dir('gamma')];

    it('skips the parent row on the first step down', () => {
      expect(nextNavigableIndex(withParent, -1, 1)).toBe(1);
    });

    it('steps forward and back through real entries', () => {
      expect(nextNavigableIndex(withParent, 1, 1)).toBe(2);
      expect(nextNavigableIndex(withParent, 3, -1)).toBe(2);
    });

    it('stops rather than landing on the parent when moving up', () => {
      expect(nextNavigableIndex(withParent, 1, -1)).toBe(1);
    });

    it('stops at the end of the list', () => {
      expect(nextNavigableIndex(withParent, 3, 1)).toBe(3);
    });

    it('handles a listing that is only the parent row', () => {
      expect(nextNavigableIndex([dir('..')], -1, 1)).toBe(-1);
      expect(firstNavigableIndex([dir('..')])).toBe(-1);
    });

    it('handles an empty listing', () => {
      expect(firstNavigableIndex([])).toBe(-1);
    });

    it('starts at index 0 when there is no parent row', () => {
      expect(firstNavigableIndex([dir('alpha'), file('b.ft2')])).toBe(0);
    });
  });

  describe('buildBreadcrumb', () => {
    const roots: RootInfo[] = [
      { name: 'data', path: '/data/projects', display_path: '/home/lab/data' },
    ];

    it('returns null without a path', () => {
      expect(buildBreadcrumb('', roots)).toBeNull();
    });

    it('trims segments above the containing root', () => {
      const crumb = buildBreadcrumb('/home/lab/data/project_a/cpmg', roots);
      expect(crumb?.root?.name).toBe('data');
      expect(crumb?.segments).toEqual(['project_a', 'cpmg']);
    });

    it('yields no segments when sitting on the root itself', () => {
      const crumb = buildBreadcrumb('/home/lab/data', roots);
      expect(crumb?.root?.name).toBe('data');
      expect(crumb?.segments).toEqual([]);
    });

    it('picks the deepest root when several contain the path', () => {
      const nested: RootInfo[] = [
        ...roots,
        { name: 'spectra', path: '/data/spectra', display_path: '/home/lab/data/spectra' },
      ];
      const crumb = buildBreadcrumb('/home/lab/data/spectra/run1', nested);
      expect(crumb?.root?.name).toBe('spectra');
      expect(crumb?.segments).toEqual(['run1']);
    });

    it('does not treat a sibling with a shared prefix as containing', () => {
      const crumb = buildBreadcrumb('/home/lab/data_archive/x', roots);
      expect(crumb?.root).toBeNull();
      expect(crumb?.segments).toEqual(['home', 'lab', 'data_archive', 'x']);
    });

    it('falls back to plain segments when no root matches', () => {
      const crumb = buildBreadcrumb('/srv/other/place', roots);
      expect(crumb?.root).toBeNull();
      expect(crumb?.segments).toEqual(['srv', 'other', 'place']);
    });
  });

  describe('crumbTarget', () => {
    const roots: RootInfo[] = [
      { name: 'data', path: '/data/projects', display_path: '/home/lab/data' },
    ];

    it('points at the root for index -1', () => {
      const crumb = buildBreadcrumb('/home/lab/data/project_a/cpmg', roots)!;
      expect(crumbTarget(crumb, -1)).toBe('/home/lab/data');
    });

    it('rebuilds the path for an intermediate segment', () => {
      const crumb = buildBreadcrumb('/home/lab/data/project_a/cpmg', roots)!;
      expect(crumbTarget(crumb, 0)).toBe('/home/lab/data/project_a');
      expect(crumbTarget(crumb, 1)).toBe('/home/lab/data/project_a/cpmg');
    });

    it('rebuilds absolute paths when there is no root', () => {
      const crumb = buildBreadcrumb('/srv/other/place', roots)!;
      expect(crumbTarget(crumb, 1)).toBe('/srv/other');
    });
  });
});
