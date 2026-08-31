import type {
  MethodConfig,
  Step,
  ParamSetting,
  ParseResult,
} from './methodConfig';
import { createDefaultStep } from './methodConfig';

/**
 * Serializes a structured MethodConfig into a deterministic ChemEx method.toml string.
 */
export function configToToml(config: MethodConfig): string {
  if (config.rawOverride !== undefined && config.rawOverride.trim() !== '') {
    return config.rawOverride;
  }

  const sections: string[] = [];

  for (const step of config.steps) {
    const lines: string[] = [];
    const stepName = (step.name || 'STEP1').trim().toUpperCase();
    lines.push(`[${stepName}]`);

    // 1. FIT
    const fitParams = step.parameters.filter(p => p.mode === 'fit');
    if (fitParams.length > 0) {
      const names = fitParams.map(p => `"${p.name.toUpperCase()}"`).join(', ');
      lines.push(`FIT = [${names}]`);
    }

    // 2. FIX
    const fixParams = step.parameters.filter(p => p.mode === 'fix');
    if (fixParams.length > 0) {
      const names = fixParams.map(p => `"${p.name.toUpperCase()}"`).join(', ');
      lines.push(`FIX = [${names}]`);
    }

    // 3. CONSTRAINTS
    const constraintList: string[] = [];
    // From fit bounds (e.g. bounds: "< 0.5" -> "[PB] < 0.5" or "PB < 0.5")
    for (const p of fitParams) {
      if (p.bounds && p.bounds.trim() !== '') {
        const b = p.bounds.trim();
        if (b.startsWith('[') || b.toUpperCase().startsWith(p.name.toUpperCase())) {
          constraintList.push(b);
        } else {
          constraintList.push(`[${p.name.toUpperCase()}] ${b}`);
        }
      }
    }
    // From constrain mode expressions
    const constrainParams = step.parameters.filter(p => p.mode === 'constrain');
    for (const p of constrainParams) {
      if (p.expression && p.expression.trim() !== '') {
        const expr = p.expression.trim();
        if (expr.includes('=')) {
          constraintList.push(expr);
        } else {
          constraintList.push(`[${p.name.toUpperCase()}] = ${expr}`);
        }
      }
    }

    if (constraintList.length === 1) {
      lines.push(`CONSTRAINTS = ["${constraintList[0].replace(/"/g, '')}"]`);
    } else if (constraintList.length > 1) {
      const formatted = constraintList
        .map(c => `  "${c.replace(/"/g, '')}"`)
        .join(',\n');
      lines.push(`CONSTRAINTS = [\n${formatted}\n]`);
    }

    // 4. GRID
    const gridParams = step.parameters.filter(p => p.mode === 'grid' && p.grid);
    if (gridParams.length > 0) {
      const gridItems = gridParams.map(p => {
        const g = p.grid!;
        const fn = g.scale === 'log' ? 'log' : 'lin';
        const pName = p.name.toUpperCase().startsWith('[') ? p.name.toUpperCase() : `[${p.name.toUpperCase()}]`;
        return `"${pName} = ${fn}(${g.min}, ${g.max}, ${g.steps})"`;
      });
      if (gridItems.length === 1) {
        lines.push(`GRID = [${gridItems[0]}]`);
      } else {
        const formatted = gridItems.map(item => `  ${item}`).join(',\n');
        lines.push(`GRID = [\n${formatted}\n]`);
      }
    }

    // 5. INCLUDE / EXCLUDE
    if (step.residues && step.residues.length > 0) {
      const formattedRes = step.residues.map(r => (typeof r === 'number' || /^\d+$/.test(String(r)) ? String(r) : `"${r}"`)).join(', ');
      if (step.residueMode === 'include') {
        lines.push(`INCLUDE = [${formattedRes}]`);
      } else if (step.residueMode === 'exclude') {
        lines.push(`EXCLUDE = [${formattedRes}]`);
      }
    }

    // 6. STATISTICS (ChemEx v1)
    let mcmcSubtable = '';
    if (step.statistics) {
      const stats = step.statistics;
      const inlineParts: string[] = [];

      if (stats.mc?.enabled && stats.mc.replicates > 0) {
        inlineParts.push(`"MC" = ${stats.mc.replicates}`);
      }
      if (stats.bs?.enabled && stats.bs.replicates > 0) {
        inlineParts.push(`"BS" = ${stats.bs.replicates}`);
      }
      if (stats.bsn?.enabled && stats.bsn.replicates > 0) {
        inlineParts.push(`"BSN" = ${stats.bsn.replicates}`);
      }

      if (stats.mcmc?.enabled && stats.mcmc.steps > 0) {
        const m = stats.mcmc;
        const isSimple = (
          (m.burn === 'auto' || m.burn === undefined) &&
          (m.thin === 1 || m.thin === undefined) &&
          m.walkers === undefined &&
          m.seed === undefined &&
          m.workers === undefined &&
          !m.update_parameters
        );

        if (isSimple) {
          inlineParts.push(`"MCMC" = ${m.steps}`);
        } else {
          // Expanded form subtable
          const subLines = [`[${stepName}.STATISTICS.MCMC]`];
          subLines.push(`STEPS = ${m.steps}`);
          if (m.burn === 'auto' || typeof m.burn === 'string') {
            subLines.push(`BURN = "${String(m.burn || 'AUTO').toUpperCase()}"`);
          } else {
            subLines.push(`BURN = ${m.burn}`);
          }
          subLines.push(`THIN = ${m.thin || 1}`);
          if (m.walkers !== undefined && m.walkers !== null) {
            subLines.push(`WALKERS = ${m.walkers}`);
          }
          if (m.seed !== undefined && m.seed !== null) {
            subLines.push(`SEED = ${m.seed}`);
          }
          if (m.workers !== undefined && m.workers !== null) {
            subLines.push(`WORKERS = ${m.workers}`);
          }
          if (m.update_parameters) {
            subLines.push('UPDATE_PARAMETERS = true');
          }
          mcmcSubtable = subLines.join('\n');
        }
      }

      if (inlineParts.length > 0) {
        lines.push(`STATISTICS = { ${inlineParts.join(', ')} }`);
      }
    }

    sections.push(lines.join('\n'));
    if (mcmcSubtable) {
      sections.push(mcmcSubtable);
    }
  }

  return sections.join('\n\n') + '\n';
}

