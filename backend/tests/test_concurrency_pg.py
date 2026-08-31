import os
import time
import uuid
import unittest
from concurrent.futures import ThreadPoolExecutor, as_completed
from sqlalchemy import create_engine, update, text
from sqlalchemy.orm import sessionmaker
from app.models import Base, User, Project, Spectrum, Job, Analysis
from app.database import normalize_database_url

class TestPostgreSQLConcurrency(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        pg_url = os.environ.get("TEST_DATABASE_URL")
        if not pg_url:
            raise unittest.SkipTest("TEST_DATABASE_URL not set; skipping live Postgres concurrency tests to protect local database.")
        try:
            cls.engine = create_engine(
                normalize_database_url(pg_url),
                pool_size=10,
                max_overflow=20,
                pool_pre_ping=True
            )
            with cls.engine.connect() as conn:
                conn.execute(text("SELECT 1"))
            cls.Session = sessionmaker(bind=cls.engine)
            Base.metadata.create_all(bind=cls.engine)
        except Exception as e:
            raise unittest.SkipTest(f"PostgreSQL test database not available: {e}")

    def setUp(self):
        # Truncate tables for a clean slate
        with self.engine.begin() as conn:
            conn.execute(text("TRUNCATE TABLE analysis_spectra, jobs, analyses, spectra, projects, users CASCADE;"))

        db = self.Session()
        unique_email = f"concurrent_{uuid.uuid4().hex[:8]}@test.com"
        self.user = User(email=unique_email, hashed_password="pw", is_active=True)
        db.add(self.user)
        db.commit()
        db.refresh(self.user)
        self.user_id = self.user.id

        self.project = Project(name="Concurrency Proj", user_id=self.user_id, local_directory_path="/tmp")
        db.add(self.project)
        db.commit()
        db.refresh(self.project)
        self.project_id = self.project.id

        self.job = Job(
            project_id=self.project_id,
            status="PENDING",
            total_clusters=50,
            completed_clusters=0
        )
        db.add(self.job)
        db.commit()
        db.refresh(self.job)
        self.job_id = self.job.id
        db.close()

    def _worker_increment_progress(self, worker_id: int, increments: int):
        """Simulate a Celery worker process/thread updating job progress concurrently."""
        db = self.Session()
        errors = []
        try:
            for _ in range(increments):
                stmt = (
                    update(Job)
                    .where(Job.id == self.job_id)
                    .values(completed_clusters=Job.completed_clusters + 1)
                )
                db.execute(stmt)
                db.commit()
                time.sleep(0.005)
        except Exception as e:
            errors.append(f"Worker {worker_id} encountered error: {e}")
            db.rollback()
        finally:
            db.close()
        return errors

    def test_high_concurrency_writers_no_locking_errors(self):
        """Simulate 10 concurrent workers each performing 5 updates simultaneously (50 total updates)."""
        num_workers = 10
        increments_per_worker = 5
        expected_total = num_workers * increments_per_worker

        with ThreadPoolExecutor(max_workers=num_workers) as executor:
            futures = [
                executor.submit(self._worker_increment_progress, w_id, increments_per_worker)
                for w_id in range(num_workers)
            ]
            all_errors = []
            for fut in as_completed(futures):
                errs = fut.result()
                if errs:
                    all_errors.extend(errs)

        self.assertEqual(all_errors, [], f"Concurrency errors occurred: {all_errors}")

        # Verify exact final count
        db = self.Session()
        job = db.query(Job).filter(Job.id == self.job_id).first()
        self.assertIsNotNone(job)
        self.assertEqual(job.completed_clusters, expected_total)
        db.close()

    def test_simultaneous_analyses_creation_and_status_transitions(self):
        """Simulate multiple Celery tasks and FastAPI threads creating and finishing analyses concurrently."""
        num_analyses = 20
        project_id = self.project_id

        def _create_and_complete_analysis(index: int):
            db = self.Session()
            try:
                analysis = Analysis(
                    name=f"Concurrent Analysis {index}",
                    analysis_type="CPMG",
                    status="PENDING",
                    project_id=project_id
                )
                db.add(analysis)
                db.commit()
                db.refresh(analysis)

                time.sleep(0.01)
                analysis.status = "RUNNING"
                db.commit()

                time.sleep(0.01)
                analysis.status = "COMPLETED"
                analysis.error_message = None
                db.commit()
                return None
            except Exception as e:
                db.rollback()
                return f"Analysis {index} failed: {e}"
            finally:
                db.close()

        with ThreadPoolExecutor(max_workers=10) as executor:
            futures = [executor.submit(_create_and_complete_analysis, i) for i in range(num_analyses)]
            errors = [f.result() for f in as_completed(futures) if f.result() is not None]

        self.assertEqual(errors, [], f"Errors: {errors}")

        db = self.Session()
        completed_count = (
            db.query(Analysis)
            .filter(Analysis.project_id == project_id, Analysis.status == "COMPLETED")
            .count()
        )
        self.assertEqual(completed_count, num_analyses)
        db.close()
