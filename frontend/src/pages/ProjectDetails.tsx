import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../services/api';
import { useTheme } from '../context/ThemeContext';
import nmrSpectraDark from '../assets/nmr_spectra_dark.jpg';
import nmrSpectraLight from '../assets/nmr_spectra_light.jpg';
import { 
  ArrowLeft, 
  Save, 
  Activity, 
  Info,
  Folder,
  X,
  Plus,
  Settings,
  Clock,
  CheckCircle,
  AlertCircle,
  Trash2
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { Link } from 'react-router-dom';
import FileBrowserModal from '../components/FileBrowserModal';
import DeleteConfirmationModal from '../components/DeleteConfirmationModal';


interface Spectrum {
  id: number;
  spectrum_uuid: string;
  project_id: number;
  name: string;
  file_path: string;
  experiment_type?: string;
  is_fitted?: boolean;
  b0?: number;
  has_backup?: boolean;
  peaklist_path?: string;
  peaktable_json_path?: string;
}

interface Analysis {
  id: number;
  analysis_uuid: string;
  name: string;
  analysis_type: string;
  status: string;
  parameters?: string;
  spectra: Spectrum[];
  use_height: boolean;
  has_backup: boolean;
  created_at: string;
  completed_at?: string;
}

interface Project {
  id: number;
  project_uuid: string;
  name: string;
  local_directory_path: string;
  protein_sequence: string | null;
  molecular_weight: string | null;
  experiments: string | null;
  created_at: string;
  user_id: number;
  spectra: Spectrum[];
  analyses: Analysis[];
}

const ProjectDetails: React.FC = () => {
  const { projectUuid } = useParams<{ projectUuid: string }>();
  const navigate = useNavigate();
  useAuth();
  const { theme } = useTheme();
  const isDarkTheme = theme === 'dark';
  const nmrSpectraIcon = isDarkTheme ? nmrSpectraDark : nmrSpectraLight;

  const [project, setProject] = useState<Project | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [isFileBrowserOpen, setIsFileBrowserOpen] = useState(false);
  const [deleteModal, setDeleteModal] = useState({ isOpen: false, spectrum: null as Spectrum | null });
  
  const [activeTab, setActiveTab] = useState<'general' | 'spectra' | 'analysis'>('general');
  const [isNewAnalysisModalOpen, setIsNewAnalysisModalOpen] = useState(false);
  const [newAnalysisData, setNewAnalysisData] = useState({ name: '', type: 'R1' });
  
  // Form State
  const [formData, setFormData] = useState({
    name: '',
    protein_sequence: '',
    molecular_weight: '',
    experiments: ''
  });

  useEffect(() => {
    fetchProjectDetails();
  }, [projectUuid]);

  const fetchProjectDetails = async () => {
    try {
      setIsLoading(true);
      const response = await api.get(`/api/projects/${projectUuid}`);
      setProject(response.data);
      setFormData({
        name: response.data.name || '',
        protein_sequence: response.data.protein_sequence || '',
        molecular_weight: response.data.molecular_weight || '',
        experiments: response.data.experiments || ''
      });
    } catch (err) {
      setError('Failed to load project details.');
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: value
    }));
  };

  const handleAddSpectrum = async (path: string) => {
    setIsFileBrowserOpen(false);
    try {
      setIsLoading(true);
      const name = path.split('/').pop() || path;
      await api.post(`/api/projects/${projectUuid}/spectra`, {
        name,
        file_path: path
      });
      setSuccessMsg(`Added spectrum ${name}`);
      setTimeout(() => setSuccessMsg(''), 3000);
      fetchProjectDetails();
    } catch (err) {
      setError('Failed to add spectrum');
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRemoveSpectrum = async () => {
    if (!deleteModal.spectrum) return;
    try {
      setIsLoading(true);
      await api.delete(`/api/projects/${projectUuid}/spectra/${deleteModal.spectrum.spectrum_uuid}`);
      setDeleteModal({ isOpen: false, spectrum: null });
      setSuccessMsg('Spectrum removed');
      setTimeout(() => setSuccessMsg(''), 3000);
      fetchProjectDetails();
    } catch (err) {
      setError('Failed to remove spectrum');
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSave = async () => {
    try {
      setIsSaving(true);
      setSuccessMsg('');
      setError('');
      
      const payload = { ...formData };
      
      const response = await api.put(`/api/projects/${projectUuid}`, payload);
      setProject(response.data);
      setSuccessMsg('Project updated successfully!');
      setTimeout(() => setSuccessMsg(''), 3000);
    } catch (err) {
      setError('Failed to save project updates.');
      console.error(err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleCreateAnalysis = async () => {
    try {
      setIsLoading(true);
      await api.post(`/api/projects/${projectUuid}/analysis`, {
        name: newAnalysisData.name,
        analysis_type: newAnalysisData.type
      });
      setIsNewAnalysisModalOpen(false);
      setNewAnalysisData({ name: '', type: 'R1' });
      setSuccessMsg('Analysis created successfully');
      setTimeout(() => setSuccessMsg(''), 3000);
      fetchProjectDetails();
    } catch (err) {
      setError('Failed to create analysis');
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'PENDING': return <Clock className="w-4 h-4 text-slate-400" />;
      case 'RUNNING': return <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600 mr-2"></div>;
      case 'COMPLETED': return <CheckCircle className="w-4 h-4 text-emerald-500" />;
      case 'FAILED': return <AlertCircle className="w-4 h-4 text-red-500" />;
      default: return null;
    }
  };

  const handleDeleteAnalysis = async (analysisUuid: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm('Are you sure you want to delete this analysis? This action cannot be undone.')) {
      return;
    }
    try {
      await api.delete(`/api/projects/${projectUuid}/analysis/${analysisUuid}`);
      setProject(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          analyses: prev.analyses.filter(a => a.analysis_uuid !== analysisUuid)
        };
      });
      setSuccessMsg('Analysis deleted successfully');
      setTimeout(() => setSuccessMsg(''), 3000);
    } catch (err) {
      setError('Failed to delete analysis. Please try again.');
      console.error('Failed to delete analysis:', err);
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-900 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 dark:border-indigo-500"></div>
      </div>
    );
  }



  return (
    <div className="mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        
        {/* Header content */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center space-x-4">
                <button 
                  onClick={() => navigate('/dashboard')}
                  className="p-2 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors"
                >
                  <ArrowLeft className="w-5 h-5" />
                </button>
                <div>
                  <h1 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center">
                    {project?.name}
                  </h1>
                  <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">
                    {project?.local_directory_path}
                  </p>
                </div>
            </div>
            
            <button
                onClick={handleSave}
                disabled={isSaving}
                className={`inline-flex items-center justify-center px-4 py-2 bg-blue-600 dark:bg-indigo-600 hover:bg-blue-700 dark:hover:bg-indigo-700 text-white text-sm font-medium rounded-lg shadow-sm transition-all focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 dark:focus:ring-offset-slate-900 ${isSaving ? 'opacity-75 cursor-not-allowed' : ''}`}
            >
                {isSaving ? (
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                ) : (
                  <Save className="w-4 h-4 mr-2" />
                )}
                Save Changes
            </button>
        </div>

        {/* Alerts */}
        {error && (
            <div className="p-4 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-xl flex items-center text-red-700 dark:text-red-400 text-sm animate-in fade-in">
                <div className="w-2 h-2 bg-red-500 rounded-full mr-3"></div>
                {error}
            </div>
        )}
        
        {successMsg && (
            <div className="p-4 bg-emerald-50 dark:bg-emerald-900/30 border border-emerald-200 dark:border-emerald-800 rounded-xl flex items-center text-emerald-700 dark:text-emerald-400 text-sm animate-in fade-in">
                <div className="w-2 h-2 bg-emerald-500 rounded-full mr-3"></div>
                {successMsg}
            </div>
        )}

        {/* Main Card with Tabs */}
        <div className="bg-white dark:bg-slate-800 shadow-sm border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden transition-colors duration-200">
            {/* Tabs Header */}
            <div className="flex border-b border-slate-200 dark:border-slate-700 overflow-x-auto custom-scrollbar">
                <button 
                  onClick={() => setActiveTab('general')}
                  className={`flex items-center px-6 py-4 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${activeTab === 'general' ? 'border-blue-500 dark:border-indigo-500 text-blue-600 dark:text-indigo-400 bg-blue-50/50 dark:bg-indigo-900/20' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}
                >
                    <Info className="w-4 h-4 mr-2" />
                    General Information
                </button>
                <button 
                  onClick={() => setActiveTab('spectra')}
                  className={`flex items-center px-6 py-4 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${activeTab === 'spectra' ? 'border-blue-500 dark:border-indigo-500 text-blue-600 dark:text-indigo-400 bg-blue-50/50 dark:bg-indigo-900/20' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}
                >
                    <img src={nmrSpectraIcon} className="w-7 h-7 min-w-[28px] aspect-square object-cover rounded-lg shadow-sm border border-slate-200 dark:border-slate-700 mr-2" alt="" />
                    Spectra
                </button>
                <button 
                  onClick={() => setActiveTab('analysis')}
                  className={`flex items-center px-6 py-4 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${activeTab === 'analysis' ? 'border-blue-500 dark:border-indigo-500 text-blue-600 dark:text-indigo-400 bg-blue-50/50 dark:bg-indigo-900/20' : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}
                >
                    <Activity className="w-4 h-4 mr-2" />
                    Analysis
                </button>
            </div>

            {/* Tab Content */}
            <div className="p-6 sm:p-8">
                {activeTab === 'general' && (
                    <div className="space-y-6 max-w-2xl animate-in fade-in duration-300">
                        <div>
                            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                                Project Name
                            </label>
                            <input
                                type="text"
                                name="name"
                                value={formData.name}
                                onChange={handleInputChange}
                                className="w-full px-4 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg shadow-sm focus:ring-2 focus:ring-blue-500 dark:focus:ring-indigo-500 focus:border-blue-500 dark:focus:border-indigo-500 text-slate-900 dark:text-white transition-colors"
                            />
                        </div>
                        
                        <div>
                            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                                Protein Sequence
                            </label>
                            <textarea
                                name="protein_sequence"
                                rows={4}
                                value={formData.protein_sequence}
                                onChange={handleInputChange}
                                placeholder="e.g. MKWVTFISLL LLFSSAYSRG VFRREAAPP..."
                                className="w-full px-4 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg shadow-sm focus:ring-2 focus:ring-blue-500 dark:focus:ring-indigo-500 focus:border-blue-500 dark:focus:border-indigo-500 text-slate-900 dark:text-white transition-colors font-mono text-sm resize-y"
                            />
                            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Enter the primary amino acid sequence.</p>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                                Molecular Weight (kDa)
                            </label>
                            <input
                                type="number"
                                step="any"
                                name="molecular_weight"
                                value={formData.molecular_weight}
                                onChange={handleInputChange}
                                placeholder="e.g. 15.4"
                                className="w-full px-4 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg shadow-sm focus:ring-2 focus:ring-blue-500 dark:focus:ring-indigo-500 focus:border-blue-500 dark:focus:border-indigo-500 text-slate-900 dark:text-white transition-colors"
                            />
                        </div>
                    </div>
                )}

                {activeTab === 'spectra' && (
                    <div className="space-y-6 animate-in fade-in duration-300">
                      <div className="bg-blue-50 dark:bg-indigo-900/20 border border-blue-100 dark:border-indigo-800/50 rounded-lg p-4 mb-6">
                        <h4 className="flex items-center text-blue-800 dark:text-indigo-300 text-sm font-medium mb-1">
                          <Info className="w-4 h-4 mr-2" />
                          Pseudo 3D Spectra Details
                        </h4>
                        <p className="text-blue-600/80 dark:text-indigo-400/80 text-xs ml-6">
                          Load pseudo 3D spectra by providing the absolute path to your processed ft2 file. Ensure the local application process has read access to this path.
                        </p>
                      </div>

                      <div className="flex justify-between items-center mb-6">
                          <h3 className="text-lg font-medium text-slate-900 dark:text-white">Project Spectra</h3>
                          <button
                            type="button"
                            onClick={() => setIsFileBrowserOpen(true)}
                            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 dark:bg-indigo-600 dark:hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-colors flex items-center shadow-sm"
                          >
                            <Folder className="w-4 h-4 mr-2" />
                            Add Spectrum
                          </button>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                        {project?.spectra && project.spectra.length > 0 ? (
                          project.spectra.map((spectrum) => (
                            <div key={spectrum.spectrum_uuid} className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-6 shadow-sm flex items-start space-x-5 transition-all hover:shadow-md hover:border-blue-200 dark:hover:border-indigo-800">
                              <Link 
                                to={`/projects/${project.project_uuid}/spectra/${spectrum.spectrum_uuid}`}
                                className="flex-1 min-w-0 flex items-center group cursor-pointer"
                              >
                                <div className="flex-shrink-0 p-3 bg-blue-50 dark:bg-indigo-900/40 rounded-xl group-hover:bg-blue-100 dark:group-hover:bg-indigo-900/60 transition-colors mr-3">
                                  <img src={nmrSpectraIcon} className="w-12 h-12 min-w-[48px] aspect-square object-cover rounded-xl shadow-sm border border-slate-200 dark:border-slate-700" alt="" />
                                </div>
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center space-x-2">
                                      <h4 className="text-base font-bold text-slate-900 dark:text-white truncate group-hover:text-blue-600 dark:group-hover:text-indigo-400 transition-colors" title={spectrum.name}>
                                        {spectrum.name}
                                      </h4>
                                      {spectrum.is_fitted && (
                                        <span className="flex-shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800 uppercase tracking-tight">
                                          Fitted
                                        </span>
                                      )}
                                    </div>
                                    <div className="flex flex-col mt-1">
                                      {spectrum.experiment_type && (
                                        <span className="text-[10px] font-bold text-blue-600 dark:text-indigo-400 uppercase tracking-widest mb-1">
                                          {spectrum.experiment_type}
                                        </span>
                                      )}
                                      <p className="text-xs text-slate-500 dark:text-slate-400 truncate opacity-70" title={spectrum.file_path}>
                                        {spectrum.file_path}
                                      </p>
                                      {spectrum.b0 !== undefined && (
                                        <div className="flex items-center mt-2">
                                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-900/40 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700/50">
                                            B0: {spectrum.b0} MHz
                                          </span>
                                        </div>
                                      )}
                                    </div>
                                  </div>
                              </Link>
                              <button
                                onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setDeleteModal({ isOpen: true, spectrum });
                                }}
                                className="text-slate-400 hover:text-red-500 transition-colors p-2 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 mt-1"
                                title="Remove Spectrum"
                              >
                                <X className="w-5 h-5" />
                              </button>
                            </div>
                          ))
                        ) : (
                          <div className="col-span-full py-8 text-center border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-lg">
                            <img src={nmrSpectraIcon} className="w-20 h-20 min-w-[80px] aspect-square object-cover mx-auto mb-4 rounded-2xl shadow-md border border-slate-200 dark:border-slate-700" alt="" />
                            <p className="text-sm text-slate-500 dark:text-slate-400">No spectra added yet.</p>
                            <button
                              onClick={() => setIsFileBrowserOpen(true)}
                              className="mt-2 text-sm text-blue-600 dark:text-indigo-400 hover:underline font-medium"
                            >
                              Add your first spectrum
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                )}

                {activeTab === 'analysis' && (
                    <div className="space-y-6 max-w-5xl animate-in fade-in duration-300">
                        <div className="flex justify-between items-center mb-6">
                            <h3 className="text-lg font-medium text-slate-900 dark:text-white">Relaxation Analyses</h3>
                            <button
                                onClick={() => setIsNewAnalysisModalOpen(true)}
                                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 dark:bg-indigo-600 dark:hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-colors flex items-center shadow-sm"
                            >
                                <Plus className="w-4 h-4 mr-2" />
                                Add New Analysis
                            </button>
                        </div>

                        <div className="grid grid-cols-1 gap-4">
                            {project?.analyses && project.analyses.length > 0 ? (
                                project.analyses.map((analysis) => (
                                    <div 
                                        key={analysis.analysis_uuid}
                                        onClick={() => navigate(`/projects/${projectUuid}/analysis/${analysis.analysis_uuid}`)}
                                        className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-5 shadow-sm flex items-center justify-between transition-all hover:shadow-md hover:border-blue-200 dark:hover:border-indigo-800 cursor-pointer group"
                                    >
                                        <div className="flex items-center space-x-4">
                                            <div className="p-3 bg-blue-50 dark:bg-indigo-900/40 rounded-xl group-hover:bg-blue-100 dark:group-hover:bg-indigo-900/60 transition-colors">
                                                <Activity className="w-6 h-6 text-blue-600 dark:text-indigo-400" />
                                            </div>
                                            <div>
                                                <h4 className="text-base font-bold text-slate-900 dark:text-white group-hover:text-blue-600 dark:group-hover:text-indigo-400 transition-colors">
                                                    {analysis.name}
                                                </h4>
                                                <div className="flex items-center space-x-2 mt-1">
                                                    <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                                                        {analysis.analysis_type}
                                                    </span>
                                                    <span className="text-slate-300 dark:text-slate-600">•</span>
                                                    <span className="text-xs text-slate-400 dark:text-slate-500">
                                                        Created {new Date(analysis.created_at).toLocaleDateString()}
                                                    </span>
                                                </div>
                                            </div>
                                        </div>
                                        
                                        <div className="flex items-center space-x-4">
                                            <div className="flex items-center px-3 py-1 rounded-full bg-slate-50 dark:bg-slate-900/50 border border-slate-200 dark:border-slate-700">
                                                {getStatusIcon(analysis.status)}
                                                <span className="ml-2 text-xs font-semibold text-slate-600 dark:text-slate-300 uppercase tracking-tight">
                                                    {analysis.status}
                                                </span>
                                            </div>
                                        <div className="flex items-center space-x-2">
                                            <button 
                                              onClick={(e) => handleDeleteAnalysis(analysis.analysis_uuid, e)}
                                              className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
                                              title="Delete Analysis"
                                            >
                                              <Trash2 className="w-4 h-4" />
                                            </button>
                                            <div className="p-2 text-slate-400 group-hover:text-blue-600 dark:group-hover:text-indigo-400 transition-colors">
                                                <Settings className="w-5 h-5" />
                                            </div>
                                        </div>
                                        </div>
                                    </div>
                                ))
                            ) : (
                                <div className="py-12 text-center border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-lg">
                                    <Activity className="w-12 h-12 mx-auto text-slate-300 dark:text-slate-600 mb-4" />
                                    <h3 className="text-lg font-medium text-slate-900 dark:text-white mb-2">No analyses yet</h3>
                                    <p className="text-slate-500 dark:text-slate-400 text-sm mb-6 max-w-sm mx-auto">
                                        Start your first relaxation analysis by selecting the type and project spectra.
                                    </p>
                                    <button
                                        onClick={() => setIsNewAnalysisModalOpen(true)}
                                        className="px-4 py-2 bg-blue-600 hover:bg-blue-700 dark:bg-indigo-600 dark:hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-colors inline-flex items-center shadow-sm"
                                    >
                                        <Plus className="w-4 h-4 mr-2" />
                                        Create First Analysis
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>



      <FileBrowserModal
        isOpen={isFileBrowserOpen}
        onClose={() => setIsFileBrowserOpen(false)}
        selectType="file"
        fileExtension=".ft2"
        onSelect={handleAddSpectrum}
      />

      <DeleteConfirmationModal
        isOpen={deleteModal.isOpen}
        onClose={() => setDeleteModal({ isOpen: false, spectrum: null })}
        onConfirm={() => handleRemoveSpectrum()}
        title="Remove Spectrum"
        message="Are you sure you want to remove this spectrum? This will permanently delete its associated metadata and fitting result files."
        itemName={deleteModal.spectrum?.name}
      />

      {/* New Analysis Modal */}
      {isNewAnalysisModalOpen && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:block sm:p-0">
            <div className="fixed inset-0 transition-opacity" onClick={() => setIsNewAnalysisModalOpen(false)}>
              <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm"></div>
            </div>
            <span className="hidden sm:inline-block sm:align-middle sm:h-screen"></span>&#8203;
            <div className="inline-block align-bottom bg-white dark:bg-slate-800 rounded-2xl text-left overflow-hidden shadow-xl transform transition-all sm:my-8 sm:align-middle sm:max-w-lg sm:w-full border border-slate-200 dark:border-slate-700">
              <div className="px-6 py-6">
                <div className="flex items-center justify-between mb-6">
                  <h3 className="text-xl font-bold text-slate-900 dark:text-white">Create New Analysis</h3>
                  <button onClick={() => setIsNewAnalysisModalOpen(false)} className="text-slate-400 hover:text-slate-500 transition-colors">
                    <X className="w-5 h-5" />
                  </button>
                </div>
                
                <div className="space-y-5">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Analysis Name</label>
                    <input
                      type="text"
                      placeholder="e.g. T1 Relaxation Room Temp"
                      value={newAnalysisData.name}
                      onChange={(e) => setNewAnalysisData({...newAnalysisData, name: e.target.value})}
                      className="w-full px-4 py-2 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg shadow-sm focus:ring-2 focus:ring-blue-500 dark:focus:ring-indigo-500 text-slate-900 dark:text-white"
                    />
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Analysis Type</label>
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                      <button
                        type="button"
                        onClick={() => setNewAnalysisData({...newAnalysisData, type: 'R1'})}
                        className={`px-3 py-3 rounded-xl border-2 transition-all flex flex-col items-center justify-center ${newAnalysisData.type === 'R1' ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300' : 'border-slate-100 dark:border-slate-700 text-slate-500 hover:border-slate-300 dark:hover:border-slate-600'}`}
                      >
                        <span className="font-bold text-base">R1</span>
                        <span className="text-[10px] uppercase font-bold tracking-wider opacity-60">T1 Relaxation</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setNewAnalysisData({...newAnalysisData, type: 'R2'})}
                        className={`px-3 py-3 rounded-xl border-2 transition-all flex flex-col items-center justify-center ${newAnalysisData.type === 'R2' ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300' : 'border-slate-100 dark:border-slate-700 text-slate-500 hover:border-slate-300 dark:hover:border-slate-600'}`}
                      >
                        <span className="font-bold text-base">R2</span>
                        <span className="text-[10px] uppercase font-bold tracking-wider opacity-60">T2 Relaxation</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setNewAnalysisData({...newAnalysisData, type: 'hetNOE'})}
                        className={`px-3 py-3 rounded-xl border-2 transition-all flex flex-col items-center justify-center ${newAnalysisData.type === 'hetNOE' ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300' : 'border-slate-100 dark:border-slate-700 text-slate-500 hover:border-slate-300 dark:hover:border-slate-600'}`}
                      >
                        <span className="font-bold text-base">Noe</span>
                        <span className="text-[10px] uppercase font-bold tracking-wider opacity-60">hetNOE Ratio</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setNewAnalysisData({...newAnalysisData, type: '15N-CEST'})}
                        className={`px-3 py-3 rounded-xl border-2 transition-all flex flex-col items-center justify-center ${newAnalysisData.type === '15N-CEST' || newAnalysisData.type === 'CEST' ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300' : 'border-slate-100 dark:border-slate-700 text-slate-500 hover:border-slate-300 dark:hover:border-slate-600'}`}
                      >
                        <span className="font-bold text-base">CEST</span>
                        <span className="text-[10px] uppercase font-bold tracking-wider opacity-60">15N-CEST</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setNewAnalysisData({...newAnalysisData, type: 'CPMG'})}
                        className={`px-3 py-3 rounded-xl border-2 transition-all flex flex-col items-center justify-center ${newAnalysisData.type === 'CPMG' ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300' : 'border-slate-100 dark:border-slate-700 text-slate-500 hover:border-slate-300 dark:hover:border-slate-600'}`}
                      >
                        <span className="font-bold text-base">CPMG</span>
                        <span className="text-[10px] uppercase font-bold tracking-wider opacity-60">CPMG</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
              
              <div className="px-6 py-4 bg-slate-50 dark:bg-slate-900/50 flex justify-end space-x-3">
                <button
                  onClick={() => setIsNewAnalysisModalOpen(false)}
                  className="px-4 py-2 text-sm font-medium text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreateAnalysis}
                  disabled={!newAnalysisData.name}
                  className="px-6 py-2 bg-blue-600 hover:bg-blue-700 dark:bg-indigo-600 dark:hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition-all shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Create Analysis
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ProjectDetails;
