import React, { useState } from 'react';
import api from '../services/api';
import { X, FolderOpen, Loader2, AlertCircle, CheckCircle2, Search } from 'lucide-react';
import FileBrowserModal from './FileBrowserModal';

interface ImportProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

const ImportProjectModal: React.FC<ImportProjectModalProps> = ({ isOpen, onClose, onSuccess }) => {
  const [directoryPath, setDirectoryPath] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [isFileBrowserOpen, setIsFileBrowserOpen] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError('');
    
    try {
      await api.post('/api/projects/import', { directory_path: directoryPath });
      setSuccess(true);
      setTimeout(() => {
        onSuccess();
        handleClose();
      }, 1500);
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Failed to import project. Make sure the directory contains project.json.');
      console.error(err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    setDirectoryPath('');
    setError('');
    setSuccess(false);
    onClose();
  };

  const handleFileBrowserSelect = (path: string) => {
    setDirectoryPath(path);
    setIsFileBrowserOpen(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm transition-opacity">
      <div className="bg-white dark:bg-slate-800 rounded-xl shadow-xl border border-slate-200 dark:border-slate-700 w-full max-w-md overflow-hidden transform transition-all">
        <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between bg-slate-50 dark:bg-slate-800/50">
          <h3 className="text-lg font-semibold text-slate-900 dark:text-white flex items-center">
            <FolderOpen className="w-5 h-5 mr-2 text-blue-600 dark:text-indigo-400" />
            Import Project
          </h3>
          <button 
            onClick={handleClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 p-1 rounded-full hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Enter the absolute path to the project directory containing <code>project.json</code>.
          </p>

          <div className="space-y-2">
            <label htmlFor="directory" className="block text-sm font-medium text-slate-700 dark:text-slate-300">
              Directory Path
            </label>
              <div className="flex gap-2">
                <input
                  id="directory"
                  type="text"
                  required
                  value={directoryPath}
                  onChange={(e) => setDirectoryPath(e.target.value)}
                  placeholder="/path/to/project_folder"
                  className="block w-full px-4 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-indigo-500 focus:border-transparent transition-shadow text-sm"
                />
                <button
                  type="button"
                  onClick={() => setIsFileBrowserOpen(true)}
                  className="px-3 py-2 bg-slate-100 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg text-slate-600 dark:text-slate-400 hover:text-blue-600 dark:hover:text-indigo-400 transition-colors"
                  title="Browse files"
                >
                  <Search className="w-4 h-4" />
                </button>
              </div>
          </div>

          {error && (
            <div className="flex items-start p-3 bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-900/40 rounded-lg text-red-600 dark:text-red-400 text-sm">
              <AlertCircle className="w-4 h-4 mr-2 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {success && (
            <div className="flex items-start p-3 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-900/40 rounded-lg text-emerald-600 dark:text-emerald-400 text-sm">
              <CheckCircle2 className="w-4 h-4 mr-2 shrink-0 mt-0.5" />
              <span>Project imported successfully!</span>
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={handleClose}
              className="flex-1 px-4 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-700 text-sm font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || success}
              className="flex-1 px-4 py-2 bg-blue-600 dark:bg-indigo-600 hover:bg-blue-700 dark:hover:bg-indigo-700 text-white rounded-lg text-sm font-medium transition-colors shadow-sm focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 dark:focus:ring-offset-slate-900 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Importing...
                </>
              ) : 'Import Project'}
            </button>
          </div>
        </form>
      </div>

      <FileBrowserModal 
        isOpen={isFileBrowserOpen}
        onClose={() => setIsFileBrowserOpen(false)}
        onSelect={handleFileBrowserSelect}
        selectType="directory"
      />
    </div>
  );
};

export default ImportProjectModal;
