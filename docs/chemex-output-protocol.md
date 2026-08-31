# ChemEx Output Tree Parsing Protocol

**Protocol Version:** 1.0.0  
**Target ChemEx Version:** 2026.6.1 (Verified against installed release and git commit `fb0e2b92` / `9c1c5b3b`)  
**Specification Status:** Normative Specification  

---

## 1. Scope and Design Principles

This protocol defines the formal grammar, structural discrimination, error recovery, trust state machine, and data models for parsing ChemEx output directories into structured Python objects for resoFlow.

### 1.1 Hard Constraints
1. **Zero Structural Invention:** Every parsing rule, field name, regular expression, and fallback is grounded directly in ChemEx writer source code, official documentation, or verified Phase 0 ground-truth output trees. All rules carry explicit `file:line` citations. Unverifiable behaviors are explicitly labelled `[UNVERIFIED]`.
2. **Total Functions Over Messy Input:** Parsers are pure, total functions over the filesystem. Missing files, truncated rows, malformed headers, or interrupted execution states are normal domain values, not unhandled exceptions. Parsers return structured models accompanied by diagnostic warning logs.
3. **Writer as Ground Truth:** Where ChemEx documentation and emitted files conflict, the emitted files govern. Discrepancies are documented in Section 4.3.
4. **Namespace Separation:** Statistical analyses (Monte Carlo, Bootstrap, MCMC) never mutate or overwrite deterministic fit results or covariance-derived errors. They are maintained in independent namespaces.

---

## 2. Public API Assessment

**Verdict:** ChemEx exposes **NO public or internal API** for reading back its own output trees.

- **Available Reader Functions in ChemEx:**
  - `chemex.configuration.parameters.read_defaults` (`chemex/configuration/parameters.py:52`): Reads input parameter TOML files using `chemex.toml.read_toml`. Discards comments and cannot parse output report files (`fitted.toml`).
  - `chemex.configuration.methods.read_methods` (`chemex/configuration/methods.py:122`): Reads input method TOML files.
  - `chemex.containers.dataset.load_*_dataset` (`chemex/containers/dataset.py:26,48,76`): Reads raw input experiment data files (e.g. `.csv`, `.dat`).
  - `chemex.toml.read_toml` (`chemex/toml.py:20`): Thin wrapper over Python standard `tomllib.load(f)`. Strips all comments, destroying parameter uncertainties.
- **Conclusion:** resoFlow must implement a standalone, conforming reader package (`chemex_output`).

---

## 3. Normative Specification

```
Output Tree Structure:
<output_directory>/
├── run_info/                       # Provenance & Trust Root
│   ├── run.toml                    # Invocation metadata & input mapping (schema_version = 1)
│   ├── outcome.toml                # [Trust Gate] Lifecycle state (schema_version = 2)
│   ├── parameters_used.toml        # Starting independent parameters (Rev 0)
│   ├── restart.toml                # Latest committed continuation checkpoint (optional)
│   └── inputs/                     # Verbatim archived input TOML files
│       ├── experiments/*.toml
│       ├── parameters/*.toml
│       └── methods/*.toml
├── Parameters/                     # [Single-Step Layout] Deterministic Fit Reports
│   ├── fitted.toml                 # Varied parameters with trailing comment ±errors
│   ├── fixed.toml                  # Invariant parameters with # (fixed) comments
│   └── constrained.toml            # Dependent parameters with expressions & ±errors
├── Data/                           # [Single-Step Layout] Non-TOML Tabular Datasets
│   └── <stem>.dat                  # Experimental & back-calculated profiles
├── Plots/                          # [Single-Step Layout] Vector plots & curve files
│   ├── <stem>.pdf
│   ├── <stem>.fit
│   └── <stem>.exp
├── Grid/                           # [Single-Step Layout, Optional] Grid Search Outputs
│   ├── grid.out                    # Tabular chi-square evaluations
│   ├── grid_1d.pdf
│   └── grid_2d.pdf
├── statistics.toml                 # [Single-Step Layout] Global Goodness-of-Fit
├── Statistics/                     # [Single-Step Layout, Optional] Uncertainty Analyses
│   ├── Covariance/                 # Automatic Covariance & Conditioning Evidence
│   │   ├── evidence.json
│   │   ├── blocks.json
│   │   └── status.json
│   ├── Constrained/
│   │   └── evidence.json
│   ├── MonteCarlo/                 # Resampling Replicates
│   │   ├── summary.toml, samples.tsv, correlations.tsv, diagnostics.toml, plots.pdf
│   │   └── failures.tsv (if replicates failed)
│   ├── Bootstrap/
│   ├── BootstrapNS/
│   └── MCMC/                       # MCMC Posterior Sampling
│       ├── summary.toml, samples.tsv, correlations.tsv, diagnostics.toml, plots.pdf
│       └── failures.tsv (if chains failed)
└── <STEP_NAME>/                    # [Multi-Step Layout] Repeated structure per step
    ├── Parameters/
    ├── Data/
    ├── Plots/
    ├── Grid/
    ├── statistics.toml
    └── Statistics/
```