/**
 * Best-effort parser for ChemEx method.toml.
 * Parses known sections, keys (FIT, FIX, CONSTRAINTS, GRID, INCLUDE, EXCLUDE, STATISTICS).
 * Lines or blocks that cannot be represented in the structured model are captured in `unparsed`.
 */
export function tomlToConfig(toml: string): ParseResult {
  const unparsed: string[] = [];

  if (!toml || toml.trim() === '') {
    return {
      config: { steps: [createDefaultStep()] },
      unparsed: [],
    };
  }

  // Pre-process: split into lines, normalize whitespace
  const rawLines = toml.split(/\r?\n/);
  
  // Track sections
  interface RawSection {
    name: string;
    lines: string[];
    isSubTable?: boolean;
    parentSection?: string;
  }

  const sections: RawSection[] = [];
  let currentSection: RawSection = { name: 'STEP1', lines: [] };
  let hasExplicitSection = false;

  for (const line of rawLines) {
    const trimmed = line.trim();

    // Check for comment
    if (trimmed.startsWith('#')) {
      unparsed.push(line);
      continue;
    }

    // Check for section header [SECTION] or [SECTION.SUB] or [SECTION.STATISTICS.MCMC]
    const sectionMatch = trimmed.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (sectionMatch) {
      const secName = sectionMatch[1];
      if (secName.includes('.')) {
        const parts = secName.split('.');
        const parent = parts[0];
        const sub = parts.slice(1).join('.');
        currentSection = {
          name: sub,
          lines: [],
          isSubTable: true,
          parentSection: parent,
        };
        sections.push(currentSection);
      } else {
        currentSection = { name: secName, lines: [] };
        sections.push(currentSection);
      }
      hasExplicitSection = true;
      continue;
    }

    if (trimmed !== '') {
      currentSection.lines.push(line);
    }
  }

  // If no explicit section was declared but there are lines
  if (!hasExplicitSection && currentSection.lines.length > 0) {
    sections.push(currentSection);
  }

  // Merge sub-tables into parent sections or build steps
  const stepMap = new Map<string, Step>();
  const stepOrder: string[] = [];

  for (const sec of sections) {
    const parentName = (sec.isSubTable ? sec.parentSection! : sec.name).toUpperCase();

    if (!stepMap.has(parentName)) {
      stepOrder.push(parentName);
      stepMap.set(parentName, {
        id: `step_${parentName}_${Math.random().toString(36).slice(2, 7)}`,
        name: parentName,
        parameters: [],
        residueMode: 'include',
        residues: [],
      });
    }

    const step = stepMap.get(parentName)!;

    if (sec.isSubTable && sec.name.toUpperCase() === 'GRID') {
      for (const line of sec.lines) {
        parseGridEntry(step, line.trim(), unparsed);
      }
      continue;
    }

    if (sec.isSubTable && (sec.name.toUpperCase() === 'STATISTICS.MCMC' || sec.name.toUpperCase() === 'MCMC')) {
      if (!step.statistics) step.statistics = {};
      const mcmcSettings: any = { enabled: true, steps: 5000, burn: 'auto', thin: 1 };
      for (const line of sec.lines) {
        const kvMatch = line.trim().match(/^([A-Za-z0-9_]+)\s*=\s*([\s\S]+)$/);
        if (kvMatch) {
          const k = kvMatch[1].toUpperCase();
          const v = kvMatch[2].trim().replace(/^["']|["']$/g, '');
          if (k === 'STEPS') mcmcSettings.steps = parseInt(v, 10);
          else if (k === 'BURN') mcmcSettings.burn = v.toLowerCase() === 'auto' ? 'auto' : parseInt(v, 10);
          else if (k === 'THIN') mcmcSettings.thin = parseInt(v, 10);
          else if (k === 'WALKERS') mcmcSettings.walkers = parseInt(v, 10);
          else if (k === 'SEED') mcmcSettings.seed = parseInt(v, 10);
          else if (k === 'WORKERS') mcmcSettings.workers = parseInt(v, 10);
          else if (k === 'UPDATE_PARAMETERS') mcmcSettings.update_parameters = v.toLowerCase() === 'true';
        }
      }
      step.statistics.mcmc = mcmcSettings;
      continue;
    }

    // Parse main section body (merging multi-line statements)
    const combinedStatements = combineMultilineStatements(sec.lines);

    for (const stmt of combinedStatements) {
      const kvMatch = stmt.match(/^([A-Za-z0-9_]+)\s*=\s*([\s\S]+)$/);
      if (!kvMatch) {
        unparsed.push(stmt);
        continue;
      }

      const key = kvMatch[1].toUpperCase();
      const valStr = kvMatch[2].trim();

      if (key === 'FIT') {
        const items = parseStringOrIdentArray(valStr);
        for (const item of items) {
          upsertParam(step, item.toUpperCase(), { mode: 'fit' });
        }
      } else if (key === 'FIX') {
        const items = parseStringOrIdentArray(valStr);
        for (const item of items) {
          upsertParam(step, item.toUpperCase(), { mode: 'fix' });
        }
      } else if (key === 'CONSTRAINTS') {
        const constraints = parseStringOrArrayOfStrings(valStr);
        for (const rawC of constraints) {
          parseConstraintIntoStep(step, rawC);
        }
      } else if (key === 'GRID') {
        parseGridValue(step, valStr, unparsed);
      } else if (key === 'INCLUDE') {
        const items = parseStringOrIdentArray(valStr);
        step.residueMode = 'include';
        step.residues = items;
      } else if (key === 'EXCLUDE') {
        const items = parseStringOrIdentArray(valStr);
        step.residueMode = 'exclude';
        step.residues = items;
      } else if (key === 'STATISTICS') {
        parseInlineStatisticsTable(step, valStr, unparsed);
      } else {
        // Unknown key
        unparsed.push(stmt);
      }
    }
  }

  const steps: Step[] = stepOrder.map(name => stepMap.get(name)!);

  return {
    config: {
      steps: steps.length > 0 ? steps : [createDefaultStep()],
    },
    unparsed,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function splitTopLevelCommas(str: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inBracket = 0;
  let inBrace = 0;
  let inParen = 0;
  let inQuote: string | null = null;

  for (let i = 0; i < str.length; i++) {
    const char = str[i];

    if (inQuote) {
      if (char === inQuote && str[i - 1] !== '\\') {
        inQuote = null;
      }
      current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      inQuote = char;
      current += char;
      continue;
    }

    if (char === '[') inBracket++;
    else if (char === ']') inBracket--;
    else if (char === '{') inBrace++;
    else if (char === '}') inBrace--;
    else if (char === '(') inParen++;
    else if (char === ')') inParen--;

    if (char === ',' && inBracket === 0 && inBrace === 0 && inParen === 0) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function parseInlineStatisticsTable(step: Step, valStr: string, unparsed: string[]) {
  if (!step.statistics) step.statistics = {};
  const inner = valStr.trim().replace(/^\{\s*|\s*\}$/g, '');
  const entries = splitTopLevelCommas(inner);
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const kv = trimmed.match(/^["']?([A-Za-z0-9_]+)["']?\s*=\s*([\s\S]+)$/);
    if (kv) {
      const k = kv[1].toUpperCase();
      const v = kv[2].trim();
      if (k === 'MC' || k === 'BS' || k === 'BSN') {
        const count = parseInt(v, 10);
        if (!isNaN(count)) {
          const keyLower = k.toLowerCase() as 'mc' | 'bs' | 'bsn';
          step.statistics[keyLower] = {
            enabled: true,
            replicates: count,
          };
        }
      } else if (k === 'MCMC') {
        if (v.startsWith('{')) {
          const mcmcInner = v.replace(/^\{\s*|\s*\}$/g, '');
          const mcmcPairs = splitTopLevelCommas(mcmcInner);
          const mObj: any = { enabled: true, steps: 5000, burn: 'auto', thin: 1 };
          for (const pair of mcmcPairs) {
            const pMatch = pair.match(/^["']?([A-Za-z0-9_]+)["']?\s*=\s*([\s\S]+)$/);
            if (pMatch) {
              const mk = pMatch[1].toUpperCase();
              const mv = pMatch[2].trim().replace(/^["']|["']$/g, '');
              if (mk === 'STEPS') mObj.steps = parseInt(mv, 10);
              else if (mk === 'BURN') mObj.burn = mv.toLowerCase() === 'auto' ? 'auto' : parseInt(mv, 10);
              else if (mk === 'THIN') mObj.thin = parseInt(mv, 10);
              else if (mk === 'WALKERS') mObj.walkers = parseInt(mv, 10);
              else if (mk === 'SEED') mObj.seed = parseInt(mv, 10);
              else if (mk === 'WORKERS') mObj.workers = parseInt(mv, 10);
              else if (mk === 'UPDATE_PARAMETERS') mObj.update_parameters = mv.toLowerCase() === 'true';
            }
          }
          step.statistics.mcmc = mObj;
        } else {
          const stepsCount = parseInt(v, 10);
          if (!isNaN(stepsCount)) {
            step.statistics.mcmc = {
              enabled: true,
              steps: stepsCount,
              burn: 'auto',
              thin: 1,
            };
          }
        }
      }
    } else {
      unparsed.push(trimmed);
    }
  }
}

function upsertParam(step: Step, name: string, update: Partial<ParamSetting>) {
  const existing = step.parameters.find(p => p.name.toUpperCase() === name.toUpperCase());
  if (existing) {
    Object.assign(existing, update);
  } else {
    step.parameters.push({
      name: name.toUpperCase(),
      mode: update.mode || 'fit',
      ...update,
    });
  }
}

function parseConstraintIntoStep(step: Step, constraintStr: string) {
  const c = constraintStr.trim().replace(/^["']|["']$/g, '');

  // 1. Bound format: "[PB] < 0.5" or "PB < 0.5" or "[PB] > 0" or "PB > 0" or "<= / >="
  const boundMatch = c.match(/^(?:\[([A-Za-z0-9_]+)\]|([A-Za-z0-9_]+))\s*([<>]=?\s*[\d.eE+-]+)$/i);
  if (boundMatch) {
    const paramName = (boundMatch[1] || boundMatch[2]).toUpperCase();
    const boundPart = boundMatch[3].trim();
    upsertParam(step, paramName, {
      mode: 'fit',
      bounds: boundPart,
    });
    return;
  }

  // 2. Expression constraint: "[R2_B] = 0.5 * [R2_A]" or "R2_B = 0.5 * [R2_A]"
  const exprMatch = c.match(/^(?:\[([A-Za-z0-9_]+)\]|([A-Za-z0-9_]+))\s*=\s*(.+)$/i);
  if (exprMatch) {
    const paramName = (exprMatch[1] || exprMatch[2]).toUpperCase();
    const expression = exprMatch[3].trim();
    upsertParam(step, paramName, {
      mode: 'constrain',
      expression,
    });
    return;
  }

  // 3. Fallback: try to extract bracketed parameter name
  const fallbackMatch = c.match(/\[([A-Za-z0-9_]+)\]/i);
  if (fallbackMatch) {
    const paramName = fallbackMatch[1].toUpperCase();
    upsertParam(step, paramName, {
      mode: 'constrain',
      expression: c,
    });
  }
}

function parseGridEntry(step: Step, entryStr: string, unparsed: string[]) {
  const clean = entryStr.trim().replace(/^["']|["']$/g, '').trim();
  if (!clean) return;

  // 1. ChemEx standard: "[KEX_AB] = log(100.0, 600.0, 10)" or "KEX_AB = lin(0.0, 10.0, 5)"
  const funcMatch = clean.match(/^(?:\[([A-Za-z0-9_]+)\]|([A-Za-z0-9_]+))\s*=\s*(log|lin)\s*\(\s*([\d.eE+-]+)\s*,\s*([\d.eE+-]+)\s*,\s*(\d+)\s*\)$/i);
  if (funcMatch) {
    const paramName = (funcMatch[1] || funcMatch[2]).toUpperCase();
    const scale = funcMatch[3].toLowerCase() === 'log' ? 'log' : 'lin';
    const minVal = parseFloat(funcMatch[4]);
    const maxVal = parseFloat(funcMatch[5]);
    const stepsVal = parseInt(funcMatch[6], 10);
    upsertParam(step, paramName, {
      mode: 'grid',
      grid: {
        min: minVal,
        max: maxVal,
        steps: stepsVal,
        scale,
      },
    });
    return;
  }

  // 2. Bracketed array: "[KEX_AB] = [100.0, 600.0, 10]" or "KEX_AB = [100.0, 600.0, 10]"
  const arrMatch = clean.match(/^(?:\[([A-Za-z0-9_]+)\]|([A-Za-z0-9_]+))\s*=\s*\[\s*([\d.eE+-]+)\s*,\s*([\d.eE+-]+)\s*,\s*(\d+)\s*\]$/i);
  if (arrMatch) {
    const paramName = (arrMatch[1] || arrMatch[2]).toUpperCase();
    const minVal = parseFloat(arrMatch[3]);
    const maxVal = parseFloat(arrMatch[4]);
    const stepsVal = parseInt(arrMatch[5], 10);
    upsertParam(step, paramName, {
      mode: 'grid',
      grid: {
        min: minVal,
        max: maxVal,
        steps: stepsVal,
        scale: 'lin',
      },
    });
    return;
  }

  unparsed.push(entryStr);
}

function parseGridValue(step: Step, valStr: string, unparsed: string[]) {
  const trimmed = valStr.trim();
  if (trimmed.startsWith('[')) {
    const items = parseStringOrArrayOfStrings(trimmed);
    for (const item of items) {
      parseGridEntry(step, item, unparsed);
    }
  } else if (trimmed.startsWith('{')) {
    // Legacy inline table { PB = [0.01, 0.2, 20], ... }
    const inner = trimmed.replace(/^\{\s*|\s*\}$/g, '');
    const entries = inner.split(/,(?![^[]*\])/);
    for (const entry of entries) {
      const entryTrimmed = entry.trim();
      if (!entryTrimmed) continue;
      parseGridEntry(step, entryTrimmed, unparsed);
    }
  } else {
    parseGridEntry(step, trimmed, unparsed);
  }
}

function combineMultilineStatements(lines: string[]): string[] {
  const statements: string[] = [];
  let current = '';
  let inBracket = 0;
  let inBrace = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    for (let i = 0; i < trimmed.length; i++) {
      const char = trimmed[i];
      if (char === '[') inBracket++;
      else if (char === ']') inBracket--;
      else if (char === '{') inBrace++;
      else if (char === '}') inBrace--;
    }

    if (current) {
      current += ' ' + trimmed;
    } else {
      current = trimmed;
    }

    if (inBracket <= 0 && inBrace <= 0) {
      statements.push(current);
      current = '';
      inBracket = 0;
      inBrace = 0;
    }
  }

  if (current) {
    statements.push(current);
  }

  return statements;
}

function parseStringOrIdentArray(str: string): string[] {
  // Handles ["PB", "KEX_AB"] or [PB, KEX_AB] or 'PB', etc.
  const cleaned = str.trim().replace(/^\[\s*|\s*\]$/g, '');
  if (!cleaned) return [];
  return splitTopLevelCommas(cleaned)
    .map(s => s.trim().replace(/^["']|["']$/g, '').trim())
    .filter(s => s.length > 0);
}

function parseStringOrArrayOfStrings(str: string): string[] {
  const trimmed = str.trim();
  if (trimmed.startsWith('[')) {
    return parseStringOrIdentArray(trimmed);
  }
  // Single string
  const clean = trimmed.replace(/^["']|["']$/g, '').trim();
  return clean ? [clean] : [];
}
