import React, { useState, useEffect, useRef } from 'react';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import api from '../services/api';
import { useTheme } from '../context/ThemeContext';
import nmrSpectraDark from '../assets/nmr_spectra_dark.jpg';
import nmrSpectraLight from '../assets/nmr_spectra_light.jpg';
import { ChevronDown, Activity, Folder } from 'lucide-react';

const ProjectNavbar: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { theme } = useTheme();
  const isDarkTheme = theme === 'dark';
  const nmrSpectraIcon = isDarkTheme ? nmrSpectraDark : nmrSpectraLight;
  
  const [project, setProject] = useState<any>(null);
  
  // Extract projectUuid from URL, e.g. /projects/123-456/...
  const match = location.pathname.match(/\/projects\/([a-zA-Z0-9-]+)/);
  const projectUuid = match ? match[1] : null;

  const [activeDropdown, setActiveDropdown] = useState<'spectra' | 'analyses' | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (projectUuid) {
      api.get(`/api/projects/${projectUuid}`)
        .then(res => setProject(res.data))
        .catch(err => console.error('Failed to load project context for navbar', err));
    } else {
      setProject(null);
    }
  }, [projectUuid, location.pathname]); // Re-fetch occasionally or relying on cache
  
  // Fallback to fetch when new spectra/analysis are possibly added, but fetching on pathname change is ok.

  // Close dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setActiveDropdown(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  if (!projectUuid || !project) return null;

  return (
    <div className="bg-slate-100 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 shadow-sm sticky top-16 z-40 transition-colors duration-200">
      <div className="mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center h-12" ref={dropdownRef}>
          <div className="flex items-center space-x-1 sm:space-x-4">
            <Link 
              to={`/projects/${projectUuid}`}
              className={`flex items-center px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  location.pathname === `/projects/${projectUuid}` 
                  ? 'bg-blue-100 dark:bg-indigo-900/50 text-blue-700 dark:text-indigo-300' 
                  : 'text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
              }`}
            >
              <Folder className="w-4 h-4 mr-2" />
              <span className="max-w-[150px] sm:max-w-[300px] truncate">{project.name}</span>
            </Link>

            <span className="text-slate-300 dark:text-slate-600">|</span>

            {/* Spectra Dropdown */}
            <div className="relative">
              <button 
                onClick={() => setActiveDropdown(activeDropdown === 'spectra' ? null : 'spectra')}
                className={`flex items-center px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  location.pathname.includes('/spectra/') || activeDropdown === 'spectra'
                  ? 'bg-blue-100 dark:bg-indigo-900/50 text-blue-700 dark:text-indigo-300' 
                  : 'text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                }`}
              >
                <img src={nmrSpectraIcon} className="w-6 h-6 rounded-lg mr-2 shadow-sm border border-slate-200 dark:border-slate-700" alt="" />
                Spectra
                <ChevronDown className={`w-3 h-3 ml-1 transform transition-transform ${activeDropdown === 'spectra' ? 'rotate-180' : ''}`} />
              </button>
              {activeDropdown === 'spectra' && (
                <div className="absolute left-0 mt-1 w-64 bg-white dark:bg-slate-800 rounded-lg shadow-lg border border-slate-200 dark:border-slate-700 py-1 z-50">
                  {project.spectra && project.spectra.length > 0 ? (
                    project.spectra.map((s: any) => (
                      <button
                        key={s.spectrum_uuid}
                        onClick={() => {
                          navigate(`/projects/${projectUuid}/spectra/${s.spectrum_uuid}`);
                          setActiveDropdown(null);
                        }}
                        className={`w-full text-left px-4 py-2 text-sm truncate flex items-center justify-between group ${
                            location.pathname.includes(s.spectrum_uuid) 
                            ? 'bg-blue-50 dark:bg-indigo-900/30 text-blue-700 dark:text-indigo-300 font-bold' 
                            : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'
                        }`}
                      >
                        <span className="truncate pr-2">{s.name}</span>
                        {s.is_fitted && <span className="text-[9px] bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 px-1 rounded uppercase font-bold shrink-0">Fitted</span>}
                      </button>
                    ))
                  ) : (
                    <div className="px-4 py-3 text-sm text-slate-500 italic flex justify-center">No spectra available</div>
                  )}
                </div>
              )}
            </div>

            {/* Analyses Dropdown */}
            <div className="relative">
              <button 
                onClick={() => setActiveDropdown(activeDropdown === 'analyses' ? null : 'analyses')}
                className={`flex items-center px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  location.pathname.includes('/analysis/') || activeDropdown === 'analyses'
                  ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400' 
                  : 'text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                }`}
              >
                <Activity className="w-4 h-4 mr-2" />
                Analyses
                <ChevronDown className={`w-3 h-3 ml-1 transform transition-transform ${activeDropdown === 'analyses' ? 'rotate-180' : ''}`} />
              </button>
              {activeDropdown === 'analyses' && (
                <div className="absolute left-0 mt-1 w-64 bg-white dark:bg-slate-800 rounded-lg shadow-lg border border-slate-200 dark:border-slate-700 py-1 z-50">
                  {project.analyses && project.analyses.length > 0 ? (
                    project.analyses.map((a: any) => (
                      <button
                        key={a.analysis_uuid}
                        onClick={() => {
                          navigate(`/projects/${projectUuid}/analysis/${a.analysis_uuid}`);
                          setActiveDropdown(null);
                        }}
                        className={`w-full text-left px-4 py-2 text-sm truncate flex justify-between items-center ${
                            location.pathname.includes(a.analysis_uuid) 
                            ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 font-bold' 
                            : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'
                        }`}
                      >
                        <span className="truncate pr-2">{a.name}</span>
                         <span className={`text-[9px] font-bold px-1 rounded uppercase shrink-0 ${
                            a.status === 'COMPLETED' ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600' :
                            a.status === 'FAILED' ? 'bg-red-100 dark:bg-red-900/40 text-red-600' :
                            'bg-blue-100 dark:bg-blue-900/40 text-blue-600'
                        }`}>
                            {a.status}
                        </span>
                      </button>
                    ))
                  ) : (
                    <div className="px-4 py-3 text-sm text-slate-500 italic flex justify-center">No analyses available</div>
                  )}
                </div>
              )}
            </div>
            
          </div>
        </div>
      </div>
    </div>
  );
};

export default ProjectNavbar;