---

### 3.1 Layout Discrimination

**Rule 1.1.1 (Provenance Anchor):** `<output_directory>/run_info/run.toml` is the sole authoritative anchor for run configuration (`chemex/run_info.py:323-369`).

**Rule 1.1.2 (Discrimination Predicate):** (`chemex/optimize/fitting.py:154`)
1. Read `<output_directory>/run_info/run.toml`.
2. Inspect `[[inputs.methods]]` (or archived files in `run_info/inputs/methods/`).
3. If no method files were provided: The run is **Single-Step**. All scientific outputs reside directly in `<output_directory>/`.
4. If method files were provided: Parse the method files to extract the ordered list of step section names $S = [s_1, s_2, ...]$.
   - If $|S| \le 1$ (0 or 1 step, whether named or unnamed): The layout is **Single-Step** directly under `<output_directory>/` (`path_sect = path if len(methods) > 1 else path`, `chemex/optimize/fitting.py:154`).
   - If $|S| > 1$: The layout is **Multi-Step**. Each step $s_i$ corresponds to subdirectory `<output_directory>/<s_i>/`.

**Rule 1.1.3 (Ambiguity and Re-use Resolution):**
If both root-level scientific directories (`Parameters/`, `Data/`) and step directories (`STEP1/`, `STEP2/`) coexist:
- If `run.toml` declares a multi-step method with steps `[STEP1, STEP2]`, only `STEP1/` and `STEP2/` are parsed as authoritative step results. Root-level scientific folders are marked as `STALE_ARTIFACTS` and ignored.
- If `run.toml` declares a single-step run, root-level scientific folders are parsed. Any orphan subdirectories matching step name patterns are marked as `STALE_ARTIFACTS` and ignored.

---

### 3.2 Directories That Must Be Ignored

**Rule 1.2.1 (Group Trees):** Subdirectories named `Groups/` (e.g. `<step>/Groups/<group_name>/`) contain intermediate, component-local fit results when global parameters are fixed (`chemex/optimize/fitting.py:82-122`). These represent execution factoring details. Parsers **MUST IGNORE** `Groups/`.

**Rule 1.2.2 (Aggregate `All/` Tree Handling):** When `len(groups) > 1`, ChemEx writes the aggregate post-fit results to `<step>/All/` (`chemex/optimize/fitting.py:121`, `chemex/optimize/helper.py:168`).
- If `<step>/Parameters/` exists directly at the step level, it takes precedence.
- If `<step>/Parameters/` does not exist but `<step>/All/Parameters/` exists, `<step>/All/` is parsed as the step aggregate.
- Obsolete `All/` trees lingering after a single-group rerun must not override root step parameters.

**Rule 1.2.3 (Component and Scratch Trees):** Any directory named `Components/`, `All/` (when obsolete), or staging paths matching `.run_info-*` (`chemex/run_info.py:345`) are execution scratch spaces and **MUST BE IGNORED**.

---

### 3.3 The Trust Gate: `run_info/outcome.toml`

**Rule 1.3.1 (Schema and Authority):** `run_info/outcome.toml` is the primary trust gate governing presentation. It carries `schema_version = 2` and a status enumeration: `running`, `complete`, `incomplete`.

```toml
schema_version = 2
status = "complete" # "running" | "complete" | "incomplete"
latest_committed_revision = 3
latest_restart_revision = 3
failure_stage = "" # non-empty if incomplete
failure_reason = "" # non-empty if incomplete
```

**Rule 1.3.2 (Status Semantics):**
- `complete`: Written only after every requested method step AND every requested statistical analysis completes successfully. All values are authoritative.
- `running`: Indicates in-progress execution. If the associated Celery task is dead or no output file has been written for \(N \ge 5\) minutes, transition to the distinct UI state `abandoned`.
- `incomplete`: Execution halted due to an exception, signal, or failure. Surfaces `failure_stage` and `failure_reason`.

**Rule 1.3.3 (Provisional Rendering Rule):** If `status != "complete"`, any parsed parameters, statistics, and curves are valid partial evidence but **MUST BE MARKED PROVISIONAL** across all API responses and UI components. They must never be rendered as authoritative results.

**Rule 1.3.4 (Revision Divergence):**
If `latest_committed_revision > latest_restart_revision` (e.g. writer failure during restart checkpointing):
- Display parameter values from the latest in-memory committed revision \(R_{commit}\).
- Display an explicit warning badge: `"Checkpoint out of sync: Restart is at rev R_restart, parameters at rev R_commit"`.
- Disable "Continue from fit" or configure it to continue strictly from \(R_{restart}\).

---

### 3.4 Provenance Ingestion: `run_info/`

