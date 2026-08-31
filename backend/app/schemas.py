from datetime import datetime
from pydantic import BaseModel
from typing import List, Optional

class Token(BaseModel):
    access_token: str
    token_type: str

class TokenData(BaseModel):
    email: Optional[str] = None

# Users
class UserBase(BaseModel):
    email: str
    full_name: Optional[str] = None

class UserCreate(UserBase):
    password: str

class User(UserBase):
    id: int
    is_active: bool
    is_superuser: bool

    class Config:
        from_attributes = True

class UserUpdate(BaseModel):
    is_active: Optional[bool] = None
    is_superuser: Optional[bool] = None

class UserPasswordUpdate(BaseModel):
    new_password: str

# Projects
class ProjectBase(BaseModel):
    name: str
    local_directory_path: str
    protein_sequence: Optional[str] = None
    molecular_weight: Optional[str] = None
    experiments: Optional[str] = None
    is_archived: bool = False

class ProjectCreate(ProjectBase):
    pass

class ProjectImportRequest(BaseModel):
    directory_path: str

class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    protein_sequence: Optional[str] = None
    molecular_weight: Optional[str] = None
    experiments: Optional[str] = None
    is_archived: Optional[bool] = None

class Project(ProjectBase):
    id: int
    project_uuid: str
    user_id: int
    created_at: datetime
    spectra: List['Spectrum'] = []
    jobs: List['JobStatus'] = []
    analyses: List['Analysis'] = []

    class Config:
        from_attributes = True

# Spectra
class SpectrumBase(BaseModel):
    name: str
    file_path: str
    experiment_type: Optional[str] = None
    peaklist_path: Optional[str] = None
    list_path: Optional[str] = None # Legacy
    vclist_path: Optional[str] = None
    vdlist_path: Optional[str] = None
    f3list_path: Optional[str] = None
    delay: Optional[float] = None
    t_relax: Optional[float] = None
    b1: Optional[float] = None
    hetnoe_mode: Optional[str] = None

class SpectrumCreate(SpectrumBase):
    pass

class SpectrumUpdate(BaseModel):
    experiment_type: Optional[str] = None
    peaklist_path: Optional[str] = None
    list_path: Optional[str] = None
    vclist_path: Optional[str] = None
    vdlist_path: Optional[str] = None
    f3list_path: Optional[str] = None
    delay: Optional[float] = None
    t_relax: Optional[float] = None
    b1: Optional[float] = None
    b0: Optional[float] = None
    temperature: Optional[float] = None
    carrier: Optional[float] = None
    hetnoe_mode: Optional[str] = None
    is_fitted: Optional[bool] = None
    results_json_path: Optional[str] = None
    peaktable_json_path: Optional[str] = None

class Spectrum(SpectrumBase):
    id: int
    spectrum_uuid: str
    project_id: int
    is_fitted: bool = False
    results_json_path: Optional[str] = None
    peaktable_json_path: Optional[str] = None
    has_backup: bool = False
    vclist_path: Optional[str] = None
    vdlist_path: Optional[str] = None
    f3list_path: Optional[str] = None
    delay: Optional[float] = None
    t_relax: Optional[float] = None
    b1: Optional[float] = None
    b0: Optional[float] = None
    temperature: Optional[float] = None
    carrier: Optional[float] = None
    hetnoe_mode: Optional[str] = None

    class Config:
        from_attributes = True

class SpectrumDataResponse(BaseModel):
    xs_pos: List[Optional[float]]
    ys_pos: List[Optional[float]]
    xs_neg: List[Optional[float]]
    ys_neg: List[Optional[float]]
    xlabel: str
    ylabel: str
    estimated_noise: float
    base_level: float

# Peak Fitting
class PeakFittingRequest(BaseModel):
    peaks: Optional[List[dict]] = None
    peaklist_format: str = "pipe"  # pipe, sparky, a2, a3, csv
    dims: List[int] = [0, 1, 2]
    x_radius_ppm: float = 0.04
    y_radius_ppm: float = 0.4
    lineshape: str = "PV"  # PV, G, L, V, PV_PV
    fit_method: str = "leastsq"  # leastsq, least_squares, nelder, powell
    clustering_method: str = "auto"  # auto, mask
    struc_el: str = "disk"  # disk, square, rectangle
    struc_size: List[int] = [3]
    noise: Optional[float] = None
    max_cluster_size: Optional[int] = None
    to_fix: List[str] = ["fraction", "sigma", "center"]
    processors: int = 1
    use_persistent_peaktable: bool = False

