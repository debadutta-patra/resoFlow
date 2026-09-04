import os
import logging
from celery import Celery
from celery.signals import after_setup_logger, worker_process_init
from app.database import engine

# Configure Redis URL
redis_url = os.getenv("REDIS_URL", "redis://localhost:6380/0")

# Initialize Celery
celery_app = Celery(
    "resoFlow",
    broker=redis_url,
    backend=redis_url,
    include=[
        "app.services.fitting.service",
        "app.services.fitting.relaxation_tasks",
        "app.services.fitting.cest_tasks",
        "app.services.fitting.cpmg_tasks",
        "app.services.reporting.tasks",
    ]  # Ensure tasks are discovered
)

# Optional configuration
celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    task_track_started=True,
    result_backend=redis_url,
)

# Task routes for queue splitting
celery_app.conf.task_routes = {
    "app.services.fitting.cest_tasks.run_cest_analysis_task": {"queue": "chemex"},
    "app.services.fitting.cpmg_tasks.run_cpmg_analysis_task": {"queue": "chemex"},
    "app.services.fitting.service.fit_cluster_task": {"queue": "peakfit"},
    "app.services.fitting.service.compile_results_task": {"queue": "peakfit"},
    "app.services.fitting.relaxation_tasks.run_relaxation_analysis_task": {"queue": "stats"},
    "app.services.reporting.tasks.generate_report_pdf_task": {"queue": "stats"},
}

@worker_process_init.connect
def init_worker_process(**kwargs):
    """
    Dispose the inherited SQLAlchemy engine and connection pool when Celery forks
    a new child process. Each child process will establish its own fresh connection pool.
    """
    engine.dispose(close=True)

from celery.signals import worker_ready

@worker_ready.connect
def on_worker_ready(sender, **kwargs):
    """
    On Celery worker startup, scan for and reap any orphaned ChemEx containers
    left behind by previous abnormal shutdowns.
    """
    from app.services.fitting.chemex_runner import reap_orphaned_chemex_containers
    reaped = reap_orphaned_chemex_containers()
    if reaped:
        logging.getLogger(__name__).info(f"Worker startup: reaped {len(reaped)} orphaned ChemEx container(s): {reaped}")

@after_setup_logger.connect
def setup_loggers(logger, *args, **kwargs):
    formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
    
    # Standard output
    handler = logging.StreamHandler()
    handler.setFormatter(formatter)
    logger.addHandler(handler)