**Rule 1.4.1 (`run.toml` Contract):** (`chemex/run_info.py:273-320`)
- `schema_version` (integer): Must be \(\ge 1\).
- `created_at_utc` (string): RFC 3339 / ISO 8601 UTC timestamp (`datetime.fromisoformat`).
- `[run]`: `kind` ("fit" | "simulate"), `working_directory` (string), `output_directory` (string).
- `[chemex]`: `version` (string, e.g. `"2026.6.1"`).
- `[python]`: `version` (string), `platform` (string).
- `[command]`: `arguments` (list of strings representing `sys.argv`).
- `[[inputs.experiments]]`, `[[inputs.parameters]]`, `[[inputs.methods]]`: Array of tables with keys `provided_path`, `resolved_path`, `copied_path`.
- `[git]` (optional): `commit` (string), `branch` (string), `working_tree_dirty` (bool).
- *Extraction Requirement:* Parser extracts ChemEx version, execution platform, and command-line arguments to verify software compatibility and reproducibility.

**Rule 1.4.2 (`parameters_used.toml` Contract):** (`chemex/run_info.py:90-115`)
- Format: Standard TOML where each parameter maps to an array `[value, min, max]` or `[value, min, max, brute_step]`.
- Non-finite numbers are formatted as `nan`, `inf`, `-inf` (`chemex/run_info.py:53-56`).
- *Usage:* Read-only initial state display ("Starting Parameters"). Never updated after fit start.

**Rule 1.4.3 (`restart.toml` Contract):**
- Written atomically as a valid ChemEx parameter file (`-p`).
- Contains latest committed values and bounds.
- *Absence Semantics:* If the fit failed or was killed before the first state-changing commit, `restart.toml` is absent. Absence is a valid state indicating no restart checkpoint exists.

**Rule 1.4.4 (`inputs/` Directory):**
- Contains byte-for-byte copies of original user configuration TOML files in `inputs/experiments/`, `inputs/parameters/`, and `inputs/methods/` (`chemex/run_info.py:164-188`).
- Raw binary/spectral data files are not copied.

---

### 3.5 Parameter Reports: `Parameters/` (`fitted.toml`, `fixed.toml`, `constrained.toml`)

**Rule 1.5.1 (Comment Preservation & TOML Invalidation):**
ChemEx writes parameter uncertainties and constraint expressions exclusively inside trailing comments (`chemex/printers/parameters.py:34-56`). Standard TOML parsers discard comments. The parser **MUST NOT** use a standard TOML parser alone; it must use a comment-preserving line parser.

**Rule 1.5.2 (Section & Key Quoting Grammar):** (`chemex/printers/parameters.py:100-115`)
- Section Header: `^\[(?P<section>[^\]]+)\]$`
  - Section names matching `^[A-Za-z0-9_-]+$` are unquoted: `[GLOBAL]`, `[CS_A]`.
  - Complex section names are double-quoted: `["R1_A, B0->500.0MHZ"]`, `["R2_A, B0->800.0MHZ"]`.
- Parameter Key:
  - Simple alphanumeric keys are unquoted: `KEX_AB = ...`, `15N = ...`.
  - Complex keys are double-quoted: `"15N" = ...`.

**Rule 1.5.3 (Parameter Value & Comment Grammar):**
Each line follows: `^\s*(?P<key>"?[^"=]+"??)\s*=\s*(?P<value>[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?|nan|inf|-inf)\s*(?:#\s*(?P<comment>.*))?$`

**Grammar for `<comment>`:**
1. **Fitted Parameter (`fitted.toml`):** (`chemex/printers/parameters.py:34-36`)
   - Calculated Error: `±(?P<stderr>[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)`
   - Uncalculated Error: `\(error not calculated\)` \(	o\) `stderr = None`, `reason = "NOT_CALCULATED"`.
2. **Fixed Parameter (`fixed.toml`):** (`chemex/printers/parameters.py:54-56`)
   - Fixed tag: `\(fixed\)` \(	o\) `is_fixed = True`, `stderr = None`.
3. **Constrained Parameter (`constrained.toml`):** (`chemex/printers/parameters.py:39-52`)
   - With Propagated Error: `±(?P<stderr>[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)\s+\((?P<expression>.*)\)`
   - Without Error: `\((?P<expression>.*)\)` \(	o\) `stderr = None`.

**Rule 1.5.4 (Error Scale Invariant):** ChemEx derives parameter errors directly from the covariance matrix treating observation errors as absolute standard deviations (`chemex/printers/parameters.py:35`). ChemEx **DOES NOT** multiply covariance by reduced chi-square. resoFlow **MUST NOT** rescale standard errors by \(\sqrt{\chi^2_{red}}\). Reduced chi-square is strictly a goodness-of-fit diagnostic.

**Rule 1.5.5 (Boundary Warnings):** If a fitted parameter's value is within boundary tolerance (\(|v - v_{bound}| \le 3 \cdot 	ext{stderr}\) or near hard bounds), flag `near_boundary = True`.

