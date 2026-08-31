import React, { useState } from 'react';
import { X, FolderPlus, Folder, Search } from 'lucide-react';
import api from '../services/api';
import FileBrowserModal from './FileBrowserModal';

interface CreateProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

const CreateProjectModal: React.FC<CreateProjectModalProps> = ({ isOpen, onClose, onSuccess }) => {
  const [name, setName] = useState('');
  const [localPath, setLocalPath] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [isFileBrowserOpen, setIsFileBrowserOpen] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    try {
      await api.post('/api/projects', {
        name,
        local_directory_path: localPath
      });
      setName('');
      setLocalPath('');
      onSuccess();
    } catch (err: any) {
      if (err.response?.status === 400 && err.response?.data?.detail) {
        setError(err.response.data.detail);
      } else {
        setError('Failed to create project. Please try again.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 dark:bg-slate-900/80 backdrop-blur-sm transition-opacity duration-200">
      <div className="bg-white dark:bg-slate-800 rounded-xl shadow-2xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in duration-200 border border-transparent dark:border-slate-700">
        <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700 flex justify-between items-center bg-slate-50 dark:bg-slate-800/50">
          <div className="flex items-center space-x-2">
            <div className="bg-blue-100 dark:bg-indigo-900/40 p-2 rounded-lg">
              <FolderPlus className="w-5 h-5 text-blue-600 dark:text-indigo-400" />
            </div>
            <h3 className="text-lg font-semibold text-slate-900 dark:text-white">Create New Project</h3>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          {error && (
            <div className="bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400 p-3 rounded-lg text-sm border border-red-100 dark:border-red-500/50 flex items-start">
              <div className="flex-1">{error}</div>
            </div>
          )}

          <div>
            <label htmlFor="name" className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
              Project Name
            </label>
            <input
              type="text"
              id="name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 bg-white dark:bg-slate-900/50 border border-slate-300 dark:border-slate-600 text-slate-900 dark:text-white rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-indigo-500 focus:border-blue-500 dark:focus:border-indigo-500 transition-colors placeholder-slate-400 dark:placeholder-slate-500"
              placeholder="e.g., Protein Kinase A Dynamics"
            />
          </div>

          <div>
            <label htmlFor="path" className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
              Local Directory Path
            </label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Folder className="h-4 w-4 text-slate-400 dark:text-slate-500" />
                </div>
                <input
                  type="text"
                  id="path"
                  required
                  value={localPath}
                  onChange={(e) => setLocalPath(e.target.value)}
                  className="w-full pl-10 px-3 py-2 bg-white dark:bg-slate-900/50 border border-slate-300 dark:border-slate-600 text-slate-900 dark:text-white rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-indigo-500 focus:border-blue-500 dark:focus:border-indigo-500 transition-colors placeholder-slate-400 dark:placeholder-slate-500"
                  placeholder="/absolute/path/to/data"
                />
              </div>
              <button
                type="button"
                onClick={() => setIsFileBrowserOpen(true)}
                className="px-3 py-2 bg-slate-100 dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded-lg text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors flex items-center justify-center shrink-0"
              >
                <Search className="w-4 h-4" />
              </button>
            </div>
            <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
              Must be an existing absolute path on the host machine.
            </p>
          </div>

          <div className="pt-2 flex space-x-3 justify-end">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 dark:focus:ring-offset-slate-800 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isLoading || !name || !localPath}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 dark:bg-indigo-600 border border-transparent rounded-lg hover:bg-blue-700 dark:hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 dark:focus:ring-offset-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
            >
              {isLoading ? 'Creating...' : 'Create Project'}
            </button>
          </div>
        </form>
      </div>
      
      <FileBrowserModal
        isOpen={isFileBrowserOpen}
        onClose={() => setIsFileBrowserOpen(false)}
        selectType="directory"
        onSelect={(path) => {
          setLocalPath(path);
          setIsFileBrowserOpen(false);
        }}
      />
    </div>
  );
};

export default CreateProjectModal;
