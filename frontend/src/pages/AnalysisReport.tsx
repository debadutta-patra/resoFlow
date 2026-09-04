import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../services/api';
import {
  ArrowLeft,
  Download,
  FileText,
  Printer,
  Code,
  AlertCircle,
  Loader2,
  Copy,
  Check,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';

const AnalysisReport: React.FC = () => {
  const { projectUuid, analysisUuid } = useParams<{ projectUuid: string; analysisUuid: string }>();
  const navigate = useNavigate();
  useAuth();

  const [analysis, setAnalysis] = useState<any>(null);
  const [htmlContent, setHtmlContent] = useState<string>('');
  const [jsonContent, setJsonContent] = useState<any>(null);
  const [activeView, setActiveView] = useState<'html' | 'json'>('html');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string>('');

  // Async PDF generation states
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const [exportMessage, setExportMessage] = useState<string>('');
  const [copiedJson, setCopiedJson] = useState(false);

  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    fetchReportData();
  }, [projectUuid, analysisUuid]);

  const fetchReportData = async () => {
    try {
      setIsLoading(true);
      setError('');

      // 1. Fetch analysis metadata
      const projRes = await api.get(`/api/projects/${projectUuid}`);
      const a = projRes.data.analyses?.find((x: any) => x.analysis_uuid === analysisUuid);
      if (!a) {
        setError('Analysis not found in this project');
        setIsLoading(false);
        return;
      }
      setAnalysis(a);

      // 2. Fetch HTML report content
      const htmlRes = await api.get(
        `/api/projects/${projectUuid}/analysis/${analysisUuid}/report.html?style=screen`,
        { responseType: 'text' }
      );
      setHtmlContent(htmlRes.data);

      // 3. Fetch JSON report model
      try {
        const jsonRes = await api.get(
          `/api/projects/${projectUuid}/analysis/${analysisUuid}/report.json`
        );
        setJsonContent(jsonRes.data);
      } catch (jErr) {
        console.warn('Could not fetch report.json:', jErr);
      }
    } catch (err: any) {
      console.error('Failed to load report:', err);
      setError(
        err.response?.data?.detail ||
          'Failed to load report. Ensure the analysis is completed and results exist.'
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleDownloadPdf = async () => {
    try {
      setIsExportingPdf(true);
      setExportMessage('Starting PDF export job...');

      // 1. Dispatch asynchronous Celery task on stats queue
      const asyncRes = await api.post(
        `/api/projects/${projectUuid}/analysis/${analysisUuid}/report/async`,
        { style: 'publication' }
      );

      const { task_id, download_url } = asyncRes.data;
      setExportMessage('Generating publication PDF in background...');

      // 2. Poll task status
      let ready = false;
      let attempts = 0;
      const maxAttempts = 60; // 2 minutes timeout at 2s intervals

      while (!ready && attempts < maxAttempts) {
        await new Promise((r) => setTimeout(r, 2000));
        attempts += 1;

        try {
          const statusRes = await api.get(
            `/api/projects/${projectUuid}/analysis/${analysisUuid}/report/status/${task_id}`
          );

          if (statusRes.data.status === 'SUCCESS' || statusRes.data.ready) {
            ready = true;
            setExportMessage('PDF ready! Downloading...');

            // 3. Trigger download via signed token URL
            const fileRes = await api.get(download_url, { responseType: 'blob' });
            const blob = new Blob([fileRes.data], { type: 'application/pdf' });
            const link = document.createElement('a');
            link.href = window.URL.createObjectURL(blob);
            link.download = `${analysis?.name || 'analysis'}_${analysisUuid?.slice(0, 8)}_report.pdf`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            window.URL.revokeObjectURL(link.href);

            setExportMessage('Download complete!');
            setTimeout(() => {
              setExportMessage('');
              setIsExportingPdf(false);
            }, 3000);
            return;
          } else if (statusRes.data.status === 'FAILURE') {
            throw new Error(statusRes.data.error || 'PDF generation failed on worker');
          }
        } catch (pollErr: any) {
          if (pollErr.response?.status === 404) {
            continue;
          }
          throw pollErr;
        }
      }

      if (!ready) {
        throw new Error('PDF export timed out. Please try again.');
      }
    } catch (err: any) {
      console.error('Async PDF export failed:', err);
      // Fallback: Attempt direct synchronous download
      try {
        setExportMessage('Attempting direct download fallback...');
        const directRes = await api.get(
          `/api/projects/${projectUuid}/analysis/${analysisUuid}/report.pdf?style=publication`,
          { responseType: 'blob' }
        );
        const blob = new Blob([directRes.data], { type: 'application/pdf' });
        const link = document.createElement('a');
        link.href = window.URL.createObjectURL(blob);
        link.download = `${analysis?.name || 'analysis'}_report.pdf`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.URL.revokeObjectURL(link.href);
        setExportMessage('Direct download complete!');
        setTimeout(() => {
          setExportMessage('');
          setIsExportingPdf(false);
        }, 3000);
      } catch (fallbackErr: any) {
        alert(
          err.response?.data?.detail ||
            err.message ||
            'Failed to generate or download report PDF.'
        );
        setIsExportingPdf(false);
        setExportMessage('');
      }
    }
  };

  const handlePrint = () => {
    if (iframeRef.current && iframeRef.current.contentWindow) {
      iframeRef.current.contentWindow.focus();
      iframeRef.current.contentWindow.print();
    } else {
      window.print();
    }
  };

  const handleCopyJson = () => {
    if (jsonContent) {
      navigator.clipboard.writeText(JSON.stringify(jsonContent, null, 2));
      setCopiedJson(true);
      setTimeout(() => setCopiedJson(false), 2000);
    }
  };

  if (isLoading) {
    return (
      <div className="flex flex-col justify-center items-center min-h-[600px] gap-3 text-slate-500">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-600" />
        <p className="text-sm font-medium">Loading report document...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-4xl mx-auto p-6 space-y-4">
        <button
          onClick={() => navigate(`/projects/${projectUuid}/analysis/${analysisUuid}`)}
          className="inline-flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Analysis
        </button>
        <div className="p-5 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 rounded-xl text-rose-700 dark:text-rose-400 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 mt-0.5 flex-shrink-0" />
          <div>
            <h3 className="font-semibold text-sm">Report Unavailable</h3>
            <p className="text-sm mt-1">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-slate-100 dark:bg-slate-900 overflow-hidden">
      {/* Top Navigation / Actions Toolbar */}
      <header className="flex-none bg-white dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 px-6 py-3 flex items-center justify-between shadow-sm z-20">
        <div className="flex items-center space-x-4">
          <button
            onClick={() => navigate(`/projects/${projectUuid}/analysis/${analysisUuid}`)}
            className="p-2 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-all"
            title="Back to Analysis"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold text-slate-900 dark:text-white tracking-tight">
                {analysis?.name || 'Analysis Report'}
              </h1>
              <span className="px-2 py-0.5 text-xs font-semibold rounded bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300">
                {analysis?.analysis_type}
              </span>
              <span className="px-2 py-0.5 text-xs font-semibold rounded bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800">
                {analysis?.status}
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Interactive Report Viewer • WeasyPrint / Paged Media Engine
            </p>
          </div>
        </div>

        {/* View Switcher and Actions */}
        <div className="flex items-center space-x-3">
          {/* View Toggle */}
          <div className="flex bg-slate-100 dark:bg-slate-700 p-0.5 rounded-lg text-xs font-medium text-slate-600 dark:text-slate-300">
            <button
              onClick={() => setActiveView('html')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-all ${
                activeView === 'html'
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm font-semibold'
                  : 'hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <FileText className="w-3.5 h-3.5" />
              HTML Report
            </button>
            <button
              onClick={() => setActiveView('json')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-all ${
                activeView === 'json'
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm font-semibold'
                  : 'hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              <Code className="w-3.5 h-3.5" />
              Data Model (JSON)
            </button>
          </div>

          <div className="h-6 w-px bg-slate-200 dark:bg-slate-700 mx-1" />

          {/* Print Button */}
          {activeView === 'html' && (
            <button
              onClick={handlePrint}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 rounded-lg shadow-sm transition-colors"
              title="Print document"
            >
              <Printer className="w-3.5 h-3.5" />
              Print
            </button>
          )}

          {/* PDF Export Button (Async Celery Task on stats queue) */}
          <button
            onClick={handleDownloadPdf}
            disabled={isExportingPdf}
            className={`inline-flex items-center gap-2 px-3.5 py-1.5 text-xs font-medium rounded-lg text-white shadow-sm transition-all ${
              isExportingPdf
                ? 'bg-indigo-400 cursor-not-allowed'
                : 'bg-indigo-600 hover:bg-indigo-700 active:scale-[0.98]'
            }`}
            title="Generate publication PDF asynchronously via Celery worker"
          >
            {isExportingPdf ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>{exportMessage || 'Generating PDF...'}</span>
              </>
            ) : (
              <>
                <Download className="w-3.5 h-3.5" />
                <span>Download PDF</span>
              </>
            )}
          </button>
        </div>
      </header>

      {/* Main View Area */}
      <main className="flex-1 relative overflow-hidden">
        {activeView === 'html' ? (
          <iframe
            ref={iframeRef}
            srcDoc={htmlContent}
            title={`${analysis?.name || 'Analysis'} HTML Report`}
            className="w-full h-full border-0 bg-white"
            sandbox="allow-same-origin allow-scripts allow-popups"
          />
        ) : (
          <div className="w-full h-full overflow-auto p-6 bg-slate-900 text-slate-100 font-mono text-xs">
            <div className="max-w-5xl mx-auto space-y-3">
              <div className="flex items-center justify-between pb-2 border-b border-slate-800">
                <span className="text-slate-400 font-sans text-xs">
                  Canonical ReportModel serialized via <code className="text-indigo-400">to_dict()</code> (WeasyPrint Spec §9)
                </span>
                <button
                  onClick={handleCopyJson}
                  className="inline-flex items-center gap-1.5 px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-xs transition-colors"
                >
                  {copiedJson ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      <span className="text-emerald-400">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy JSON</span>
                    </>
                  )}
                </button>
              </div>
              <pre className="p-4 bg-slate-950 rounded-xl overflow-x-auto border border-slate-800 leading-relaxed">
                {jsonContent ? JSON.stringify(jsonContent, null, 2) : 'No JSON data available'}
              </pre>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default AnalysisReport;
