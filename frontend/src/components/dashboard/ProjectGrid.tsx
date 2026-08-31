import React, { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { 
  Folder, 
  FolderOpen, 
  Plus, 
  FolderPlus, 
  Search, 
  ArrowUpDown, 
  Archive, 
  ArchiveRestore, 
  Trash2, 
  CheckCircle2, 
  Loader2, 
  XCircle, 
  Clock, 
  Layers, 
  Sparkles
} from 'lucide-react';
import api from '../../services/api';

export interface EnrichedProject {
  id: number;
  project_uuid: string;
  name: string;
  local_directory_path: string;
  protein_sequence?: string | null;
  molecular_weight?: string | null;
  experiments?: string | null;
  is_archived: boolean;
  created_at: string;
  last_run_at?: string | null;
  spectra_count: number;
  analysis_count: number;
  status_counts: {
    completed: number;
    running: number;
    failed: number;
    pending: number;
  };
}

interface ProjectGridProps {
  projects: EnrichedProject[];
  onNewProject: () => void;
  onImportProject: () => void;
  onDeleteProject: (project: EnrichedProject) => void;
  onRefresh: () => void;
}

export const ProjectGrid: React.FC<ProjectGridProps> = ({
  projects,
  onNewProject,
  onImportProject,
  onDeleteProject,
  onRefresh,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'activity' | 'name' | 'created'>('activity');
  const [showArchived, setShowArchived] = useState(false);
  const [isUpdatingArchive, setIsUpdatingArchive] = useState<string | null>(null);

  const elidePath = (path: string, maxLength: number = 42): string => {
    if (!path || path.length <= maxLength) return path;
    const parts = path.split('/').filter(Boolean);
    if (parts.length <= 2) return path;
    const prefix = '/' + parts[0];
    const suffix = parts.slice(-2).join('/');
    return `${prefix}/.../${suffix}`;
  };

  const formatDate = (dateString?: string | null) => {
    if (!dateString) return 'No activity';
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      return 'Today ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
    });
  };

  const toggleArchive = async (project: EnrichedProject, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsUpdatingArchive(project.project_uuid);
    try {
      await api.put(`/api/projects/${project.project_uuid}`, {
        is_archived: !project.is_archived,
      });
      onRefresh();
    } catch (err) {
      console.error('Failed to update archive status:', err);
    } finally {
      setIsUpdatingArchive(null);
    }
  };

  const archivedCount = useMemo(() => projects.filter((p) => p.is_archived).length, [projects]);

  const filteredAndSortedProjects = useMemo(() => {
    return projects
      .filter((p) => {
        if (!showArchived && p.is_archived) return false;
        if (showArchived && !p.is_archived) return false;
        if (!searchQuery.trim()) return true;
        const q = searchQuery.toLowerCase();
        return (
          p.name.toLowerCase().includes(q) ||
          p.local_directory_path.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        if (sortBy === 'name') {
          return a.name.localeCompare(b.name);
        }
        if (sortBy === 'created') {
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        }
        // 'activity' sort by last_run_at or created_at
        const aTime = new Date(a.last_run_at || a.created_at).getTime();
        const bTime = new Date(b.last_run_at || b.created_at).getTime();
        return bTime - aTime;
      });
  }, [projects, searchQuery, sortBy, showArchived]);

  // First run empty state when user has 0 projects total
  if (projects.length === 0) {
    return (
      <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 p-8 transition-colors">
        <div className="max-w-2xl mx-auto text-center space-y-6">
          <div className="w-16 h-16 rounded-2xl bg-blue-50 dark:bg-indigo-950/60 border border-blue-100 dark:border-indigo-900/60 flex items-center justify-center mx-auto text-blue-600 dark:text-indigo-400 shadow-sm">
            <Sparkles className="w-8 h-8" />
          </div>

          <div>
            <h3 className="text-xl font-bold text-slate-900 dark:text-white">Welcome to resoFlow</h3>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-2 max-w-lg mx-auto">
              resoFlow organizes your NMR relaxation analysis into workspace projects. Each project encapsulates your raw spectra (NMRPipe .ft2 or Bruker), peak lists, and fitting models (ChemEx CEST, CPMG, R1/R2).
            </p>
          </div>

          {/* New vs Import Explainer Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-left pt-2">
            <div className="p-5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-900/50 hover:border-blue-300 dark:hover:border-indigo-500 transition">
              <div className="flex items-center space-x-2.5 mb-2">
                <div className="p-2 rounded-lg bg-blue-100 dark:bg-indigo-900/50 text-blue-700 dark:text-indigo-300">
                  <Plus className="w-4 h-4" />
                </div>
                <h4 className="font-semibold text-slate-900 dark:text-white text-sm">New Project</h4>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed mb-4">
                Creates a clean directory on the host machine. You can then upload or attach raw NMR spectra files (.ft2 or Bruker) and pick peaks interactively.
              </p>
              <button
                onClick={onNewProject}
                className="w-full inline-flex items-center justify-center px-3.5 py-2 bg-blue-600 hover:bg-blue-700 dark:bg-indigo-600 dark:hover:bg-indigo-700 text-white text-xs font-semibold rounded-lg shadow-sm transition"
              >
                <Plus className="w-3.5 h-3.5 mr-1.5" />
                Create New Project
              </button>
            </div>

            <div className="p-5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-900/50 hover:border-blue-300 dark:hover:border-indigo-500 transition">
              <div className="flex items-center space-x-2.5 mb-2">
                <div className="p-2 rounded-lg bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300">
                  <FolderPlus className="w-4 h-4" />
                </div>
                <h4 className="font-semibold text-slate-900 dark:text-white text-sm">Import Project</h4>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed mb-4">
                Imports an existing workspace directory containing a <code className="bg-slate-200 dark:bg-slate-800 px-1 py-0.5 rounded text-[11px]">project.json</code> manifest or prepared NMR spectra folder on disk.
              </p>
              <button
                onClick={onImportProject}
                className="w-full inline-flex items-center justify-center px-3.5 py-2 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-semibold rounded-lg shadow-sm transition"
              >
                <FolderPlus className="w-3.5 h-3.5 mr-1.5" />
                Import from Host Directory
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-slate-200 dark:border-slate-700 p-6 transition-colors space-y-6">
      {/* Controls Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center space-x-2">
          <Folder className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
          <h3 className="font-semibold text-slate-900 dark:text-white">
            {showArchived ? 'Archived Projects' : 'Projects'}
          </h3>
          <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 font-medium">
            {filteredAndSortedProjects.length}
          </span>
        </div>

        {/* Search, Sort, and Archive Toggle */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Search Input */}
          <div className="relative min-w-[200px] flex-1 sm:flex-none">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search projects..."
              className="w-full pl-9 pr-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
            />
          </div>

          {/* Sort Selector */}
          <div className="flex items-center space-x-1.5 text-xs text-slate-500 dark:text-slate-400">
            <ArrowUpDown className="w-3.5 h-3.5" />
            <select
              value={sortBy}
              onChange={(e: any) => setSortBy(e.target.value)}
              aria-label="Sort projects by"
              className="bg-slate-50 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            >
              <option value="activity">Last Activity</option>
              <option value="name">Name (A-Z)</option>
              <option value="created">Creation Date</option>
            </select>
          </div>

          {/* Archived Filter Toggle */}
          {archivedCount > 0 && (
            <button
              onClick={() => setShowArchived((prev) => !prev)}
              className={`inline-flex items-center px-2.5 py-1.5 rounded-lg text-xs font-medium border transition ${
                showArchived
                  ? 'bg-amber-50 dark:bg-amber-950/60 border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300'
                  : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-100'
              }`}
            >
              {showArchived ? <ArchiveRestore className="w-3.5 h-3.5 mr-1" /> : <Archive className="w-3.5 h-3.5 mr-1" />}
              {showArchived ? 'Viewing Archived' : `Archived (${archivedCount})`}
            </button>
          )}
        </div>
      </div>

      {/* Projects Grid (Responsive for 30+ projects) */}
      {filteredAndSortedProjects.length === 0 ? (
        <div className="text-center py-12 border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-xl bg-slate-50/50 dark:bg-slate-900/20">
          <FolderOpen className="w-10 h-10 text-slate-300 dark:text-slate-600 mx-auto mb-2" />
          <h4 className="text-sm font-medium text-slate-800 dark:text-slate-200">No matching projects found</h4>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {searchQuery ? `No projects match "${searchQuery}".` : showArchived ? 'No archived projects.' : 'No active projects.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredAndSortedProjects.map((project) => {
            const hasRunning = project.status_counts.running > 0;
            const hasFailed = project.status_counts.failed > 0;
            const isArchivedUpdating = isUpdatingArchive === project.project_uuid;

            return (
              <div
                key={project.project_uuid}
                className="group relative rounded-xl border border-slate-200 dark:border-slate-700/80 bg-white dark:bg-slate-900/60 hover:border-blue-400 dark:hover:border-indigo-500 hover:shadow-md transition-all flex flex-col justify-between overflow-hidden"
              >
                <Link
                  to={`/projects/${project.project_uuid}`}
                  className="p-5 block flex-1 space-y-3.5 cursor-pointer"
                >
                  {/* Top Line: Name & Last Run */}
                  <div className="flex items-start justify-between gap-2 pr-14">
                    <h4 className="font-semibold text-sm text-slate-900 dark:text-white group-hover:text-blue-600 dark:group-hover:text-indigo-400 transition-colors line-clamp-1">
                      {project.name}
                    </h4>
                  </div>

                  {/* Status Chips Row */}
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {hasRunning && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
                        <Loader2 className="w-2.5 h-2.5 mr-1 animate-spin text-blue-600" />
                        {project.status_counts.running} Running
                      </span>
                    )}
                    {hasFailed && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-red-50 dark:bg-red-950/60 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800">
                        <XCircle className="w-2.5 h-2.5 mr-1 text-red-600" />
                        {project.status_counts.failed} Failed
                      </span>
                    )}
                    {project.status_counts.completed > 0 && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
                        <CheckCircle2 className="w-2.5 h-2.5 mr-1 text-emerald-600" />
                        {project.status_counts.completed} Complete
                      </span>
                    )}
                    {project.analysis_count === 0 && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400">
                        New
                      </span>
                    )}
                  </div>

                  {/* Metrics Bar */}
                  <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 pt-1 border-t border-slate-100 dark:border-slate-800">
                    <span className="flex items-center">
                      <Layers className="w-3.5 h-3.5 mr-1 text-slate-400" />
                      {project.spectra_count} Spectra &bull; {project.analysis_count} Analyses
                    </span>
                    <span className="flex items-center text-[11px] text-slate-400" title="Last run / activity time">
                      <Clock className="w-3 h-3 mr-1" />
                      {formatDate(project.last_run_at || project.created_at)}
                    </span>
                  </div>
                </Link>

                {/* Footer: Elided Path */}
                <div className="px-5 py-2.5 bg-slate-50 dark:bg-slate-850 border-t border-slate-100 dark:border-slate-800/80 flex items-center justify-between text-[11px] text-slate-400 dark:text-slate-500 font-mono">
                  <span className="truncate" title={project.local_directory_path}>
                    {elidePath(project.local_directory_path)}
                  </span>
                </div>

                {/* Card Action Overlay Buttons */}
                <div className="absolute top-4 right-3 flex items-center space-x-1 opacity-0 group-hover:opacity-100 transition-opacity z-10 bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm p-1 rounded-lg shadow-sm border border-slate-200 dark:border-slate-700">
                  <button
                    onClick={(e) => toggleArchive(project, e)}
                    disabled={isArchivedUpdating}
                    className="p-1 text-slate-500 hover:text-amber-600 dark:hover:text-amber-400 rounded transition"
                    title={project.is_archived ? 'Unarchive Project' : 'Archive Project'}
                  >
                    {project.is_archived ? <ArchiveRestore className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onDeleteProject(project);
                    }}
                    className="p-1 text-slate-500 hover:text-red-600 dark:hover:text-red-400 rounded transition"
                    title="Delete Project"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default ProjectGrid;