**Rule 1.5.6 (Parameter Key Canonicalization):**
- Raw key format: `[<BASE_NAME>]` or `[<BASE_NAME>, NUC-><SCOPE>]` or `[<BASE_NAME>, NUC-><SCOPE>, B0-><FIELD>]`
- Canonical form: `(name, scope, field)` where scope defaults to 'global'
- Scope normalization: `32` → `32N`, `C14N` → `14N`, `14N` → `14N`
- Exchange parameters (`KEX_AB`, `PB`, etc.) in per-group runs have group-local scope but represent the same physical quantity as a global parameter when groups share the parameter

---

### 3.6 Experimental & Fitted Data: `Data/`

**Rule 1.6.1 (Format Contract):** (`chemex/printers/data.py:38-163`, `chemex/containers/experiments.py:165-179`)
Data files (`Data/<profile_stem>.dat`) are **NOT valid TOML**. They are multi-section whitespace-delimited tabular text files.

**Rule 1.6.2 (File Grammar):**
```
DataFile    := Section+
Section     := SectionHeader '
' HeaderRow '
' DataRow* '
'*
SectionHeader := '[' ProfileName ']'
HeaderRow   := '#' ColumnHeader+
DataRow     := ActiveRow | MaskedRow
ActiveRow   := ' ' NumericValue+
MaskedRow   := '#' NumericValue+ '# NOT USED IN THE FIT'
```

**Rule 1.6.3 (Dynamic Header Reading):**
Column names vary by experiment type. The parser **MUST** extract column names from `HeaderRow` by stripping the leading `#` and splitting on whitespace.
- *CPMG:* `NCYC`, `INTENSITY (EXP)`, `ERROR (EXP)`, `INTENSITY (CALC)` (`chemex/printers/data.py:95-98`)
- *CEST:* `OFFSET (HZ)`, `INTENSITY (EXP)`, `ERROR (EXP)`, `INTENSITY (CALC)` (`chemex/printers/data.py:90-93`)
- *Relaxation:* `TIME (S)`, `INTENSITY (EXP)`, `ERROR (EXP)`, `INTENSITY (CALC)` (`chemex/printers/data.py:101-104`)
- *EXSY:* `TIME (S)`, `STATE1`, `STATE2`, `INTENSITY (EXP)`, `ERROR (EXP)`, `INTENSITY (CALC)` (`chemex/printers/data.py:108-163`)
- *Chemical Shift:* `NAME`, `SHIFT (EXP)`, `ERROR (EXP)`, `SHIFT (CALC)` (`chemex/printers/data.py:17-36`)

**Rule 1.6.4 (Masking and Missing Values):**
- If a row begins with `#` and ends with `# NOT USED IN THE FIT`, the point is recorded with `mask = False` (inactive/filtered) (`chemex/printers/data.py:69-70`).
- If a row begins with `' '`, `mask = True` (active in fit).
- Non-finite tokens (`nan`, `inf`, `--`) parse to `float("nan")` without raising exceptions.

---

### 3.7 Grid Search Outputs: `Grid/`

**Rule 1.7.1 (`grid.out` Contract):** (`chemex/optimize/gridding.py:65-86`, `chemex/optimize/helper.py:174-187`)
- Header: `# <PARAM_1> <PARAM_2> ... [χ²]
` (Parameter names enclosed in brackets, e.g. `[PB] [KEX_AB] [χ²]`).
- Data Rows: `^\s*(?P<values>(?:[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?\s+)+)(?P<chisqr>[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)$`
- Parser extracts the list of evaluated parameter names and the grid matrix \((v_1, v_2, \dots, \chi^2)\).

**Rule 1.7.2 (Grid Plots):** `Grid/grid_1d.pdf` and `Grid/grid_2d.pdf` (`chemex/optimize/gridding.py:185-254`) are catalogued and linked for display.

**Rule 1.7.3 (Differential Evolution Initializer):** Differential Evolution (DE) is an initializer for a standard fit (`chemex/optimize/minimizer.py:93`). It emits no independent `Grid/` or `DE/` folder; its result is reflected in ordinary `Parameters/` and `statistics.toml`.

---

### 3.8 Global Goodness-of-Fit: `statistics.toml`

**Rule 1.8.1 (Key Mapping Contract):** (`chemex/optimize/helper.py:59-78`)
`statistics.toml` uses quoted human-readable string keys. The parser maps these to stable internal model fields:

| Emitted TOML Key | Target Model Field | Type | Format |
|---|---|---|---|
| `"number of data points"` | `ndata` | `int` | Integer |
| `"number of variables"` | `nparams` / `nvarys` | `int` | Integer |
| `"chi-square"` | `chisqr` | `float` | Scientific (`.5e`) |
| `"reduced-chi-square"` | `redchi` | `float` | Scientific (`.5e`) |
| `"chi-squared test"` | `pvalue` | `float` | Scientific (`.5e`) |
| `"Kolmogorov-Smirnov test"` | `ks_pvalue` | `float` | Scientific (`.5e`) |
| `"Akaike Information Criterion (AIC)"` | `aic` | `float` | Scientific (`.5e`) |
| `"Bayesian Information Criterion (BIC)"` | `bic` | `float` | Scientific (`.5e`) |