class ClusterPreviewRequest(BaseModel):
    peaklist_format: str = "pipe"
    dims: List[int] = [0, 1, 2]
    x_radius_ppm: float = 0.04
    y_radius_ppm: float = 0.4
    clustering_method: str = "auto"
    struc_el: str = "disk"
    struc_size: List[int] = [3]
    noise: Optional[float] = None
    use_persistent_peaktable: bool = False

class PeakFittingSummary(BaseModel):
    total_peaks_fitted: int
    total_clusters: int
    total_planes: int
    avg_chisqr: float
    avg_redchi: Optional[float] = None
    redchi_plane0: Optional[float] = None
    lineshape_used: Optional[str] = "unknown"
    fit_method_used: Optional[str] = "unknown"

class PeakFittingResponse(BaseModel):
    results: list
    summary: PeakFittingSummary
    log: Optional[str] = ""

class ClusterPreviewResponse(BaseModel):
    peaks: list
    total_peaks: int
    total_clusters: int

class SingleClusterFitRequest(BaseModel):
    cluster_id: int
    peaks: Optional[list] = None
    peaklist_format: str = "pipe"
    dims: List[int] = [0, 1, 2]
    x_radius_ppm: float = 0.04
    y_radius_ppm: float = 0.4
    lineshape: str = "PV"
    fit_method: str = "leastsq"
    clustering_method: str = "auto"
    struc_el: str = "disk"
    struc_size: List[int] = [3]
    noise: Optional[float] = None
    to_fix: List[str] = ["fraction", "sigma", "center"]
    use_persistent_peaktable: bool = False

class PlotFittedClusterRequest(BaseModel):
    cluster_id: int
    fitted_peaks: list
    plane: int = 0
    peaklist_format: str = "pipe"
    dims: List[int] = [0, 1, 2]
    lineshape: str = "PV"
    clustering_method: str = "auto"
    struc_el: str = "disk"
    struc_size: List[int] = [3]

class ExportPDFRequest(PeakFittingRequest):
    """Request to export all cluster fits as a PDF."""
    results: List[dict]


class ReclusterRequest(BaseModel):
    peaks: list  # list of dicts with X_PPM, Y_PPM, X_RADIUS, Y_RADIUS, etc.
    peaklist_format: str = "pipe"
    dims: List[int] = [0, 1, 2]
    clustering_method: str = "auto"
    struc_el: str = "disk"
    struc_size: List[int] = [3]
    noise: Optional[float] = None
    use_persistent_peaktable: bool = False
class SingleClusterFitResponse(BaseModel):
    x_ppm: list  # 1D array
    y_ppm: list  # 1D array
    experimental: list  # 2D grid
    model: list  # 2D grid
    model_x_ppm: Optional[list] = None
    model_y_ppm: Optional[list] = None
    residuals: list  # 2D grid
    fit_params: Optional[list] = None  # per-peak fitted params
    fit_stats: Optional[dict] = None  # chi2, redchi, aic
    cluster_id: int
    peaks_in_cluster: int
    peak_annotations: list = []  # [{label, x_ppm, y_ppm, z_intensity, volume, height}]

# Jobs
class JobBase(BaseModel):
    status: str

class JobCreate(JobBase):
    pass

class JobStatus(JobBase):
    id: int
    job_uuid: str
    project_id: int
    spectrum_id: Optional[int] = None
    total_clusters: int
    completed_clusters: int
    processors: int
    log_path: Optional[str] = None
    celery_task_id: Optional[str] = None
    error_message: Optional[str] = None
    created_at: datetime
    completed_at: Optional[datetime] = None

    class Config:
        from_attributes = True

# Dashboard & Run Queue
class RunItem(BaseModel):
    id: int
    uuid: str
    name: str
    kind: str  # "analysis" or "peak_fitting"
    analysis_type: Optional[str] = None
    status: str  # PENDING, RUNNING, COMPLETED, FAILED
    project_id: int
    project_uuid: str
    project_name: str
    created_at: datetime
    completed_at: Optional[datetime] = None
    elapsed_seconds: Optional[float] = None
    error_reason: Optional[str] = None
    current_step: Optional[str] = None
    log_path: Optional[str] = None
    fit_mode: Optional[str] = None

