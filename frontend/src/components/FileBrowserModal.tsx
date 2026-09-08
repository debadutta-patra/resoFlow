import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  X,
  Folder,
  File,
  CornerLeftUp,
  Check,
  FolderPlus,
  ChevronRight,
  Search,
  HardDrive,
} from 'lucide-react';
import api from '../services/api';
import {
  applyNameFilter,
  applyTypeFilter,
  buildBreadcrumb,
  crumbTarget,
  formatModified,
  formatSize,
  isSelectable as isItemSelectable,
  nextNavigableIndex,
  normalizeExtensions,
  type FileItem,
  type RootInfo,
} from '../lib/fileBrowser';

interface BrowseResponse {
  path: string;
  display_path: string;
  items: FileItem[];
  roots?: RootInfo[];
}

const RECENTS_KEY = 'resoflow.fileBrowser.recentPaths';
const MAX_RECENTS = 5;

/** Browser storage is a per-viewer convenience here; never let it break the modal. */
const readRecents = (): RootInfo[] => {
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.slice(0, MAX_RECENTS) : [];
  } catch {
    return [];
  }
};

const writeRecents = (entries: RootInfo[]): void => {
  try {
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(entries.slice(0, MAX_RECENTS)));
  } catch {
    /* private mode, blocked storage: recents are optional */
  }
};

interface FileBrowserModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
  selectType: 'directory' | 'file';
  /** One extension or several, e.g. ".ft2" or [".ft2", ".ft3"]. */
  fileExtension?: string | string[];
}

