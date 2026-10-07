import re

with open("frontend/src/pages/AnalysisDetails.tsx", "r") as f:
    content = f.read()

import_statement = "import { ExchangeAnalysisManager } from '../components/ExchangeAnalysisManager';\n"
if "import { ExchangeAnalysisManager" not in content:
    content = content.replace("import SdmAnalysisManager from '../components/SdmAnalysisManager';", "import SdmAnalysisManager from '../components/SdmAnalysisManager';\n" + import_statement)

# Replace the switch rendering block
old_block = """        {selectedAnalysis.analysis_type === '15N-CEST' || selectedAnalysis.analysis_type === 'CEST' ? (
          <CestAnalysisManager
            analysis={selectedAnalysis}
            projectUuid={projectUuid!}
            availableSpectra={project?.spectra || []}
            allAnalyses={project?.analyses || []}
            onStatusChange={(status) => {
                setSelectedAnalysis({ ...selectedAnalysis, status });
            }}
            onUpdate={() => fetchProjectDetails(false)}
            onClose={handleClose}
            onDelete={handleClose}
          />
        ) : selectedAnalysis.analysis_type === 'CPMG' ? (
          <CpmgAnalysisManager
            analysis={selectedAnalysis}
            projectUuid={projectUuid!}
            spectra={project?.spectra || []}
            onUpdate={() => fetchProjectDetails(false)}
          />
        ) : selectedAnalysis.analysis_type === 'SDM' ? (
          <SdmAnalysisManager
            analysis={selectedAnalysis}
            projectUuid={projectUuid!}
            spectra={project?.spectra || []}
            onUpdate={() => fetchProjectDetails(false)}
          />
        ) : (
          <AnalysisManager
            analysis={selectedAnalysis}
            projectUuid={projectUuid!}
            spectra={project?.spectra || []}
            onUpdate={() => fetchProjectDetails(false)}
          />
        )}"""

new_block = """        {selectedAnalysis.analysis_type === '15N-CEST' || selectedAnalysis.analysis_type === 'CEST' ? (
          <CestAnalysisManager
            analysis={selectedAnalysis}
            projectUuid={projectUuid!}
            availableSpectra={project?.spectra || []}
            allAnalyses={project?.analyses || []}
            onStatusChange={(status) => {
                setSelectedAnalysis({ ...selectedAnalysis, status });
            }}
            onUpdate={() => fetchProjectDetails(false)}
            onClose={handleClose}
            onDelete={handleClose}
          />
        ) : selectedAnalysis.analysis_type === 'CPMG' ? (
          <CpmgAnalysisManager
            analysis={selectedAnalysis}
            projectUuid={projectUuid!}
            spectra={project?.spectra || []}
            onUpdate={() => fetchProjectDetails(false)}
          />
        ) : selectedAnalysis.analysis_type === 'SDM' ? (
          <SdmAnalysisManager
            analysis={selectedAnalysis}
            projectUuid={projectUuid!}
            spectra={project?.spectra || []}
            onUpdate={() => fetchProjectDetails(false)}
          />
        ) : selectedAnalysis.analysis_type === 'EXCHANGE' ? (
          <ExchangeAnalysisManager
            analysis={selectedAnalysis}
            projectUuid={projectUuid!}
            spectra={project?.spectra || []}
            onUpdate={() => fetchProjectDetails(false)}
          />
        ) : (
          <AnalysisManager
            analysis={selectedAnalysis}
            projectUuid={projectUuid!}
            spectra={project?.spectra || []}
            onUpdate={() => fetchProjectDetails(false)}
          />
        )}"""

content = content.replace(old_block, new_block)

with open("frontend/src/pages/AnalysisDetails.tsx", "w") as f:
    f.write(content)