**Rule 1.8.2 (Unknown Keys Policy):** Any unrecognized key in `statistics.toml` is retained in an `extra: dict[str, Any]` map to ensure forward compatibility.

---

### 3.9 Uncertainty Analyses: `Statistics/`

#### 3.9.1 Automatic Covariance Diagnostics
- `Statistics/Covariance/evidence.json` (`chemex/optimize/uncertainty.py:2541-2547`):
  - Carries `artifact_type = "native_uncertainty_evidence_bundle"`, `schema_version = 1`.
  - Contains Jacobian SVD spectrum, condition number, parameter ordering, covariance matrix, correlation matrix, marginal errors, and boundary flags.
  - *Condition Number Interpretation:* A large condition number is a diagnostic of weak modes / parameter correlation, **NOT** a hard failure gate.
- `Statistics/Constrained/evidence.json`: Constrained propagation Jacobian and propagated error evidence.
- `Statistics/Covariance/blocks.json`: Independent block decompositions for multi-group fits.
- `Statistics/Covariance/status.json`: Written if uncertainty derivation was interrupted after the deterministic fit committed.

#### 3.9.2 Resampling & MCMC Analysis (`MonteCarlo/`, `Bootstrap/`, `BootstrapNS/`, `MCMC/`)

**Rule 3.9.2.1 (Completeness State Machine):**
1. **`COMPLETE`:** `summary.toml`, `samples.tsv`, `correlations.tsv`, `diagnostics.toml`, and `plots.pdf` all exist, and in `diagnostics.toml`, `completed_samples == requested_samples`.
2. **`INCOMPLETE` / `PARTIAL`:**
   - `completed_samples < requested_samples` in `diagnostics.toml`, OR
   - Process interrupted: `samples.tsv` contains available rows, `summary.toml` has `sample_count = 0` or is absent, `correlations.tsv` contains `nan` values, `failures.tsv` exists.
   - *State Validity:* `samples.tsv` present without `summary.toml` is a **VALID, MEANINGFUL PARTIAL STATE**. It is parsed and surfaced as `"Partial samples available; no authoritative summary"`.

**Rule 3.9.2.2 (Summary Field Contracts):**
- **Resampling (`MonteCarlo`, `Bootstrap`, `BootstrapNS`):** (`chemex/optimize/resampling.py:161-200`)
  - Section: `[<param_name>]`
  - `interval = "95% percentile"`
  - `sample_count` (int)
  - `mean`, `standard_deviation` (ddof=1 for \(N>1\)), `median`
  - `percentile_95_lower`, `percentile_95_upper` (2.5% and 97.5% quantiles)
  - `lower_1sigma`, `upper_1sigma` (15.87% and 84.13% quantiles)
  - `stderr = 0.5 * (upper_1sigma - lower_1sigma)`
- **MCMC (`MCMC`):** (`chemex/optimize/mcmc.py:608-644`)
  - Section: `[<param_name>]`
  - `prior = "uniform"`, `prior_lower` (float), `prior_upper` (float)
  - `credible_interval = "95% equal-tailed"`
  - `mean`, `standard_deviation`, `median`
  - `eti_95_lower`, `eti_95_upper` (Equal-Tailed Interval bounds)
  - `lower_1sigma`, `upper_1sigma`
  - `stderr = 0.5 * (upper_1sigma - lower_1sigma)`
  - `effective_sample_size` (optional float)
  - `mcse_mean` (optional float): Monte Carlo Standard Error of the estimated posterior mean. **CRITICAL:** `mcse_mean` is the standard error of the mean estimate, **NOT** an interval width. resoFlow UI must never conflate `mcse_mean` with `stderr`.

**Rule 3.9.2.3 (Diagnostics Field Contracts):**
- **Resampling Diagnostics:** (`chemex/optimize/resampling.py:237-260`)
  - `method`, `fitmethod`, `requested_samples` (int), `completed_samples` (int), `workers` (int), `parameters` (list of str), `samples_file`, `summary_file`, `correlations_file`, `plots_file`.
- **MCMC Diagnostics:** (`chemex/optimize/mcmc.py:678-725`)
  - `sampler = "emcee via ChemEx direct EnsembleSampler"`
  - `lmfit_version`, `emcee_version`
  - `autocorrelation_status` (`"converged"`, `"unreliable_short_chain"`, etc.)
  - `steps`, `requested_burn`, `discarded_steps`, `thin`, `walkers`, `workers`, `retained_steps`, `retained_samples`
  - `acceptance_fraction_mean`, `acceptance_fraction_min`, `acceptance_fraction_max`
  - `unbounded_parameters` (list of str)
  - Timings: `sampling_seconds`, `result_processing_seconds`, `output_summary_seconds`, `output_samples_seconds`, `output_correlations_seconds`, `output_plots_seconds`, `output_total_seconds`, `total_seconds`.
  - *Worker Verification:* Surface `workers` prominently to verify `--workers` enforcement on shared queues.

