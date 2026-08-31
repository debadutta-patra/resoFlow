import React from 'react';
import { AlertTriangle, X } from 'lucide-react';

interface DeleteConfirmationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (deleteFiles?: boolean) => void;
  title: string;
  message: string;
  itemName?: string;
  showDeleteFilesOption?: boolean;
}

const DeleteConfirmationModal: React.FC<DeleteConfirmationModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  itemName,
  showDeleteFilesOption = false
}) => {
  const [deleteFiles, setDeleteFiles] = React.useState(true);
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div 
        className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 w-full max-w-md overflow-hidden animate-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700 flex justify-between items-center bg-slate-50 dark:bg-slate-800/50">
          <h3 className="text-lg font-bold text-slate-900 dark:text-white flex items-center">
            <AlertTriangle className="w-5 h-5 text-red-500 mr-2" />
            {title}
          </h3>
          <button 
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 p-1 rounded-full transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        
        <div className="p-8 text-center">
          <div className="w-16 h-16 bg-red-50 dark:bg-red-900/20 rounded-full flex items-center justify-center mx-auto mb-4">
            <AlertTriangle className="w-8 h-8 text-red-600 dark:text-red-500" />
          </div>
          <p className="text-slate-600 dark:text-slate-400 mb-6">
            {message}
            {itemName && (
              <span className="block mt-2 font-semibold text-slate-900 dark:text-white italic">
                "{itemName}"
              </span>
            )}
          </p>

          {showDeleteFilesOption && (
            <div className="mb-6 p-3 bg-slate-50 dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700">
              <label className="flex items-center justify-center gap-3 cursor-pointer">
                <div className="relative flex items-center">
                  <input
                    type="checkbox"
                    checked={deleteFiles}
                    onChange={(e) => setDeleteFiles(e.target.checked)}
                    className="w-5 h-5 rounded border-slate-300 dark:border-slate-600 text-red-600 focus:ring-red-500 cursor-pointer"
                  />
                </div>
                <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
                  Delete associated project files from disk
                </span>
              </label>
              <p className="text-[10px] text-slate-500 mt-2">
                This will remove the project folder and all metadata files.
              </p>
            </div>
          )}
          
          <div className="flex gap-3 justify-center">
            <button
              onClick={onClose}
              className="px-6 py-2.5 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded-xl text-sm font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition"
            >
              Cancel
            </button>
            <button
              onClick={() => onConfirm(deleteFiles)}
              className="px-6 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-xl text-sm font-semibold shadow-lg shadow-red-600/20 transition-all hover:-translate-y-0.5"
            >
              Delete Permanently
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default DeleteConfirmationModal;
