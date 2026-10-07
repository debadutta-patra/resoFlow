import re

with open("frontend/src/components/ExchangeAnalysisManager.tsx", "r") as f:
    content = f.read()

# Fix unused imports
content = content.replace("import { Layers, Activity, Settings, Check, Copy, AlertCircle, X, Play } from 'lucide-react';", "import { Layers, Activity, Settings, Check, Play } from 'lucide-react';")

# Fix RunsContext import
content = content.replace("import { useOptionalUserRuns } from '../context/UserRunsContext';", "import { useOptionalUserRuns } from '../context/RunsContext';")

# Fix NodeJS.Timeout
content = content.replace("let interval: NodeJS.Timeout;", "let interval: number;")
content = content.replace("interval = setInterval(fetchLogs, 2000);", "interval = window.setInterval(fetchLogs, 2000);")

with open("frontend/src/components/ExchangeAnalysisManager.tsx", "w") as f:
    f.write(content)