#### 3.9.3 Statistics Discovery Protocol

**Rule 3.9.3.1 (Valid Statistics/ Locations):**
- Single-step: `<output>/Statistics/`
- Multi-step: `<output>/<STEP_NAME>/Statistics/`
- Group-scoped: `<output>/Groups/<group_name>/Statistics/`
- Groups-within-steps: `<output>/<STEP_NAME>/Groups/<group_name>/Statistics/` (if applicable)

**Rule 3.9.3.2 (Discovery Algorithm):**
1. Start from `<output_directory>/`
2. If multi-step layout: iterate step directories, check `<STEP>/Statistics/` and `<STEP>/Groups/<group>/Statistics/`
3. If single-step layout with Groups: iterate `Groups/<group>/Statistics/`
4. If single-step layout without Groups: check `Statistics/` directly
5. Deduplicate by content hash of sample arrays

**Rule 3.9.3.3 (Sample File Format Contract):**
- TSV with bracket-enclosed parameter names as header
- Last column may be `chisqr` (not a parameter)
- Rows are replicate samples
- NaN values are valid (filtered during analysis)

**Rule 3.9.3.4 (Deduplication Rule):**
If the same Statistics directory is reachable via multiple paths (e.g., primary step insert and child iteration), deduplicate by computing SHA-256 of the `samples.tsv` file content. Keep the more specific label (e.g., `MONTECARLO_STEP2` over bare `MONTECARLO`).

---

### 3.10 Directory Reuse Semantics

**Rule 1.10.1 (Selective Clearing):**
When running into an existing output directory, ChemEx clears `Parameters/`, `Data/`, `Plots/`, `Grid/`, `Statistics/`, and `statistics.toml` for every planned step before execution starts (`chemex/run_info.py:342-369`).
- `run_info/` is replaced atomically via directory rename staging (`_replace_run_info`).
- resoFlow sidecar files (e.g. `resoFlow_job.json`) in the output root are **NOT cleared** by ChemEx.

**Rule 1.10.2 (Consequences for Freshness):**
- File `mtime` is **NOT a reliable freshness signal** across runs.
- Orphan subdirectories from previous multi-step runs survive if the subsequent run has fewer steps or is single-step. The layout discrimination predicate (Section 3.1) guarantees that stale directories are ignored.

---

### 3.11 Versioning and Extensibility

**Rule 1.11.1 (Protocol Version):** This protocol is Version 1.0.0.
**Rule 1.11.2 (ChemEx Compatibility Gate):** Verified against ChemEx 2026.6.1 (`chemex --version`). If `run.toml` reports an unknown ChemEx version or `outcome.toml` contains `schema_version > 2`:
- The parser logs a `StructuredWarning(code="UNKNOWN_SCHEMA_VERSION")`.
- Parsers parse all standard known keys, collect unknown keys in `extra`, and continue without crashing.

---

### 3.12 Residue-Level Extraction and resoFlow-Derived Quantities

**Rule 1.12.1 (Canonical Residue Key Grammar):**
ChemEx writes residue/nucleus identifiers in sections (`[CS_A]`, `[DW_AB]`, `["R2_A, B0->..."]`) and data files (`[<res_key>]`). Observed forms:
- Nucleus suffix: `13N`, `15N`, `20N`, `108N`
- Coupled spin-system suffix: `13N-HN`, `20N-HN`, `32N-H`, `5CA-HA`
- Amino acid prefix: `G13N`, `GLY13N`, `ALA15N`
- Bare integer: `13`, `20`, `45`
- Cluster identifiers: `13N,15N`

*Total Parser Rule:* Attempt canonical normalization using regex `^(?:[A-Za-z]{1,4})?(\d+)(?:[-_A-Za-z0-9]+)?$`. On match, extract residue integer and canonical label. If unmatched, retain the raw string verbatim and flag `is_unrecognized = True` without dropping the row.

**Rule 1.12.2 (Per-Residue Parameter Aggregation):**
For each discovered residue key, aggregate parameters across all sections in `fitted.toml`, `fixed.toml`, and `constrained.toml` into `StepResidueModel.parameters`.

**Rule 1.12.3 (Per-Residue $\chi^2$ resoFlow-Derived Quantity):**
ChemEx publishes goodness-of-fit in `statistics.toml` strictly at the aggregate step level; it **does NOT publish per-residue $\chi^2$**.
resoFlow derives per-residue $\chi^2$ directly from `Data/*.dat` as:
$$\chi^2_{res} = \sum_{f \in \text{DataFiles}} \sum_{p \in \text{ActivePoints}(f, res)} \left(\frac{y_{\text{exp}} - y_{\text{calc}}}{\sigma_{\text{exp}}}\right)^2$$
- Masked points (`# NOT USED IN THE FIT`) and points with $\sigma_{\text{exp}} \le 0$ are excluded.
- **Normative Labeling:** In both API models and UI presentations, this value is explicitly labeled **`resoFlow-derived from Data/ residuals`**.

