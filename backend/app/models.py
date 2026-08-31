import os
import uuid

from sqlalchemy import Boolean, Column, ForeignKey, Integer, String, DateTime, Float, Table
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from .database import Base

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String, unique=True, index=True)
    hashed_password = Column(String)
    full_name = Column(String, index=True)
    is_active = Column(Boolean, default=False)
    is_superuser = Column(Boolean, default=False)

    projects = relationship("Project", back_populates="owner")


class Project(Base):
    __tablename__ = "projects"

    id = Column(Integer, primary_key=True, index=True)
    project_uuid = Column(String, unique=True, index=True, default=lambda: uuid.uuid4().hex)
    name = Column(String, index=True)
    local_directory_path = Column(String)
    protein_sequence = Column(String, nullable=True)
    molecular_weight = Column(String, nullable=True)
    spectra_path = Column(String, nullable=True)
    experiments = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    user_id = Column(Integer, ForeignKey("users.id"))
    is_archived = Column(Boolean, default=False, index=True)

    owner = relationship("User", back_populates="projects")
    spectra = relationship("Spectrum", back_populates="project")
    jobs = relationship("Job", back_populates="project")


class Spectrum(Base):
    __tablename__ = "spectra"

    id = Column(Integer, primary_key=True, index=True)
    spectrum_uuid = Column(String, unique=True, index=True, default=lambda: uuid.uuid4().hex)
    name = Column(String, index=True)
    file_path = Column(String, index=True)
    experiment_type = Column(String, nullable=True)
    peaklist_path = Column(String, nullable=True)
    list_path = Column(String, nullable=True) # Legacy
    vclist_path = Column(String, nullable=True)
    vdlist_path = Column(String, nullable=True)
    f3list_path = Column(String, nullable=True)
    
    # Experiment parameters
    delay = Column(Float, nullable=True)
    t_relax = Column(Float, nullable=True)
    b1 = Column(Float, nullable=True)
    hetnoe_mode = Column(String, nullable=True) # 0,1 or 1,0
    project_id = Column(Integer, ForeignKey("projects.id"))
    is_fitted = Column(Boolean, default=False)
    results_json_path = Column(String, nullable=True)
    peaktable_json_path = Column(String, nullable=True)
    b0 = Column(Float, nullable=True)
    temperature = Column(Float, nullable=True)
    carrier = Column(Float, nullable=True)  # CEST carrier frequency in ppm

    @property
    def has_backup(self):
        if not self.results_json_path:
            return False
        bak_path = self.results_json_path.replace(".json", "_bak.json")
        return os.path.exists(bak_path)

    project = relationship("Project", back_populates="spectra")
    jobs = relationship("Job", back_populates="spectrum")


class Job(Base):
    __tablename__ = "jobs"

    id = Column(Integer, primary_key=True, index=True)
    job_uuid = Column(String, unique=True, index=True, default=lambda: uuid.uuid4().hex)
    status = Column(String, index=True, default="PENDING")  # PENDING, RUNNING, COMPLETED, FAILED
    total_clusters = Column(Integer, default=0)
    completed_clusters = Column(Integer, default=0)
    processors = Column(Integer, default=1)
    log_path = Column(String, nullable=True)
    celery_task_id = Column(String, nullable=True)
    error_message = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    completed_at = Column(DateTime(timezone=True), nullable=True)
    
    project_id = Column(Integer, ForeignKey("projects.id"))
    spectrum_id = Column(Integer, ForeignKey("spectra.id"))

    project = relationship("Project", back_populates="jobs")
    spectrum = relationship("Spectrum", back_populates="jobs")


# Association table for Analysis and Spectrum (Many-to-Many)
analysis_spectra = Table(
    "analysis_spectra",
    Base.metadata,
    Column("analysis_id", Integer, ForeignKey("analyses.id"), primary_key=True),
    Column("spectrum_id", Integer, ForeignKey("spectra.id"), primary_key=True)
)

class Analysis(Base):
    __tablename__ = "analyses"

    id = Column(Integer, primary_key=True, index=True)
    analysis_uuid = Column(String, unique=True, index=True, default=lambda: uuid.uuid4().hex)
    name = Column(String, index=True)
    analysis_type = Column(String)  # R1, R2, 15N-CEST, CPMG, hetNOE
    status = Column(String, default="PENDING")  # PENDING, RUNNING, COMPLETED, FAILED
    
    # Store parameters like workers, lineshape, reference spectrum id, etc.
    parameters = Column(String, nullable=True) # JSON string
    
    project_id = Column(Integer, ForeignKey("projects.id"))
    use_height = Column(Boolean, default=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    completed_at = Column(DateTime(timezone=True), nullable=True)
    
    # Results path
    results_path = Column(String, nullable=True)
    log_path = Column(String, nullable=True)
    error_message = Column(String, nullable=True)
    
    # ChemEx container metadata & execution tracking
    chemex_image_digest = Column(String, nullable=True)
    chemex_version = Column(String, nullable=True)
    celery_task_id = Column(String, nullable=True)
    cancel_requested = Column(Boolean, default=False)

    @property
    def has_backup(self):
        if self.results_path and os.path.exists(self.results_path.replace(".json", "_bak.json")):
            return True
        if self.project and self.project.local_directory_path:
            dir_name = "cpmg_fitting" if self.analysis_type == "CPMG" else "cest_fitting"
            output_bak = os.path.join(self.project.local_directory_path, dir_name, self.analysis_uuid, "Output_bak")
            return os.path.exists(output_bak)
        return False

    project = relationship("Project", back_populates="analyses")
    spectra = relationship("Spectrum", secondary=analysis_spectra, back_populates="analyses")

# Update Project and Spectrum relationships
Project.analyses = relationship("Analysis", back_populates="project")
Spectrum.analyses = relationship("Analysis", secondary=analysis_spectra, back_populates="spectra")
