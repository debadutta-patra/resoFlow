import React from 'react';
import { Sun, Moon } from 'lucide-react';
import { useTheme } from '../context/ThemeContext';

export const ThemeToggle: React.FC = () => {
  const { theme, toggleTheme } = useTheme();

  return (
    <button
      onClick={toggleTheme}
      className="p-2 mr-2 rounded-lg text-slate-500 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 dark:text-slate-400 dark:hover:text-slate-50 dark:bg-slate-800 dark:hover:bg-slate-700 transition-colors duration-200"
      aria-label="Toggle Dark Mode"
      title={`Switch to ${theme === 'light' ? 'Dark' : 'Light'} Mode`}
    >
      {theme === 'light' ? (
        <Moon className="w-5 h-5" />
      ) : (
        <Sun className="w-5 h-5" />
      )}
    </button>
  );
};
