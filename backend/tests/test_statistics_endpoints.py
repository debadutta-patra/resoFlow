import os
import tempfile
import json
import unittest
from pathlib import Path
import numpy as np
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from fastapi.testclient import TestClient

from app import models, database, security
from app.main import app
from app.services.fitting.statistics_engine import save_replicates_npz


class TestStatisticsEndpoints(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = create_engine(
            "sqlite:///:memory:",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
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
        models.Base.metadata.drop_all(bind=self.engine)
        models.Base.metadata.create_all(bind=self.engine)

        # Create temporary project & analysis folder
        self.tmpdir = tempfile.TemporaryDirectory()
        self.project_dir = Path(self.tmpdir.name)

        self.db = self.TestingSessionLocal()
        user = models.User(
            email="testuser@test.com",
            hashed_password=security.get_password_hash("password123"),
            full_name="Test User",
            is_active=True,
        )
        self.db.add(user)
        self.db.commit()
        self.db.refresh(user)

        self.user = user

        project = models.Project(
            project_uuid="proj-test-1234",
            name="Test Project",
            user_id=user.id,
            local_directory_path=str(self.project_dir),
        )
        self.db.add(project)
        self.db.commit()
        self.db.refresh(project)
        self.project = project

        analysis = models.Analysis(
            analysis_uuid="analysis-test-5678",
            name="Test Analysis",
            analysis_type="15N-CEST",
            project_id=project.id,
            status="COMPLETED",
        )
        self.db.add(analysis)
        self.db.commit()
        self.db.refresh(analysis)
        self.analysis = analysis

        # Populate synthetic MC replicate data
        self.mc_dir = self.project_dir / "cest_fitting" / analysis.analysis_uuid / "Output" / "STEP1" / "Statistics" / "MonteCarlo"
        self.mc_dir.mkdir(parents=True, exist_ok=True)

        np.random.seed(42)
        kex = np.random.normal(450.0, 15.0, size=200)
        pb = np.random.normal(0.0036, 0.0001, size=200)
        reps = np.column_stack([kex, pb])
        params = ["KEX_AB", "PB"]
        chisqr = np.random.normal(350.0, 10.0, size=200)

        save_replicates_npz(self.mc_dir / "replicates.npz", reps, params, chisqr=chisqr)

        # Also write fitted.toml
        param_dir = self.project_dir / "cest_fitting" / analysis.analysis_uuid / "Output" / "STEP1" / "Parameters"
        param_dir.mkdir(parents=True, exist_ok=True)
        (param_dir / "fitted.toml").write_text("[GLOBAL]\nKEX_AB = 451.2\nPB = 0.0036\n", encoding="utf-8")

        # Auth token
        token = security.create_access_token({"sub": user.email})
        self.headers = {"Authorization": f"Bearer {token}"}

    def tearDown(self):
        self.db.close()
        self.tmpdir.cleanup()

    def test_statistics_summary_endpoint(self):
        url = f"/api/projects/{self.project.project_uuid}/analysis/{self.analysis.analysis_uuid}/statistics/summary?method_name=monte_carlo"
        res = self.client.get(url, headers=self.headers)
        assert res.status_code == 200, res.text
        data = res.json()
        assert data["sample_count"] == 200
        assert "KEX_AB" in data["summary"]
        assert "PB" in data["summary"]
        kex = data["summary"]["KEX_AB"]
        assert kex["mean"] == pytest.approx(450.0, abs=3.0)
        assert kex["median"] == pytest.approx(450.0, abs=3.0)
        assert kex["deterministic_value"] == 451.2
        assert kex["standard_deviation"] > 0
        assert kex["percentile_95_lower"] < kex["percentile_95_upper"]

    def test_parameter_histogram_endpoint(self):
        url = f"/api/projects/{self.project.project_uuid}/analysis/{self.analysis.analysis_uuid}/statistics/histogram?parameter_name=KEX_AB&method_name=monte_carlo"
        res = self.client.get(url, headers=self.headers)
        assert res.status_code == 200, res.text
        data = res.json()
        assert data["parameter_name"] == "KEX_AB"
        assert data["sample_count"] == 200
        assert len(data["counts"]) == len(data["bin_centers"])
        assert sum(data["counts"]) == 200
        assert data["deterministic_value"] == 451.2

    def test_joint_distribution_endpoint(self):
        url = f"/api/projects/{self.project.project_uuid}/analysis/{self.analysis.analysis_uuid}/statistics/joint-distribution?param_x=KEX_AB&param_y=PB&method_name=monte_carlo"
        res = self.client.get(url, headers=self.headers)
        assert res.status_code == 200, res.text
        data = res.json()
        assert data["param_x"] == "KEX_AB"
        assert data["param_y"] == "PB"
        assert len(data["counts_2d"]) == 25
        assert len(data["counts_2d"][0]) == 25
        assert "correlation_r" in data
        assert data["x_deterministic"] == 451.2
        assert data["y_deterministic"] == 0.0036

    def test_download_replicates_csv(self):
        url = f"/api/projects/{self.project.project_uuid}/analysis/{self.analysis.analysis_uuid}/statistics/download/replicates?method_name=monte_carlo&format=csv"
        res = self.client.get(url, headers=self.headers)
        assert res.status_code == 200
        assert "text/csv" in res.headers["content-type"]
        text = res.text
        lines = text.strip().split("\n")
        assert len(lines) == 201  # Header + 200 rows
        assert "KEX_AB,PB,chisqr" in lines[0]

    def test_download_replicates_npz(self):
        url = f"/api/projects/{self.project.project_uuid}/analysis/{self.analysis.analysis_uuid}/statistics/download/replicates?method_name=monte_carlo&format=npz"
        res = self.client.get(url, headers=self.headers)
        assert res.status_code == 200
        assert "application/octet-stream" in res.headers["content-type"]
        assert len(res.content) > 0

    def test_grouped_fit_statistics(self):
        """Verify grouped fit statistics discovery and aggregation."""
        import numpy as np
        import shutil
        from app.services.fitting.statistics_engine import save_replicates_npz
        run_dir = self.project_dir / "cest_fitting" / self.analysis.analysis_uuid
        # Remove top-level statistics to simulate pure grouped output
        if self.mc_dir.exists():
            shutil.rmtree(self.mc_dir.parent.parent)

        # Setup group directories
        g1_dir = run_dir / "Output" / "Groups" / "1_32" / "Statistics" / "MonteCarlo"
        g2_dir = run_dir / "Output" / "Groups" / "2_55" / "Statistics" / "MonteCarlo"
        g1_dir.mkdir(parents=True, exist_ok=True)
        g2_dir.mkdir(parents=True, exist_ok=True)

        g1_reps = np.random.normal(300.0, 10.0, (100, 2))
        save_replicates_npz(g1_dir / "replicates.npz", g1_reps, ["[KEX_AB, NUC->32]", "[PB, NUC->32]"])

        g2_reps = np.random.normal(500.0, 15.0, (100, 2))
        save_replicates_npz(g2_dir / "replicates.npz", g2_reps, ["[KEX_AB, NUC->55]", "[PB, NUC->55]"])

        # Test summary endpoint merges both groups
        url = f"/api/projects/{self.project.project_uuid}/analysis/{self.analysis.analysis_uuid}/statistics/summary?method_name=monte_carlo"
        res = self.client.get(url, headers=self.headers)
        assert res.status_code == 200
        data = res.json()
        assert "KEX_AB, NUC->32N" in data["summary"]
        assert "KEX_AB, NUC->55N" in data["summary"]

        # Test histogram endpoint retrieves parameter from specific group
        url_hist = f"/api/projects/{self.project.project_uuid}/analysis/{self.analysis.analysis_uuid}/statistics/histogram?parameter_name=KEX_AB,%20NUC-%3E55N&method_name=monte_carlo"
        res_hist = self.client.get(url_hist, headers=self.headers)
        assert res_hist.status_code == 200
        data_hist = res_hist.json()
        assert data_hist["sample_count"] == 100
        assert data_hist["mean"] == pytest.approx(500.0, abs=5.0)
