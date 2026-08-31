"""
Data models for the ChemEx output parsing protocol conforming to docs/chemex-output-protocol.md.
All models are pure, serializable Pydantic / dataclass definitions with optional-with-reason error tracking.
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any, Optional
from pydantic import BaseModel, ConfigDict, Field


class RunState(StrEnum):
    COMPLETE = "complete"
    RUNNING = "running"
    INCOMPLETE = "incomplete"
    ABANDONED = "abandoned"
    UNKNOWN = "unknown"


class StructuredWarning(BaseModel):
    model_config = ConfigDict(extra="ignore")
    code: str
    message: str
    path: Optional[str] = None
    details: Optional[dict[str, Any]] = None


class OutcomeModel(BaseModel):
    model_config = ConfigDict(extra="ignore")
    schema_version: int = 2
    status: RunState = RunState.UNKNOWN
    latest_committed_revision: Optional[int] = None
    latest_restart_revision: Optional[int] = None
    failure_stage: Optional[str] = None
    failure_reason: Optional[str] = None
    is_provisional: bool = False
    raw: dict[str, Any] = Field(default_factory=dict)


class InputFileRef(BaseModel):
    model_config = ConfigDict(extra="ignore")
    category: str
    provided_path: str
    resolved_path: str
    copied_path: str


class GitMetadata(BaseModel):
    model_config = ConfigDict(extra="ignore")
    commit: Optional[str] = None
    branch: Optional[str] = None
    working_tree_dirty: Optional[bool] = None


class ProvenanceModel(BaseModel):
    model_config = ConfigDict(extra="ignore")
    schema_version: int = 1
    created_at_utc: Optional[datetime] = None
    kind: str = "fit"
    working_directory: Optional[str] = None
    output_directory: Optional[str] = None
    chemex_version: Optional[str] = None
    python_version: Optional[str] = None
    python_platform: Optional[str] = None
    arguments: list[str] = Field(default_factory=list)
    inputs: list[InputFileRef] = Field(default_factory=list)
    git: Optional[GitMetadata] = None
    root_seeds: dict[str, int] = Field(default_factory=dict)


class StartingParameter(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str
    section: str
    key: str
    value: Optional[float] = None
    min_val: Optional[float] = None
    max_val: Optional[float] = None
    brute_step: Optional[float] = None


class UncertaintyValue(BaseModel):
    """
    Model representing a scientific coordinate value with optional-with-reason uncertainty.
    ChemEx writes errors as absolute standard deviations from covariance without chi2_red scaling.
    """
    model_config = ConfigDict(extra="ignore")
    name: str
    section: str
    key: str
    value: Optional[float] = None
    stderr: Optional[float] = None
    has_stderr: bool = False
    error_reason: Optional[str] = None
    expression: Optional[str] = None
    is_fixed: bool = False
    is_constrained: bool = False
    is_derived: bool = False
    near_boundary: bool = False


class ParameterReportModel(BaseModel):
    model_config = ConfigDict(extra="ignore")
    fitted: dict[str, dict[str, UncertaintyValue]] = Field(default_factory=dict)
    fixed: dict[str, dict[str, UncertaintyValue]] = Field(default_factory=dict)
    constrained: dict[str, dict[str, UncertaintyValue]] = Field(default_factory=dict)

    def get_all_parameters(self) -> dict[str, UncertaintyValue]:
        result: dict[str, UncertaintyValue] = {}
        for group in (self.fitted, self.fixed, self.constrained):
            for section, params in group.items():
                for key, param in params.items():
                    result[param.name] = param
        return result

    def get_global_parameters(self) -> dict[str, UncertaintyValue]:
        result: dict[str, UncertaintyValue] = {}
        for group in (self.fitted, self.fixed, self.constrained):
            if "GLOBAL" in group:
                for key, param in group["GLOBAL"].items():
                    result[key] = param
        return result

    def get_residue_parameters(self, residue: str) -> dict[str, UncertaintyValue]:
        res = str(residue).upper().strip()
        result: dict[str, UncertaintyValue] = {}
        for group in (self.fitted, self.fixed, self.constrained):
            for section, params in group.items():
                if section == "GLOBAL":
                    continue
                for key, param in params.items():
                    if key.upper().strip() == res or f"{res}N" == key.upper().strip() or key.upper().startswith(res):
                        result[section] = param
        return result


class DataPointModel(BaseModel):
    model_config = ConfigDict(extra="ignore")
    metadata: dict[str, Any] = Field(default_factory=dict)
    exp: Optional[float] = None
    err: Optional[float] = None
    calc: Optional[float] = None
    mask: bool = True  # True: active in fit, False: # NOT USED IN THE FIT


class DataProfileModel(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str
    columns: list[str] = Field(default_factory=list)
    points: list[DataPointModel] = Field(default_factory=list)


class DataFileModel(BaseModel):
    model_config = ConfigDict(extra="ignore")
    stem: str
    profiles: dict[str, DataProfileModel] = Field(default_factory=dict)


class GoodnessOfFitModel(BaseModel):
    model_config = ConfigDict(extra="ignore")
    ndata: Optional[int] = None
    nvarys: Optional[int] = None
    chisqr: Optional[float] = None
    redchi: Optional[float] = None
    pvalue: Optional[float] = None
    ks_pvalue: Optional[float] = None
    aic: Optional[float] = None
    bic: Optional[float] = None
    extra: dict[str, Any] = Field(default_factory=dict)


class GridGroupInfo(BaseModel):
    model_config = ConfigDict(extra="ignore")
    raw_key: str
    residue: str
    display_name: str
    file_path: Optional[str] = None


class GridSpecModel(BaseModel):
    model_config = ConfigDict(extra="ignore")
    parameter: str
    scale: str = "lin"
    min_val: float
    max_val: float
    num_points: int


class GridPointModel(BaseModel):
    model_config = ConfigDict(extra="ignore")
    values: dict[str, float] = Field(default_factory=dict)
    chisqr: float


class GridResultModel(BaseModel):
    model_config = ConfigDict(extra="ignore")
    has_grid: bool = True
    parameters: list[str] = Field(default_factory=list)
    specs: dict[str, GridSpecModel] = Field(default_factory=dict)
    groups: list[GridGroupInfo] = Field(default_factory=list)
    points: list[GridPointModel] = Field(default_factory=list)
    best_point: Optional[GridPointModel] = None
    grid_1d_pdf: Optional[str] = None
    grid_2d_pdf: Optional[str] = None
    output_files: list[str] = Field(default_factory=list)


class ResamplingParameterSummary(BaseModel):
    model_config = ConfigDict(extra="ignore")
    parameter_name: str
    interval: str = "95% percentile"
    sample_count: int = 0
    mean: Optional[float] = None
    standard_deviation: Optional[float] = None
    std_dev: Optional[float] = None
    std: Optional[float] = None
    sem: Optional[float] = None
    median: Optional[float] = None
    percentile_95_lower: Optional[float] = None
    percentile_95_upper: Optional[float] = None
    interval_95_lower: Optional[float] = None
    interval_95_upper: Optional[float] = None
    eti_95_lower: Optional[float] = None
    eti_95_upper: Optional[float] = None
    lower_1sigma: Optional[float] = None
    upper_1sigma: Optional[float] = None
    stderr: Optional[float] = None
    skew: Optional[float] = None
    asymmetric_lower: Optional[float] = None
    asymmetric_upper: Optional[float] = None
    is_skewed: Optional[bool] = False
    deterministic_value: Optional[float] = None
    bias: Optional[float] = None


class McmcParameterSummary(BaseModel):
    model_config = ConfigDict(extra="ignore")
    parameter_name: str
    prior: str = "uniform"
    prior_lower: Optional[float] = None
    prior_upper: Optional[float] = None
    credible_interval: str = "95% equal-tailed"
    mean: Optional[float] = None
    standard_deviation: Optional[float] = None
    std_dev: Optional[float] = None
    std: Optional[float] = None
    sem: Optional[float] = None
    median: Optional[float] = None
    eti_95_lower: Optional[float] = None
    eti_95_upper: Optional[float] = None
    percentile_95_lower: Optional[float] = None
    percentile_95_upper: Optional[float] = None
    interval_95_lower: Optional[float] = None
    interval_95_upper: Optional[float] = None
    lower_1sigma: Optional[float] = None
    upper_1sigma: Optional[float] = None
    stderr: Optional[float] = None
    skew: Optional[float] = None
    asymmetric_lower: Optional[float] = None
    asymmetric_upper: Optional[float] = None
    is_skewed: Optional[bool] = False
    deterministic_value: Optional[float] = None
    bias: Optional[float] = None
    effective_sample_size: Optional[float] = None
    mcse_mean: Optional[float] = None
    rhat: Optional[float] = None


class ResamplingDiagnostics(BaseModel):
    model_config = ConfigDict(extra="ignore")
    method: Optional[str] = None
    fitmethod: Optional[str] = None
    requested_samples: Optional[int] = None
    completed_samples: Optional[int] = None
    workers: Optional[int] = None
    parameters: list[str] = Field(default_factory=list)
    samples_file: Optional[str] = None
    summary_file: Optional[str] = None
    correlations_file: Optional[str] = None
    plots_file: Optional[str] = None
    extra: dict[str, Any] = Field(default_factory=dict)


class McmcDiagnostics(BaseModel):
    model_config = ConfigDict(extra="ignore")
    sampler: Optional[str] = None
    lmfit_version: Optional[str] = None
    emcee_version: Optional[str] = None
    autocorrelation_status: Optional[str] = None
    steps: Optional[int] = None
    requested_burn: Optional[Any] = None
    discarded_steps: Optional[int] = None
    thin: Optional[int] = None
    walkers: Optional[int] = None
    workers: Optional[int] = None
    retained_steps: Optional[int] = None
    retained_samples: Optional[int] = None
    acceptance_fraction_mean: Optional[float] = None
    acceptance_fraction_min: Optional[float] = None
    acceptance_fraction_max: Optional[float] = None
    unbounded_parameters: list[str] = Field(default_factory=list)
    burn_in_warning: Optional[str] = None
    autocorrelation_warning: Optional[str] = None
    timings: dict[str, float] = Field(default_factory=dict)
    extra: dict[str, Any] = Field(default_factory=dict)


class ResamplingResultModel(BaseModel):
    model_config = ConfigDict(extra="ignore")
    method_type: str  # "MonteCarlo" | "Bootstrap" | "BootstrapNS"
    status: str = "complete"  # "complete" | "incomplete" | "empty"
    summary: dict[str, ResamplingParameterSummary] = Field(default_factory=dict)
    sample_parameters: list[str] = Field(default_factory=list)
    samples: list[list[float]] = Field(default_factory=list)
    correlations: dict[str, dict[str, float]] = Field(default_factory=dict)
    diagnostics: Optional[ResamplingDiagnostics] = None
    plots_pdf: Optional[str] = None
    failures: list[dict[str, Any]] = Field(default_factory=list)


class McmcResultModel(BaseModel):
    model_config = ConfigDict(extra="ignore")
    status: str = "complete"  # "complete" | "incomplete" | "empty"
    summary: dict[str, McmcParameterSummary] = Field(default_factory=dict)
    sample_parameters: list[str] = Field(default_factory=list)
    samples: list[list[float]] = Field(default_factory=list)
    correlations: dict[str, dict[str, float]] = Field(default_factory=dict)
    diagnostics: Optional[McmcDiagnostics] = None
    plots_pdf: Optional[str] = None
    failures: list[dict[str, Any]] = Field(default_factory=list)


class StatisticsCollectionModel(BaseModel):
    model_config = ConfigDict(extra="ignore")
    covariance_evidence: Optional[dict[str, Any]] = None
    constrained_evidence: Optional[dict[str, Any]] = None
    covariance_blocks: Optional[dict[str, Any]] = None
    covariance_status: Optional[dict[str, Any]] = None
    monte_carlo: Optional[ResamplingResultModel] = None
    bootstrap: Optional[ResamplingResultModel] = None
    bootstrap_ns: Optional[ResamplingResultModel] = None
    mcmc: Optional[McmcResultModel] = None


PER_RESIDUE_DOF_CONVENTION: str = "NDATA_MINUS_LOCAL_NVARYS"


class StepResidueModel(BaseModel):
    """
    Per-residue parameter aggregation and resoFlow-derived goodness-of-fit (§3.12).
    """
    model_config = ConfigDict(extra="ignore")
    residue: str
    raw_key: str
    display_name: str
    is_unrecognized: bool = False
    chi2: Optional[float] = None  # resoFlow-derived sum of squared residuals
    chi2_red: Optional[float] = None  # Normalized by local degrees of freedom
    ndata: int = 0
    nvarys: int = 0
    dof_convention: str = PER_RESIDUE_DOF_CONVENTION
    r2_a: Optional[UncertaintyValue] = None
    r2_b: Optional[UncertaintyValue] = None
    r1_a: Optional[UncertaintyValue] = None
    cs_a: Optional[UncertaintyValue] = None
    cs_b: Optional[UncertaintyValue] = None
    dw_ab: Optional[UncertaintyValue] = None
    kex_ab: Optional[UncertaintyValue] = None
    pb: Optional[UncertaintyValue] = None
    kab: Optional[UncertaintyValue] = None
    kba: Optional[UncertaintyValue] = None
    tau_b: Optional[UncertaintyValue] = None
    parameters: dict[str, UncertaintyValue] = Field(default_factory=dict)
    experiments: list[dict[str, Any]] = Field(default_factory=list)


class StepResult(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str = ""
    status: str = "complete"  # "complete" | "partial" | "missing"
    has_grid: bool = False
    parameters: Optional[ParameterReportModel] = None
    data: dict[str, DataFileModel] = Field(default_factory=dict)
    statistics: Optional[GoodnessOfFitModel] = None
    grid: Optional[GridResultModel] = None
    statistical_analyses: Optional[StatisticsCollectionModel] = None
    plots: list[str] = Field(default_factory=list)
    residues: dict[str, StepResidueModel] = Field(default_factory=dict)
    globals: dict[str, UncertaintyValue] = Field(default_factory=dict)
    kab: Optional[UncertaintyValue] = None
    kba: Optional[UncertaintyValue] = None
    pa: Optional[UncertaintyValue] = None
    tau_b: Optional[UncertaintyValue] = None
    has_statistics: bool = False


class RunResult(BaseModel):
    model_config = ConfigDict(extra="ignore")
    output_path: str
    state: RunState = RunState.UNKNOWN
    is_provisional: bool = False
    is_multi_step: bool = False
    outcome: OutcomeModel = Field(default_factory=OutcomeModel)
    provenance: Optional[ProvenanceModel] = None
    starting_parameters: dict[str, dict[str, StartingParameter]] = Field(default_factory=dict)
    restart_file_path: Optional[str] = None
    can_continue_fit: bool = False
    continue_explanation: Optional[str] = None
    steps: dict[str, StepResult] = Field(default_factory=dict)
    step_order: list[str] = Field(default_factory=list)
    primary_step: Optional[StepResult] = None
    warnings: list[StructuredWarning] = Field(default_factory=list)