**Rule 1.12.4 (Per-Residue Reduced $\chi^2$ Degrees of Freedom Convention):**
To normalize per-residue $\chi^2$ under global fitting, resoFlow adopts the local degrees of freedom convention:
$$\nu_{res} = \max(N_{\text{data}, res} - N_{\text{varys}, res}, 1)$$
$$\chi^2_{\text{red}, res} = \frac{\chi^2_{res}}{\nu_{res}}$$
where $N_{\text{data}, res}$ is the count of active points for residue $res$, and $N_{\text{varys}, res}$ is the number of varied parameters in `fitted.toml` belonging to residue $res$.
- **Named Constant:** Coded as `PER_RESIDUE_DOF_CONVENTION = "NDATA_MINUS_LOCAL_NVARYS"`.
- **UI Tooltip:** The UI must display an explanatory tooltip detailing the exact formula $\chi^2 / (N_{\text{data}} - N_{\text{varys, local}})$.

---

### 3.13 Step-Aware Results Model & Navigation State Machine

**Rule 1.13.1 (Step Ordering Invariant):**
The ordered list of steps in `RunResult.step_order` MUST preserve execution order as declared in `run_info/inputs/methods/method.toml` (e.g. `STEP1` $\to$ `STEP2` $\to$ `STEP10`), never relying on lexicographical filesystem sorting.

**Rule 1.13.2 (Step Lifecycle Status):**
Each step in `RunResult.steps` carries a distinct `status`:
- `"complete"`: `Parameters/`, `statistics.toml`, and/or `Statistics/` successfully written.
- `"partial"`: Step directory created but execution was interrupted before all outputs completed.
- `"missing"`: Step was declared in `method.toml` but directory was never created on disk.

**Rule 1.13.3 (UI Navigation & Selection):**
- **Default Selection:** The Results view MUST default to the **LAST** declared step ($s_n$), which contains the final scientific result.
- **Single-Step Concealment:** For single-step runs ($|S| \le 1$), the step dropdown MUST be hidden entirely.
- **Deep-Linking:** The selected step is stored in the URL query string (`?step=<step_name>`) for shareable, persistent state across page reloads.
- **Missing Step View:** Selecting a missing or partial step renders an informative empty state explaining the halted stage rather than a blank or broken page.

---

## 4. Ground Truth Verification Citations & Evidence

### 4.1 Writer Source Code Citations
- **`run_info/` Writer:** `chemex/run_info.py:264-369` (`_serialize_run`, `_serialize_parameters`, `write_run_info`, `_replace_run_info`).
- **`Parameters/` Writer:** `chemex/printers/parameters.py:34-195` (`_format_fitted`, `_format_fixed`, `_format_constrained`, `_format_strings`, `write_parameters`).
- **`Data/` Writer:** `chemex/printers/data.py:38-163` (`ProfilePrinter`, `CestPrinter`, `CpmgPrinter`, `RelaxationPrinter`, `EXSYPrinter`, `ShiftPrinter`), `chemex/containers/experiments.py:165-179` (`Experiments.write`).
- **`statistics.toml` Writer:** `chemex/optimize/helper.py:59-78` (`_write_statistics`, `calculate_statistics`).
- **`Grid/` Writer:** `chemex/optimize/gridding.py:47-94,185-254` (`run_group_grid`, `plot_grid_1d`, `plot_grid_2d`), `chemex/optimize/helper.py:174-187` (`print_header`, `print_values`).
- **`Statistics/` Resampling Writer:** `chemex/optimize/resampling.py:161-348` (`_write_resampling_summary`, `_write_resampling_correlations`, `_write_resampling_diagnostics`, `_run_resampling_method`).
- **`Statistics/MCMC` Writer:** `chemex/optimize/mcmc.py:608-760` (`_write_summary`, `_write_samples`, `_write_correlations`, `_write_diagnostics`, `write_mcmc_outputs`).
- **`Statistics/Covariance` Evidence Writer:** `chemex/optimize/uncertainty.py:2541-2547,5596-5850` (`to_record`, `derive_uncertainty_evidence`).

---

### 4.2 Phase 0 Ground Truth Artifact Samples

#### Sample 1: `Parameters/fitted.toml` (from `backend/tests/fixtures/chemex_trees/single_step/Parameters/fitted.toml`)
```toml
[GLOBAL]
KEX_AB =  3.77303e+02 # ±1.59730e+01
PB     =  6.67200e-02 # ±1.67100e-03

[DW_AB]
15N =  2.08912e+00 # ±3.43175e-02

["R2_A, B0->500.0MHZ"]
15N =  3.95488e+00 # ±1.69853e-01

["R2_A, B0->800.0MHZ"]
15N =  6.36914e+00 # ±3.25464e-01
```

