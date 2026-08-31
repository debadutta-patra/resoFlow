import React, { useRef, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useUserRuns } from '../context/RunsContext';
import { ThemeToggle } from './ThemeToggle';
import { RunsPanel } from './dashboard/RunsPanel';
import { 
  Atom, 
  LogOut, 
  LayoutDashboard, 
  ShieldCheck,
  Activity,
  Zap,
  Clock
} from 'lucide-react';

const Navbar: React.FC = () => {
  const { user, logout } = useAuth();
  const { activeCount, queuedCount, isPanelOpen, setIsPanelOpen, togglePanel } = useUserRuns();
  const navigate = useNavigate();
  const location = useLocation();
  const flyoutRef = useRef<HTMLDivElement>(null);

  const isActive = (path: string) => location.pathname === path;

  // Close flyout on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (flyoutRef.current && !flyoutRef.current.contains(event.target as Node)) {
        setIsPanelOpen(false);
      }
    };
    if (isPanelOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isPanelOpen, setIsPanelOpen]);

  return (
    <nav className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 sticky top-0 z-50 transition-colors duration-200 shadow-sm">
      <div className="mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          {/* Logo */}
          <div 
            className="flex items-center space-x-3 cursor-pointer group" 
            onClick={() => navigate('/dashboard')}
          >
            <div className="bg-blue-600 dark:bg-indigo-600 p-2 rounded-lg group-hover:scale-105 transition-transform">
              <Atom className="text-white w-5 h-5" />
            </div>
            <span className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-700 to-indigo-600 dark:from-blue-400 dark:to-indigo-400">
              resoFlow
            </span>
          </div>
          
          {/* Navigation Links */}
          <div className="hidden md:flex items-center space-x-1 ml-10">
            <Link 
              to="/dashboard"
              className={`flex items-center px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                isActive('/dashboard')
                  ? 'bg-blue-50 text-blue-700 dark:bg-indigo-900/40 dark:text-indigo-300'
                  : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <LayoutDashboard className="w-4 h-4 mr-2" />
              Dashboard
            </Link>
            
            {user?.is_superuser && (
              <Link 
                to="/admin"
                className={`flex items-center px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                  isActive('/admin')
                    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                    : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                <ShieldCheck className="w-4 h-4 mr-2" />
                Admin
              </Link>
            )}
          </div>

          <div className="flex items-center space-x-3 sm:space-x-5">
            {/* Header Run Indicator */}
            <div className="relative" ref={flyoutRef}>
              <button
                onClick={togglePanel}
                className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all border shadow-sm ${
                  activeCount > 0
                    ? 'bg-blue-50 dark:bg-blue-950/60 border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300 ring-2 ring-blue-500/20'
                    : queuedCount > 0
                    ? 'bg-amber-50 dark:bg-amber-950/60 border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300'
                    : 'bg-slate-50 dark:bg-slate-800/80 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'
                }`}
                title="View active and recent runs"
              >
                {activeCount > 0 ? (
                  <>
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-600"></span>
                    </span>
                    <Zap className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                    <span>{activeCount} Running</span>
                  </>
                ) : queuedCount > 0 ? (
                  <>
                    <Clock className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                    <span>{queuedCount} Queued</span>
                  </>
                ) : (
                  <>
                    <Activity className="w-3.5 h-3.5 text-slate-400" />
                    <span>Runs</span>
                  </>
                )}
              </button>

              {/* Flyout Popover */}
              {isPanelOpen && (
                <div className="absolute right-0 mt-2 w-[420px] sm:w-[480px] max-w-[90vw] z-50 shadow-2xl rounded-xl">
                  <RunsPanel isFlyout={true} onClose={() => setIsPanelOpen(false)} />
                </div>
              )}
            </div>

            <ThemeToggle />
            
            <div className="flex flex-col text-right hidden sm:flex">
              <span className="text-sm font-semibold text-slate-900 dark:text-white truncate max-w-[120px]">
                {user?.full_name || 'User'}
              </span>
              <span className="text-[10px] text-slate-500 uppercase tracking-wider font-bold">
                {user?.is_superuser ? 'Administrator' : 'Researcher'}
              </span>
            </div>
            
            <button
              onClick={logout}
              title="Sign Out"
              className="text-slate-500 hover:text-red-500 dark:hover:text-red-400 p-2 rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 transition-all"
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </div>
      </div>
    </nav>
  );
};

export default Navbar;

