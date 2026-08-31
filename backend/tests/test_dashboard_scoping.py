import os
import tempfile
import json
import unittest
from datetime import datetime, timezone
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from fastapi.testclient import TestClient

from app import models, database, security
from app.main import app
from app.services.log_parser import extract_failure_reason, extract_current_step
from app.routers.dashboard import reconcile_orphaned_runs

class TestDashboardAndScoping(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        test_db_url = os.environ.get("TEST_DATABASE_URL")
        if test_db_url:
            norm_url = database.normalize_database_url(test_db_url)
            cls.engine = create_engine(norm_url)
        else:
            cls.engine = create_engine(
                "sqlite:///:memory:",
                connect_args={"check_same_thread": False},
                poolclass=StaticPool
            )
        cls.TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=cls.engine)
        models.Base.metadata.create_all(bind=cls.engine)


        def override_get_db():
            db = cls.TestingSessionLocal()
            try:
                yield db
            finally:
                db.close()

        app.dependency_overrides[database.get_db] = override_get_db
        cls.client = TestClient(app)

    @classmethod
    def tearDownClass(cls):
        app.dependency_overrides.clear()

    def setUp(self):
        # Re-create tables fresh for each test
        models.Base.metadata.drop_all(bind=self.engine)
        models.Base.metadata.create_all(bind=self.engine)

        self.db = self.TestingSessionLocal()

        # Create User A
        self.user_a = models.User(
            email="usera@test.com",
            full_name="User Alpha",
            hashed_password=security.get_password_hash("password123"),
            is_active=True,
            is_superuser=False,
        )
        # Create User B
        self.user_b = models.User(
            email="userb@test.com",
            full_name="User Beta",
            hashed_password=security.get_password_hash("password123"),
            is_active=True,
            is_superuser=False,
        )
        # Create Admin User
        self.admin = models.User(
            email="admin@test.com",
            full_name="Admin User",
            hashed_password=security.get_password_hash("admin123"),
            is_active=True,
            is_superuser=True,
        )
        self.db.add_all([self.user_a, self.user_b, self.admin])
        self.db.commit()
        self.db.refresh(self.user_a)
        self.db.refresh(self.user_b)
        self.db.refresh(self.admin)

        # Create Projects for User A
        self.proj_a = models.Project(
            name="Project Alpha Private",
            local_directory_path="/tmp/user_a/project_alpha",
            user_id=self.user_a.id,
            is_archived=False,
        )
        # Create Projects for User B
        self.proj_b = models.Project(
            name="Project Beta Secret",
            local_directory_path="/tmp/user_b/project_beta",
            user_id=self.user_b.id,
            is_archived=False,
        )
        # Create Projects for Admin
        self.proj_admin = models.Project(
            name="Admin Project",
            local_directory_path="/tmp/admin/project_admin",
            user_id=self.admin.id,
            is_archived=False,
        )
        self.db.add_all([self.proj_a, self.proj_b, self.proj_admin])
        self.db.commit()
        self.db.refresh(self.proj_a)
        self.db.refresh(self.proj_b)
        self.db.refresh(self.proj_admin)

        # Create Analyses for User A
        self.analysis_a = models.Analysis(
            name="Alpha CEST Analysis",
            analysis_type="15N-CEST",
            status="RUNNING",
            project_id=self.proj_a.id,
        )
        # Create Analyses for User B
        self.analysis_b = models.Analysis(
            name="Beta CPMG Analysis",
            analysis_type="CPMG",
            status="RUNNING",
            project_id=self.proj_b.id,
        )
        self.db.add_all([self.analysis_a, self.analysis_b])
        self.db.commit()

    def tearDown(self):
        self.db.close()

    def _login(self, email: str, password: str = "password123") -> dict:
        resp = self.client.post(
            "/auth/login",
            data={"username": email, "password": password},
        )
        self.assertEqual(resp.status_code, 200)
        token = resp.json()["access_token"]
        return {"Authorization": f"Bearer {token}"}


    def test_dashboard_strict_cross_user_isolation(self):
        """User A should never see User B's projects, runs, paths, or analyses on dashboard."""
        headers_a = self._login(self.user_a.email, "password123")
        resp_a = self.client.get("/api/users/me/dashboard", headers=headers_a)
        self.assertEqual(resp_a.status_code, 200)
        data_a = resp_a.json()

        # Verify only user A projects
        project_names = [p["name"] for p in data_a["projects"]]
        self.assertIn("Project Alpha Private", project_names)
        self.assertNotIn("Project Beta Secret", project_names)
        self.assertNotIn("Admin Project", project_names)

        # Verify paths are not leaked
        paths = [p["local_directory_path"] for p in data_a["projects"]]
        self.assertTrue(all("user_a" in p for p in paths))
        self.assertFalse(any("user_b" in p for p in paths))

        # Verify runs are only User A runs
        run_uuids = [r["uuid"] for r in data_a["runs"]]
        self.assertIn(self.analysis_a.analysis_uuid, run_uuids)
        self.assertNotIn(self.analysis_b.analysis_uuid, run_uuids)

        # Verify active run count
        self.assertEqual(data_a["stats"]["active_runs"], 1)

    def test_admin_dashboard_personal_scope(self):
        """Admin's personal dashboard must only show Admin's own projects and runs."""
        headers_admin = self._login(self.admin.email, "admin123")
        resp = self.client.get("/api/users/me/dashboard", headers=headers_admin)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()

        project_names = [p["name"] for p in data["projects"]]
        self.assertIn("Admin Project", project_names)
        self.assertNotIn("Project Alpha Private", project_names)
        self.assertNotIn("Project Beta Secret", project_names)

    def test_active_runs_endpoint_scoping(self):
        """GET /api/users/me/runs/active returns only authenticated user's active runs."""
        headers_a = self._login(self.user_a.email, "password123")
        resp = self.client.get("/api/users/me/runs/active", headers=headers_a)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["active_count"], 1)
        self.assertEqual(len(data["runs"]), 1)
        self.assertEqual(data["runs"][0]["uuid"], self.analysis_a.analysis_uuid)

        headers_b = self._login(self.user_b.email, "password123")
        resp_b = self.client.get("/api/users/me/runs/active", headers=headers_b)
        self.assertEqual(resp_b.status_code, 200)
        data_b = resp_b.json()
        self.assertEqual(data_b["active_count"], 1)
        self.assertEqual(data_b["runs"][0]["uuid"], self.analysis_b.analysis_uuid)

    def test_run_cancellation(self):
        """POST /api/users/me/runs/{uuid}/cancel marks run FAILED and sets error message."""
        headers_a = self._login(self.user_a.email, "password123")
        resp = self.client.post(
            f"/api/users/me/runs/{self.analysis_a.analysis_uuid}/cancel",
            headers=headers_a,
        )
        self.assertEqual(resp.status_code, 200)

        # Verify DB updated
        db = self.TestingSessionLocal()
        a = db.query(models.Analysis).filter(models.Analysis.analysis_uuid == self.analysis_a.analysis_uuid).first()
        self.assertEqual(a.status, "FAILED")
        self.assertEqual(a.error_message, "Cancelled by user")
        db.close()

    def test_failure_reason_extraction(self):
        """Log parser accurately extracts the first actionable error line."""
        with tempfile.NamedTemporaryFile("w", delete=False, suffix=".log") as f:
            f.write(
                "CEST Analysis Started: 2026-08-25T00:00:00\n"
                "Fit Mode: GLOBAL\n"
                "$ chemex fit -e exp.toml -p params.toml -o Output\n"
                "Traceback (most recent call last):\n"
                "  File 'chemex/fit.py', line 120, in main\n"
                "ValueError: Spin system '99N' is not found in experimental profiles.\n"
            )
            log_path = f.name

        reason = extract_failure_reason(log_path)
        os.remove(log_path)
        self.assertIn("ValueError: Spin system '99N'", reason)

    def test_current_step_extraction(self):
        """Log parser extracts active residue or cluster progress step."""
        with tempfile.NamedTemporaryFile("w", delete=False, suffix=".log") as f:
            f.write(
                "--- Fitting Residue 4/20: 32N ---\n"
                "$ chemex fit -e exp.toml\n"
            )
            log_path = f.name

        step = extract_current_step(log_path, status="RUNNING")
        os.remove(log_path)
        self.assertEqual(step, "Residue 32N (4/20)")

    def test_orphan_reconciliation(self):
        """Orphaned runs with no active worker process are reconciled to FAILED."""
        # Create an orphaned analysis from the past
        old_analysis = models.Analysis(
            name="Orphaned Analysis",
            analysis_type="15N-CEST",
            status="RUNNING",
            project_id=self.proj_a.id,
            created_at=datetime(2026, 1, 1, 0, 0, 0, tzinfo=timezone.utc),
        )
        self.db.add(old_analysis)
        self.db.commit()

        reconcile_orphaned_runs(self.db, self.user_a.id)

        self.db.refresh(old_analysis)
        self.assertEqual(old_analysis.status, "FAILED")
        self.assertIn("orphaned run", old_analysis.error_message.lower())

    def test_scale_thirty_projects_and_archiving(self):
        """Seed 30 projects for User A and verify dashboard returns all 30 with correct counts and archive support."""
        # Seed 30 projects
        new_projects = []
        for i in range(30):
            p = models.Project(
                name=f"Scale Project {i:02d}",
                local_directory_path=f"/tmp/user_a/scale_project_{i:02d}",
                user_id=self.user_a.id,
                is_archived=(i % 5 == 0),  # archive every 5th project (6 archived)
            )
            new_projects.append(p)
        self.db.add_all(new_projects)
        self.db.commit()

        headers_a = self._login(self.user_a.email, "password123")
        resp = self.client.get("/api/users/me/dashboard", headers=headers_a)
        self.assertEqual(resp.status_code, 200)
        data = resp.json()

        # 30 new projects + 1 original proj_a = 31 projects total
        self.assertEqual(len(data["projects"]), 31)
        self.assertEqual(data["stats"]["total_projects"], 31)

        archived = [p for p in data["projects"] if p["is_archived"]]
        self.assertEqual(len(archived), 6)

        # Test project unarchive / archive via PUT
        target_p = archived[0]
        put_resp = self.client.put(
            f"/api/projects/{target_p['project_uuid']}",
            headers=headers_a,
            json={"is_archived": False},
        )
        self.assertEqual(put_resp.status_code, 200)

        # Verify DB updated
        self.db.refresh(self.db.query(models.Project).filter(models.Project.project_uuid == target_p['project_uuid']).first())
        updated_p = self.db.query(models.Project).filter(models.Project.project_uuid == target_p['project_uuid']).first()
        self.assertFalse(updated_p.is_archived)