class RecentAnalysisItem(BaseModel):
    id: int
    analysis_uuid: str
    name: str
    analysis_type: str
    status: str
    project_id: int
    project_uuid: str
    project_name: str
    fit_mode: Optional[str] = None
    reduced_chi2: Optional[float] = None
    created_at: datetime
    completed_at: Optional[datetime] = None

class EnrichedProject(ProjectBase):
    id: int
    project_uuid: str
    user_id: int
    is_archived: bool = False
    created_at: datetime
    last_run_at: Optional[datetime] = None
    spectra_count: int = 0
    analysis_count: int = 0
    status_counts: dict = {"completed": 0, "running": 0, "failed": 0, "pending": 0}

    class Config:
        from_attributes = True

class DashboardStats(BaseModel):
    total_projects: int
    total_spectra: int
    total_jobs: int = 0
    active_runs: int = 0
    queued_runs: int = 0
    failed_runs: int = 0
    completed_runs: int = 0

class ActivityIndicator(BaseModel):
    id: int
    action: str
    timestamp: datetime

class DashboardResponse(BaseModel):
    user: User
    stats: DashboardStats
    runs: List[RunItem] = []
    recent_analyses: List[RecentAnalysisItem] = []
    projects: List[EnrichedProject] = []
    recent_activity: List[ActivityIndicator] = []

class ActiveRunsResponse(BaseModel):
    active_count: int
    queued_count: int
    runs: List[RunItem] = []

# Analysis Schemas
class AnalysisBase(BaseModel):
    name: str
    analysis_type: str # R1, R2, 15N-CEST, CPMG, hetNOE
    use_height: bool = False

class AnalysisCreate(AnalysisBase):
    parameters: Optional[str] = None # JSON string

class AnalysisUpdate(BaseModel):
    name: Optional[str] = None
    status: Optional[str] = None
    parameters: Optional[str] = None
    use_height: Optional[bool] = None
    results_path: Optional[str] = None
    log_path: Optional[str] = None
    error_message: Optional[str] = None
    completed_at: Optional[datetime] = None

class Analysis(AnalysisBase):
    id: int
    analysis_uuid: str
    status: str
    parameters: Optional[str] = None
    use_height: bool = False
    project_id: int
    created_at: datetime
    completed_at: Optional[datetime] = None
    results_path: Optional[str] = None
    log_path: Optional[str] = None
    error_message: Optional[str] = None
    has_backup: bool = False
    chemex_image_digest: Optional[str] = None
    chemex_version: Optional[str] = None
    celery_task_id: Optional[str] = None
    cancel_requested: bool = False
    spectra: List[Spectrum] = []

    class Config:
        from_attributes = True

class AnalysisRunRequest(BaseModel):
    spectrum_ids: List[int]
    workers: int = 1
    # You can add more parameters here as needed

# Method & Statistics Schemas
class McmcSettingsSchema(BaseModel):
    steps: int
    burn: Optional[str | int] = "auto"
    thin: int = 1
    walkers: Optional[int] = None
    seed: Optional[int] = None
    workers: Optional[int] = None
    update_parameters: bool = False

class StatisticsSchema(BaseModel):
    mc: Optional[int] = None
    bs: Optional[int] = None
    bsn: Optional[int] = None
    mcmc: Optional[int | McmcSettingsSchema] = None

class ParamSettingSchema(BaseModel):
    name: str
    mode: str = "default"  # default, fit, fix, constrain, grid
    value: Optional[float] = None
    bounds: Optional[str] = None
    expression: Optional[str] = None
    grid: Optional[dict] = None

class MethodStepSchema(BaseModel):
    id: Optional[str] = None
    name: str = "STEP1"
    parameters: List[ParamSettingSchema] = []
    residue_mode: str = "include"
    residues: List[int | str] = []
    statistics: Optional[StatisticsSchema] = None

class MethodConfigSchema(BaseModel):
    steps: List[MethodStepSchema] = []
    raw_override: Optional[str] = None

class MethodValidationIssue(BaseModel):
    id: str
    stepIndex: int
    stepName: str
    field: str
    severity: str  # "error" | "warning"
    message: str

class MethodValidationRequest(BaseModel):
    config: Optional[MethodConfigSchema] = None
    toml: Optional[str] = None
    available_params: Optional[List[str]] = None

class MethodValidationResponse(BaseModel):
    valid: bool
    issues: List[MethodValidationIssue] = []
    emitted_toml: Optional[str] = None

