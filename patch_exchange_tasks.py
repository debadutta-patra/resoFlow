import re

with open("backend/app/services/fitting/exchange_tasks.py", "r") as f:
    content = f.read()

content = content.replace("from .chemex_runner import run_chemex", "from .chemex_runner import run_chemex_job")
content = content.replace("run_chemex(project, args, working_dir=run_dir, celery_task=self, db_session=db, analysis_uuid=analysis_uuid)", "run_chemex_job(analysis_uuid, run_dir, args, log_file=os.path.join(run_dir, 'chemex.log'))")

with open("backend/app/services/fitting/exchange_tasks.py", "w") as f:
    f.write(content)