const FileBrowserModal: React.FC<FileBrowserModalProps> = ({
  isOpen,
  onClose,
  onSelect,
  selectType,
  fileExtension,
}) => {
  // Canonical path, used for mkdir and for what we hand back via onSelect.
  const [currentPath, setCurrentPath] = useState<string>('');
  // Host-facing spelling of currentPath, shown to the user.
  const [displayPath, setDisplayPath] = useState<string>('');
  // The text box. Kept separate so half-typed input cannot be mistaken for
  // the directory we are actually browsing.
  const [pathInput, setPathInput] = useState<string>('');
  const [isEditingPath, setIsEditingPath] = useState<boolean>(false);
  const [items, setItems] = useState<FileItem[]>([]);
  const [roots, setRoots] = useState<RootInfo[]>([]);
  const [recents, setRecents] = useState<RootInfo[]>([]);
  const [nameFilter, setNameFilter] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [selectedItemPath, setSelectedItemPath] = useState<string>('');
  const [focusIndex, setFocusIndex] = useState<number>(-1);
  const [isCreatingFolder, setIsCreatingFolder] = useState<boolean>(false);
  const [newFolderName, setNewFolderName] = useState<string>('');
  const [isMkdirLoading, setIsMkdirLoading] = useState<boolean>(false);
  // Guards against a slow earlier listing landing after a newer one.
  const requestSeq = useRef<number>(0);
  const listRef = useRef<HTMLDivElement>(null);
  // Path to select once the listing it lives in arrives (used after mkdir).
  const pendingSelection = useRef<string>('');

  const extensions = useMemo<string[]>(() => normalizeExtensions(fileExtension), [fileExtension]);

  useEffect(() => {
    if (isOpen) {
      setRecents(readRecents());
      fetchDirectory(currentPath);
    }
    // Only refetch when the modal opens; navigation drives every other fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Arrow keys are handled on the modal, so something inside it has to hold
  // focus for them to arrive at all.
  useEffect(() => {
    if (isOpen) listRef.current?.focus();
  }, [isOpen]);

  const rememberRecent = (entry: RootInfo) => {
    setRecents(prev => {
      const next = [entry, ...prev.filter(r => r.path !== entry.path)].slice(0, MAX_RECENTS);
      writeRecents(next);
      return next;
    });
  };

  const fetchDirectory = async (path: string) => {
    const seq = ++requestSeq.current;
    setIsLoading(true);
    setError('');
    try {
      const response = await api.get<BrowseResponse>('/api/fs/browse', {
        params: path ? { path } : {},
      });
      // Drop a response that a newer navigation has already superseded --
      // double-clicking down a tree can otherwise land listings out of order.
      if (seq !== requestSeq.current) return;
      // Always take the directory the backend actually resolved. When `path` is
      // empty the backend picks the default storage root, and without adopting
      // its answer we would not know where mkdir should create the folder.
      setItems(response.data.items);
      setRoots(response.data.roots ?? []);
      setCurrentPath(response.data.path);
      setDisplayPath(response.data.display_path);
      setPathInput(response.data.display_path);
      setIsEditingPath(false);
      setNameFilter('');
      setFocusIndex(-1);
      setSelectedItemPath(pendingSelection.current);
      pendingSelection.current = '';
      rememberRecent({
        name: response.data.display_path.split('/').filter(Boolean).pop() || response.data.display_path,
        path: response.data.path,
        display_path: response.data.display_path,
      });
    } catch (err: any) {
      if (seq !== requestSeq.current) return;
      pendingSelection.current = '';
      setError(err.response?.data?.detail || 'Failed to load directory');
    } finally {
      if (seq === requestSeq.current) {
        setIsLoading(false);
        setIsCreatingFolder(false);
        setNewFolderName('');
      }
    }
  };

  const handleCreateFolder = async () => {
    if (!newFolderName.trim() || !currentPath) return;

    setIsMkdirLoading(true);
    setError('');
    try {
      const response = await api.post<{ path: string }>('/api/fs/mkdir', {
        path: currentPath,
        name: newFolderName.trim(),
      });
      setIsCreatingFolder(false);
      setNewFolderName('');
      // Land on the folder that was just created rather than making the user
      // hunt for it in the refreshed listing.
      pendingSelection.current = response.data?.path ?? '';
      fetchDirectory(currentPath);
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Failed to create folder');
    } finally {
      setIsMkdirLoading(false);
    }
  };

  const parentItem = items.find(i => i.name === '..');

  const isSelectable = (item: FileItem): boolean =>
    isItemSelectable(item, selectType, extensions);

  const selectItem = (item: FileItem) => {
    if (isSelectable(item)) setSelectedItemPath(item.path);
  };

  const openItem = (item: FileItem) => {
    if (item.is_dir) fetchDirectory(item.path);
  };

  const handleConfirm = () => {
    if (selectedItemPath) {
      onSelect(selectedItemPath);
    } else if (selectType === 'directory' && currentPath) {
      onSelect(currentPath);
    }
  };

  // Entries hidden because of selectType/extension, before the name filter.
  const typeFiltered = useMemo(
    () => applyTypeFilter(items, selectType, extensions),
    [items, selectType, extensions]
  );

  const filteredItems = useMemo(
    () => applyNameFilter(typeFiltered, nameFilter),
    [typeFiltered, nameFilter]
  );

  // Trimmed to the permitted root containing the current directory: segments
  // above a root would be refused, so they are not offered as links.
  const breadcrumb = useMemo(() => buildBreadcrumb(displayPath, roots), [displayPath, roots]);

  const navigateToCrumb = (index: number) => {
    if (!breadcrumb) return;
    // Index -1 is the root itself, which we can navigate to canonically.
    if (index < 0) {
      if (breadcrumb.root) fetchDirectory(breadcrumb.root.path);
      return;
    }
    const target = crumbTarget(breadcrumb, index);
    if (target) fetchDirectory(target);
  };

  /** Move the highlight, skipping the parent row, and select what we land on. */
  const moveFocus = (delta: number) => {
    if (filteredItems.length === 0) return;
    const next = nextNavigableIndex(filteredItems, focusIndex, delta);
    if (next < 0) return;
    setFocusIndex(next);
    const item = filteredItems[next];
    if (isSelectable(item)) setSelectedItemPath(item.path);
    const row = listRef.current?.querySelector(
      `[data-row-index="${next}"]`
    ) as HTMLElement | null;
    if (row && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'nearest' });
    }
  };

  /** Enter: descend into a directory, or confirm a selected file. */
  const activateFocused = () => {
    const item = filteredItems[focusIndex];
    if (item) {
      if (item.is_dir) openItem(item);
      else if (isSelectable(item)) handleConfirm();
      return;
    }
    if (selectedItemPath || selectType === 'directory') handleConfirm();
  };

  const handleListKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    // Text fields carry their own bindings; typing must never navigate.
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveFocus(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      activateFocused();
      return;
    }

    if (e.key === 'Backspace') {
      e.preventDefault();
      if (parentItem) fetchDirectory(parentItem.path);
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      if (nameFilter) setNameFilter('');
      else onClose();
    }
  };

  /**
   * The filter box is the one text field that hands navigation keys through:
   * after narrowing a folder, the natural next move is to arrow into the
   * results without first having to click the list.
   */
  const handleFilterKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveFocus(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      activateFocused();
      return;
    }
    if (e.key === 'Escape') {
      e.stopPropagation();
      setNameFilter('');
    }
  };

  if (!isOpen) return null;

  const quickLinks = [
    ...roots.map(r => ({ ...r, isRoot: true })),
    ...recents.filter(r => !roots.some(root => root.path === r.path)).map(r => ({ ...r, isRoot: false })),
  ];

  const titleSuffix =
    extensions.length === 0
      ? 'File'
      : extensions.length === 1
      ? extensions[0]
      : `${extensions.slice(0, -1).join(', ')} or ${extensions[extensions.length - 1]}`;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-900/50 dark:bg-slate-900/80 backdrop-blur-sm transition-opacity duration-200"
      onKeyDown={handleListKeyDown}
    >
      <div className="bg-white dark:bg-slate-800 rounded-xl shadow-2xl w-full max-w-3xl overflow-hidden flex flex-col max-h-[85vh] border border-transparent dark:border-slate-700 animate-in fade-in zoom-in duration-200">

        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700 flex justify-between items-center bg-slate-50 dark:bg-slate-800/50 shrink-0">
          <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
            {selectType === 'directory' ? 'Select Directory' : `Select ${titleSuffix}`}
          </h3>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Location bar: breadcrumb by default, editable path on demand */}
        <div className="p-4 border-b border-slate-100 dark:border-slate-700 bg-white dark:bg-slate-800 shrink-0 flex items-center space-x-2">
          <button
            title="Go up (Backspace)"
            disabled={!parentItem}
            onClick={() => parentItem && fetchDirectory(parentItem.path)}
            className="p-2 shrink-0 text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <CornerLeftUp className="w-5 h-5" />
          </button>

          {isEditingPath ? (
            <input
              autoFocus
              type="text"
              value={pathInput}
              onChange={e => setPathInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') fetchDirectory(pathInput);
                if (e.key === 'Escape') {
                  setPathInput(displayPath);
                  setIsEditingPath(false);
                }
              }}
              onBlur={() => setIsEditingPath(false)}
              placeholder="Enter a path..."
              className="flex-1 min-w-0 px-3 py-1.5 bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded text-sm font-mono text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          ) : (
            <div
              onClick={() => setIsEditingPath(true)}
              title="Click to edit the path"
              className="flex-1 min-w-0 flex items-center overflow-x-auto whitespace-nowrap px-3 py-1.5 bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded text-sm cursor-text"
            >
              {breadcrumb?.root && (
                <>
                  <button
                    onClick={e => {
                      e.stopPropagation();
                      navigateToCrumb(-1);
                    }}
                    className="shrink-0 font-medium text-blue-600 dark:text-indigo-400 hover:underline"
                  >
                    {breadcrumb.root.name}
                  </button>
                  {breadcrumb.segments.length > 0 && (
                    <ChevronRight className="w-3.5 h-3.5 mx-0.5 shrink-0 text-slate-400" />
                  )}
                </>
              )}
              {breadcrumb?.segments.map((segment, idx) => (
                <React.Fragment key={idx}>
                  <button
                    onClick={e => {
                      e.stopPropagation();
                      navigateToCrumb(idx);
                    }}
                    className={`shrink-0 hover:underline ${
                      idx === breadcrumb.segments.length - 1
                        ? 'text-slate-900 dark:text-white font-medium'
                        : 'text-slate-500 dark:text-slate-400'
                    }`}
                  >
                    {segment}
                  </button>
                  {idx < breadcrumb.segments.length - 1 && (
                    <ChevronRight className="w-3.5 h-3.5 mx-0.5 shrink-0 text-slate-400" />
                  )}
                </React.Fragment>
              ))}
              {!breadcrumb && (
                <span className="text-slate-400">Click to enter a path...</span>
              )}
            </div>
          )}

          {selectType === 'directory' && (
            <button
              title={currentPath ? 'New Folder' : 'Open a directory first'}
              disabled={!currentPath}
              onClick={() => setIsCreatingFolder(!isCreatingFolder)}
              className={`p-2 shrink-0 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                isCreatingFolder
                  ? 'bg-blue-100 text-blue-600 dark:bg-indigo-900/60 dark:text-indigo-400'
                  : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700'
              }`}
            >
              <FolderPlus className="w-5 h-5" />
            </button>
          )}
        </div>

        <div className="flex flex-1 min-h-0">
          {/* Quick access */}
          {quickLinks.length > 0 && (
            <div className="hidden md:flex w-48 shrink-0 flex-col border-r border-slate-100 dark:border-slate-700 bg-white dark:bg-slate-800 overflow-y-auto p-2">
              <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                Quick access
              </p>
              {quickLinks.map(link => (
                <button
                  key={link.path}
                  onClick={() => fetchDirectory(link.path)}
                  title={link.display_path}
                  className={`flex items-center px-2 py-1.5 rounded text-sm text-left truncate transition-colors ${
                    link.path === currentPath
                      ? 'bg-blue-50 text-blue-700 dark:bg-indigo-900/40 dark:text-indigo-200'
                      : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700/60'
                  }`}
                >
                  {link.isRoot ? (
                    <HardDrive className="w-4 h-4 mr-2 shrink-0 text-slate-400" />
                  ) : (
                    <Folder className="w-4 h-4 mr-2 shrink-0 text-slate-400" />
                  )}
                  <span className="truncate">{link.name}</span>
                </button>
              ))}
            </div>
          )}

          <div className="flex-1 min-w-0 flex flex-col">
            {/* Filter */}
            <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-700 bg-white dark:bg-slate-800 shrink-0 flex items-center">
              <Search className="w-4 h-4 mr-2 shrink-0 text-slate-400" />
              <input
                type="text"
                value={nameFilter}
                onChange={e => {
                  setNameFilter(e.target.value);
                  setFocusIndex(-1);
                }}
                onKeyDown={handleFilterKeyDown}
                placeholder="Filter this folder..."
                className="flex-1 min-w-0 bg-transparent border-none focus:ring-0 text-sm text-slate-900 dark:text-white placeholder-slate-400 p-0"
              />
              {nameFilter && (
                <button
                  onClick={() => setNameFilter('')}
                  className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* File list */}
            <div
              ref={listRef}
              tabIndex={0}
              className="flex-1 overflow-y-auto p-2 bg-slate-50 dark:bg-slate-900/50 min-h-[300px] focus:outline-none"
            >
              {error ? (
                <div className="flex justify-center items-center h-full text-red-500 dark:text-red-400 text-sm p-4 text-center">
                  {error}
                </div>
              ) : isLoading && items.length === 0 ? (
                <div className="flex justify-center items-center h-full">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 dark:border-indigo-500"></div>
                </div>
              ) : (
                // Keep the previous listing on screen while the next one loads.
                <div className={`space-y-1 transition-opacity ${isLoading ? 'opacity-50' : ''}`}>
                  {isCreatingFolder && (
                    <div className="flex items-center px-3 py-2 bg-blue-50/50 dark:bg-indigo-900/20 rounded-md border border-blue-200 dark:border-indigo-800/50 mb-2 animate-in slide-in-from-top-2 duration-200">
                      <div className="mr-3">
                        <FolderPlus className="w-5 h-5 text-blue-500 dark:text-indigo-400" />
                      </div>
                      <input
                        autoFocus
                        type="text"
                        value={newFolderName}
                        onChange={e => setNewFolderName(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') handleCreateFolder();
                          if (e.key === 'Escape') {
                            e.stopPropagation();
                            setIsCreatingFolder(false);
                          }
                        }}
                        placeholder="New folder name..."
                        className="flex-1 bg-transparent border-none focus:ring-0 text-sm text-slate-900 dark:text-white placeholder-slate-400 p-0"
                      />
                      <div className="flex space-x-1 ml-2">
                        <button
                          onClick={handleCreateFolder}
                          disabled={isMkdirLoading || !newFolderName.trim()}
                          className="p-1 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 rounded disabled:opacity-50"
                        >
                          <Check className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => setIsCreatingFolder(false)}
                          className="p-1 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  )}

                  {filteredItems.map((item, idx) => {
                    const isSelected = selectedItemPath === item.path;
                    const isFocused = focusIndex === idx;
                    // A symlink we could not stat is dangling.
                    const isBroken = !!item.is_symlink && item.modified === null;
                    const selectable = isSelectable(item);
                    return (
                      <div
                        key={item.path}
                        data-row-index={idx}
                        onClick={() => {
                          setFocusIndex(idx);
                          if (item.name === '..') openItem(item);
                          else selectItem(item);
                        }}
                        onDoubleClick={() => openItem(item)}
                        className={`group flex items-center px-3 py-2 rounded-md select-none transition-colors ${
                          selectable || item.is_dir ? 'cursor-pointer' : 'cursor-default'
                        } ${
                          isSelected
                            ? 'bg-blue-100 dark:bg-indigo-900/60 text-blue-900 dark:text-indigo-100'
                            : isFocused
                            ? 'bg-slate-200/70 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
                            : 'text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800/80'
                        } ${!selectable && item.name !== '..' && !item.is_dir ? 'opacity-60' : ''}`}
                      >
                        <div className="mr-3 shrink-0">
                          {item.is_dir ? (
                            <Folder
                              className={`w-5 h-5 ${
                                isSelected
                                  ? 'text-blue-600 dark:text-indigo-400'
                                  : 'text-blue-400 dark:text-indigo-500/70'
                              }`}
                              fill="currentColor"
                              fillOpacity={0.2}
                            />
                          ) : (
                            <File className="w-5 h-5 text-slate-400 dark:text-slate-500" />
                          )}
                        </div>
                        <span className="flex-1 truncate text-sm" title={item.display_path}>
                          {item.name}
                          {item.is_symlink && (
                            <span
                              className="ml-1 text-slate-400 dark:text-slate-500"
                              title={isBroken ? 'Broken symbolic link' : 'Symbolic link'}
                            >
                              {isBroken ? '⚠' : '↗'}
                            </span>
                          )}
                        </span>
                        {item.name !== '..' && (
                          <>
                            <span className="hidden sm:block w-20 shrink-0 text-right text-xs tabular-nums text-slate-400 dark:text-slate-500">
                              {formatSize(item.size)}
                            </span>
                            <span className="hidden sm:block w-28 shrink-0 text-right text-xs text-slate-400 dark:text-slate-500">
                              {formatModified(item.modified)}
                            </span>
                          </>
                        )}
                        {/* Explicit affordance for descending, so that clicking
                            a row can mean "select it" without ambiguity. */}
                        {item.is_dir && item.name !== '..' && (
                          <button
                            title="Open folder"
                            onClick={e => {
                              e.stopPropagation();
                              openItem(item);
                            }}
                            className="ml-2 p-1 shrink-0 rounded text-slate-400 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-slate-300/60 dark:hover:bg-slate-700 hover:text-slate-700 dark:hover:text-slate-200 transition-opacity"
                          >
                            <ChevronRight className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    );
                  })}

                  {filteredItems.length === 0 && (
                    <div className="text-center text-slate-500 py-10 text-sm px-4">
                      {nameFilter ? (
                        <>
                          <p>
                            Nothing here matches &ldquo;{nameFilter}&rdquo;.
                          </p>
                          <button
                            onClick={() => setNameFilter('')}
                            className="mt-2 text-blue-600 dark:text-indigo-400 hover:underline"
                          >
                            Clear filter
                          </button>
                        </>
                      ) : items.length > (parentItem ? 1 : 0) ? (
                        <p>
                          This folder has no{' '}
                          {selectType === 'directory'
                            ? 'subfolders'
                            : extensions.length
                            ? `${extensions.join(' or ')} files`
                            : 'matching files'}
                          .
                        </p>
                      ) : (
                        <p>This folder is empty.</p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-100 dark:border-slate-700 bg-white dark:bg-slate-800 shrink-0 flex items-center justify-between">
          <div className="flex-1 truncate mr-4 text-xs text-slate-500 dark:text-slate-400">
            {selectedItemPath ? (
              <span className="font-mono bg-slate-100 dark:bg-slate-900 px-2 py-1 rounded select-all">
                {items.find(i => i.path === selectedItemPath)?.display_path ?? selectedItemPath}
              </span>
            ) : selectType === 'directory' && displayPath ? (
              <span className="font-mono bg-slate-100 dark:bg-slate-900 px-2 py-1 rounded select-all">
                {displayPath}
              </span>
            ) : null}
          </div>
          <div className="flex space-x-3 shrink-0">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-700 focus:outline-none transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={!selectedItemPath && (selectType === 'file' || !currentPath)}
              className="px-4 py-2 flex items-center text-sm font-medium text-white bg-blue-600 dark:bg-indigo-600 border border-transparent rounded-lg hover:bg-blue-700 dark:hover:bg-indigo-700 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
            >
              <Check className="w-4 h-4 mr-2" />
              Select
            </button>
          </div>
        </div>

      </div>
    </div>
  );
};

export default FileBrowserModal;
