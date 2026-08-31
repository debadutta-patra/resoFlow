import React from 'react';
import Navbar from './Navbar';
import ProjectNavbar from './ProjectNavbar';

interface LayoutProps {
  children: React.ReactNode;
}

const Layout: React.FC<LayoutProps> = ({ children }) => {
  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 transition-colors duration-200">
      <Navbar />
      <ProjectNavbar />
      <main className="transition-all duration-300">
        {children}
      </main>
    </div>
  );
};

export default Layout;
