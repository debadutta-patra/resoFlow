import React, { useState, useEffect } from 'react';
import { X, Folder, File, CornerLeftUp, Check, FolderPlus } from 'lucide-react';
import api from '../services/api';

interface FileItem {
  name: string;
  path: string;
  is_dir: boolean;
}

interface FileBrowserModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
  selectType: 'directory' | 'file';
  fileExtension?: string;
}

const FileBrowserModal: React.FC<FileBrowserModalProps> = ({ 
  isOpen, 
  onClose, 
  onSelect, 
  selectType, 
  fileExtension 
}) => {
  const [currentPath, setCurrentPath] = useState<string>('');
  const [items, setItems] = useState<FileItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [selectedItemPath, setSelectedItemPath] = useState<string>('');
  const [isCreatingFolder, setIsCreatingFolder] = useState<boolean>(false);
  const [newFolderName, setNewFolderName] = useState<string>('');
  const [isMkdirLoading, setIsMkdirLoading] = useState<boolean>(false);

  useEffect(() => {
    if (isOpen) {
      fetchDirectory(currentPath);
    }
  }, [isOpen]);

  const fetchDirectory = async (path: string) => {
    setIsLoading(true);
    setError('');
    try {
      const response = await api.get('/api/fs/browse', {
        params: path ? { path } : {}
      });
      // The backend returns absolute path correctly for ".." or normal entries
      setItems(response.data);
      // Set current path based on the response logic if possible, or just what we asked for.
      // Easiest is to wait for backend to return current path, but we didn't add that.
      // So we'll try to infer it. Actually, the backend expands `~` if path is empty.
      // Let's rely on the first item's dirname if we need to. Or we can just let backend
      // rely on the query parameter. If empty, backend serves home. 
      // If we double click `..`, we pass the parent path.
      if (path !== '') {
         setCurrentPath(path);
      }
      setSelectedItemPath('');
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Failed to load directory');
    } finally {
      setIsLoading(false);
      setIsCreatingFolder(false);
      setNewFolderName('');
    }
  };

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return;
    
    setIsMkdirLoading(true);
    setError('');
    try {
      await api.post('/api/fs/mkdir', {
        path: currentPath,
        name: newFolderName.trim()
      });
      setIsCreatingFolder(false);
      setNewFolderName('');
      fetchDirectory(currentPath);
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Failed to create folder');
    } finally {
      setIsMkdirLoading(false);
    }
  };

  if (!isOpen) return null;

  const handleDoubleClick = (item: FileItem) => {
    if (item.is_dir) {
      fetchDirectory(item.path);
    }
  };

  const handleSelectClick = (item: FileItem) => {
    if (selectType === 'directory' && item.is_dir && item.name !== '..') {
      setSelectedItemPath(item.path);
    } else if (selectType === 'file' && !item.is_dir) {
      if (fileExtension && !item.name.endsWith(fileExtension)) {
        return;
      }
      setSelectedItemPath(item.path);
    } else if (selectType === 'file' && item.is_dir && item.name !== '..') {
      setSelectedItemPath(item.path); // Can also select folder to navigate? No, double click navigates
    }
  };

  const handleConfirm = () => {
    if (selectedItemPath) {
      onSelect(selectedItemPath);
    } else if (selectType === 'directory' && currentPath) {
      onSelect(currentPath);
    }
  };

  const filteredItems = items.filter(item => {
    if (selectType === 'directory') {
      return item.is_dir; // Only show directories if selecting directory
    }
    if (selectType === 'file' && !item.is_dir && fileExtension) {
      return item.name.endsWith(fileExtension);
    }
    return true; // Show everything if selecting file (to allow drilling down folders)
  });

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-900/50 dark:bg-slate-900/80 backdrop-blur-sm transition-opacity duration-200">
      <div className="bg-white dark:bg-slate-800 rounded-xl shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[85vh] border border-transparent dark:border-slate-700 animate-in fade-in zoom-in duration-200">
        
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700 flex justify-between items-center bg-slate-50 dark:bg-slate-800/50 shrink-0">
          <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
            {selectType === 'directory' ? 'Select Directory' : `Select ${fileExtension || 'File'}`}
          </h3>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Path Input / Current view */}
        <div className="p-4 border-b border-slate-100 dark:border-slate-700 bg-white dark:bg-slate-800 shrink-0 flex items-center space-x-2">
          <button
            title="Go up"
            onClick={() => {
              const parentItem = items.find(i => i.name === '..');
              if (parentItem) fetchDirectory(parentItem.path);
            }}
            className="p-2 text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 rounded transition-colors"
          >
            <CornerLeftUp className="w-5 h-5" />
          </button>
          
          <input
            type="text"
            value={currentPath}
            onChange={(e) => setCurrentPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                fetchDirectory(currentPath);
              }
            }}
            placeholder="Search path..."
            className="flex-1 px-3 py-1.5 bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            onClick={() => fetchDirectory(currentPath)}
            className="px-3 py-1.5 bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 text-sm font-medium rounded hover:bg-slate-300 dark:hover:bg-slate-600 transition-colors"
          >
            Go
          </button>

          {selectType === 'directory' && (
            <button
              title="New Folder"
              onClick={() => setIsCreatingFolder(!isCreatingFolder)}
              className={`p-2 rounded transition-colors ${
                isCreatingFolder 
                  ? 'bg-blue-100 text-blue-600 dark:bg-indigo-900/60 dark:text-indigo-400' 
                  : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700'
              }`}
            >
              <FolderPlus className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* File List */}
        <div className="flex-1 overflow-y-auto p-2 bg-slate-50 dark:bg-slate-900/50 min-h-[300px]">
          {isLoading ? (
            <div className="flex justify-center items-center h-full">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 dark:border-indigo-500"></div>
            </div>
          ) : error ? (
            <div className="flex justify-center items-center h-full text-red-500 dark:text-red-400 text-sm p-4 text-center">
              {error}
            </div>
          ) : (
            <div className="space-y-1">
              {isCreatingFolder && (
                <div className="flex items-center px-3 py-2 bg-blue-50/50 dark:bg-indigo-900/20 rounded-md border border-blue-200 dark:border-indigo-800/50 mb-2 animate-in slide-in-from-top-2 duration-200">
                  <div className="mr-3">
                    <FolderPlus className="w-5 h-5 text-blue-500 dark:text-indigo-400" />
                  </div>
                  <input
                    autoFocus
                    type="text"
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleCreateFolder();
                      if (e.key === 'Escape') setIsCreatingFolder(false);
                    }}
                    placeholder="New folder name..."
                    className="flex-1 bg-transparent border-none focus:ring-0 text-sm text-slate-900 dark:text-white placeholder-slate-400 p-0"
                  />
                  <div className="flex space-x-1 ml-2">
                    <button
                      onClick={handleCreateFolder}
                      disabled={isMkdirLoading || !newFolderName.trim()}
                      className="p-1 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 rounded disable:opacity-50"
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
                return (
                  <div
                    key={idx}
                    onClick={() => handleSelectClick(item)}
                    onDoubleClick={() => handleDoubleClick(item)}
                    className={`flex items-center px-3 py-2 rounded-md cursor-pointer select-none transition-colors ${
                      isSelected 
                        ? 'bg-blue-100 dark:bg-indigo-900/60 text-blue-900 dark:text-indigo-100' 
                        : 'text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800/80'
                    }`}
                  >
                    <div className="mr-3">
                      {item.is_dir ? (
                        <Folder className={`w-5 h-5 ${isSelected ? 'text-blue-600 dark:text-indigo-400' : 'text-blue-400 dark:text-indigo-500/70'}`} fill={item.is_dir ? "currentColor" : "none"} fillOpacity={0.2} />
                      ) : (
                        <File className="w-5 h-5 text-slate-400 dark:text-slate-500" />
                      )}
                    </div>
                    <span className="flex-1 truncate text-sm">{item.name}</span>
                  </div>
                );
              })}
              {filteredItems.length === 0 && (
                <div className="text-center text-slate-500 py-10 text-sm">
                  No items found.
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-100 dark:border-slate-700 bg-white dark:bg-slate-800 shrink-0 flex items-center justify-between">
          <div className="flex-1 truncate mr-4 text-xs text-slate-500 dark:text-slate-400">
            {selectedItemPath ? (
               <span className="font-mono bg-slate-100 dark:bg-slate-900 px-2 py-1 rounded select-all">
                 {selectedItemPath}
               </span>
            ) : selectType === 'directory' && currentPath ? (
               <span className="font-mono bg-slate-100 dark:bg-slate-900 px-2 py-1 rounded select-all">
                 {currentPath}
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
