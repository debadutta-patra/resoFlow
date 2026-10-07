import os
import json
import logging
from pathlib import Path

from celery import shared_task
from ... import models, database
from .chemex_runner import run_chemex_job

logger = logging.getLogger(__name__)

@shared_task(bind=True)
def run_exchange_analysis_task(self, analysis_uuid: str, config: dict):
    db = next(database.get_db())
    analysis = db.query(models.Analysis).filter_by(analysis_uuid=analysis_uuid).first()
    if not analysis:
        return
        
    try:
        project = analysis.project
        run_dir = os.path.join(project.local_directory_path, "exchange_fitting", analysis.analysis_uuid)
        
        cfg_path = os.path.join(run_dir, "config.json")
        if not os.path.exists(cfg_path):
            cfg_path = os.path.join(run_dir, "exchange_config.json")
            
        with open(cfg_path, "r") as f:
            cfg = json.load(f)
            
        experiments_dir = cfg.get("experiments_dir")
        
        analysis.status = "FITTING"
        analysis.celery_task_id = self.request.id
        db.commit()
        
        out_dir = os.path.join(run_dir, "Output")
        os.makedirs(out_dir, exist_ok=True)
        
        experiment_tomls = [os.path.join(experiments_dir, f) for f in os.listdir(experiments_dir) if f.endswith('.toml')]
        
        args = ["fit", "--experiments"] + experiment_tomls + ["--out-dir", out_dir]
        
        param_file = os.path.join(run_dir, "parameters.toml")
        if os.path.exists(param_file):
            args.extend(["--parameters", param_file])
            
        run_chemex_job(analysis_uuid, run_dir, args, log_file=os.path.join(run_dir, 'chemex.log'))
        
        # Check if cancelled
        db.refresh(analysis)
        if analysis.cancel_requested:
            analysis.status = "CANCELLED"
            db.commit()
            return

        analysis.status = "COMPLETED"
        analysis.results_path = out_dir
        
        # Merge stats and parse results if needed
        # We can run a parsing step here similar to cest_tasks if necessary.
        
        db.commit()
        
    except Exception as e:
        logger.exception("Exchange fit failed")
        db.refresh(analysis)
        analysis.status = "FAILED"
        analysis.error_message = str(e)
        db.commit()
