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

@worker_process_init.connect
def init_worker_process(**kwargs):
    """
    Dispose the inherited SQLAlchemy engine and connection pool when Celery forks
    a new child process. Each child process will establish its own fresh connection pool.
    """
    engine.dispose(close=True)

@after_setup_logger.connect
def setup_loggers(logger, *args, **kwargs):
    formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
    
    # Standard output
    handler = logging.StreamHandler()
    handler.setFormatter(formatter)
    logger.addHandler(handler)