#### Sample 2: `Parameters/constrained.toml` (from `backend/tests/fixtures/chemex_trees/single_step/Parameters/constrained.toml`)
```toml
[GLOBAL]
KAB =  2.51736e+01 # ±7.89977e-01 ([KEX_AB] * [PB])
KBA =  3.52129e+02 # ±1.53409e+01 ([KEX_AB] * [PA])
PA  =  9.33280e-01 # ±1.67100e-03 (1.0 - [PB])

[CS_B]
15N =  1.21938e+02 # ±3.43175e-02 ([CS_A, NUC->15N] + [DW_AB, NUC->15N])

["R1_B, B0->500.0MHZ"]
15N =  2.62465e+00 # ([R1_A, NUC->15N, B0->500.0MHZ])
```

#### Sample 3: `Data/500mhz.dat` (from `backend/tests/fixtures/chemex_trees/single_step/Data/500mhz.dat`)
```
[15N]
#         NCYC   INTENSITY (EXP)       ERROR (EXP)  INTENSITY (CALC)
             0    3.47059800e+04    1.45930401e+02    3.47064601e+04 
            30    3.05930380e+04    1.45930401e+02    3.06347283e+04 
             1    1.81234230e+04    1.45930401e+02    1.82708770e+04 
```

#### Sample 4: `Grid/grid.out` (from `backend/tests/fixtures/chemex_trees/grid_fit/Grid/grid.out`)
```
# [PB] [KEX_AB] [χ²]
  5.00000e-02 3.00000e+02 8.91123e+02
  5.00000e-02 4.00000e+02 3.03516e+02
  5.00000e-02 5.00000e+02 1.86201e+02
```

#### Sample 5: `Statistics/MCMC/summary.toml` (from `backend/tests/fixtures/chemex_trees/stat_fit/Statistics/MCMC/summary.toml`)
```toml
["DW_AB, NUC->15N"]
prior = "uniform"
prior_lower = -1.00000e+02
prior_upper = 1.00000e+02
credible_interval = "95% equal-tailed"
mean = 2.09569e+00
standard_deviation = 3.71555e-02
median = 2.09344e+00
eti_95_lower = 2.03485e+00
eti_95_upper = 2.17114e+00
lower_1sigma = 2.05686e+00
upper_1sigma = 2.13444e+00
stderr = 3.87857e-02

["KEX_AB"]
prior = "uniform"
prior_lower = 0.00000e+00
prior_upper = inf
credible_interval = "95% equal-tailed"
mean = 3.77288e+02
standard_deviation = 5.27758e+00
median = 3.77723e+02
eti_95_lower = 3.65941e+02
eti_95_upper = 3.88381e+02
lower_1sigma = 3.73055e+02
upper_1sigma = 3.81298e+02
stderr = 4.12149e+00
```

#### Sample 6: Interrupted Statistics (from `backend/tests/fixtures/chemex_trees/stat_interrupted/Statistics/MonteCarlo/diagnostics.toml` and `summary.toml`)
```toml
# diagnostics.toml
method = "Monte Carlo"
fitmethod = "leastsq"
requested_samples = 100
completed_samples = 0
workers = 8
parameters = ["__DW_AB_15N", "__KEX_AB", "__PB", "__R2_A_15N_500_0MHZ", "__R2_A_15N_800_0MHZ"]
samples_file = "samples.tsv"
summary_file = "summary.toml"
correlations_file = "correlations.tsv"
plots_file = "plots.pdf"

# summary.toml
["DW_AB, NUC->15N"]
interval = "95% percentile"
sample_count = 0
```

---

### 4.3 Documentation vs Writer Reality Discrepancies

| Item | Documentation (`outputs.mdx`) | Writer Ground Truth & Emitted Files | Upstream Issue Assessment |
|---|---|---|---|
| **Plot Directory Name** | `Plot/` (singular heading in `outputs.mdx:106`) | `Plots/` (plural, created at `chemex/optimize/helper.py:109`) | Documentation typo in ChemEx docs |
| **Data File Format** | Displayed in `toml` codeblock (`outputs.mdx:126`) | Non-TOML tabular text with commented header (`chemex/printers/data.py:50-86`) | Documentation misleading syntax highlighting |
| **`statistics.toml` Keys** | Lists 5 keys omitting hypothesis tests (`outputs.mdx:137-142`) | Writes 8 keys including `"chi-squared test"`, `"Kolmogorov-Smirnov test"`, `"Bayesian Information Criterion (BIC)"` (`chemex/optimize/helper.py:68-77`) | Documentation omits statistical tests |
| **MCMC Summary Prior Fields** | Omits prior bounds documentation | Emits `prior = "uniform"`, `prior_lower`, `prior_upper` per parameter section (`chemex/optimize/mcmc.py:621-623`) | Incomplete documentation of MCMC summary format |
| **Directory Re-use Leftovers** | Not documented | Step folders from prior multi-step runs linger on disk if subsequent run is single-step | Important edge case for wrapper GUIs |
