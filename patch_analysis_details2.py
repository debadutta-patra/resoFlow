with open("frontend/src/pages/AnalysisDetails.tsx", "r") as f:
    content = f.read()

import_statement = "import { ExchangeAnalysisManager } from '../components/ExchangeAnalysisManager';\n"
if "import { ExchangeAnalysisManager" not in content:
    content = content.replace("import SdmAnalysisManager", import_statement + "import SdmAnalysisManager")

old_str = "        ) : selectedAnalysis.analysis_type === 'SDM' ? ("
new_str = """        ) : selectedAnalysis.analysis_type === 'EXCHANGE' ? (
          <ExchangeAnalysisManager
            analysis={selectedAnalysis}
            projectUuid={projectUuid!}
            spectra={project?.spectra || []}
            onUpdate={() => fetchProjectDetails(false)}
          />
        ) : selectedAnalysis.analysis_type === 'SDM' ? ("""

content = content.replace(old_str, new_str)

with open("frontend/src/pages/AnalysisDetails.tsx", "w") as f:
    f.write(content)
