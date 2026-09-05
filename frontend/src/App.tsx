import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { RunsProvider } from './context/RunsContext';
import Login from './pages/Login';

import Register from './pages/Register';
import Dashboard from './pages/Dashboard';
import { AdminRoute } from './components/AdminRoute';
import AdminDashboard from './pages/AdminDashboard';
import ProjectDetails from './pages/ProjectDetails';
import SpectraAnalysis from './pages/SpectraAnalysis';
import AnalysisDetails from './pages/AnalysisDetails';
import AnalysisReport from './pages/AnalysisReport';
import Layout from './components/Layout';

const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const { isAuthenticated, isLoading } = useAuth();
  
  if (isLoading) {
    return <div className="min-h-screen flex items-center justify-center">Loading...</div>;
  }
  
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
};

const PublicRoute = ({ children }: { children: React.ReactNode }) => {
  const { isAuthenticated, isLoading } = useAuth();
  
  if (isLoading) {
    return <div className="min-h-screen flex items-center justify-center">Loading...</div>;
  }
  
  if (isAuthenticated) {
    return <Navigate to="/dashboard" replace />;
  }

  return <>{children}</>;
};

const AppRoutes = () => {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="/login" element={
        <PublicRoute>
          <Login />
        </PublicRoute>
      } />
      <Route path="/register" element={
        <PublicRoute>
          <Register />
        </PublicRoute>
      } />
      <Route path="/dashboard" element={
        <ProtectedRoute>
          <Layout>
            <Dashboard />
          </Layout>
        </ProtectedRoute>
      } />
      <Route path="/projects/:projectUuid" element={
        <ProtectedRoute>
          <Layout>
            <ProjectDetails />
          </Layout>
        </ProtectedRoute>
      } />
      <Route path="/projects/:projectUuid/spectra/:spectrumUuid" element={
        <ProtectedRoute>
          <Layout>
            <SpectraAnalysis />
          </Layout>
        </ProtectedRoute>
      } />
      <Route path="/projects/:projectUuid/analysis/:analysisUuid" element={
        <ProtectedRoute>
          <Layout>
            <AnalysisDetails />
          </Layout>
        </ProtectedRoute>
      } />
      <Route path="/projects/:projectUuid/analysis/:analysisUuid/report" element={
        <ProtectedRoute>
          <AnalysisReport />
        </ProtectedRoute>
      } />
      <Route path="/admin" element={
        <AdminRoute>
          <Layout>
            <AdminDashboard />
          </Layout>
        </AdminRoute>
      } />
    </Routes>
  );
};

function App() {

  return (
    <AuthProvider>
      <RunsProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </RunsProvider>
    </AuthProvider>
  );
}


export default App;
