import os
import unittest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models, database, security, schemas
from app.services.path_utils import to_container_path, to_host_path
from app.services.json_sync import load_project_from_json
from app.routers.projects import import_project

class TestProjectImport(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = create_engine(
            "sqlite:///:memory:",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool
        )
        cls.SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=cls.engine)
        models.Base.metadata.create_all(bind=cls.engine)

    def setUp(self):
        models.Base.metadata.drop_all(bind=self.engine)
        models.Base.metadata.create_all(bind=self.engine)
        self.db = self.SessionLocal()
        self.user = models.User(
            email="import_test@lab.org",
            full_name="Import Tester",
            hashed_password=security.get_password_hash("password123"),
            is_active=True
        )
        self.db.add(self.user)
        self.db.commit()
        self.db.refresh(self.user)

    def tearDown(self):
        self.db.close()

    def test_path_utils(self):
        os.environ["RESOFLOW_HOST_DATA_ROOT"] = "/home/testuser"
        os.environ["RESOFLOW_CONTAINER_DATA_ROOT"] = "/data/projects"
        try:
            self.assertEqual(to_container_path("/home/testuser/myproject"), "/data/projects/myproject")
            self.assertEqual(to_host_path("/data/projects/myproject"), "/home/testuser/myproject")
        finally:
            del os.environ["RESOFLOW_HOST_DATA_ROOT"]
            del os.environ["RESOFLOW_CONTAINER_DATA_ROOT"]

    def test_load_and_import_project_test_directory(self):
        test_dir = "/home/debadutta/Documents/test"
        if not os.path.exists(test_dir):
            self.skipTest(f"{test_dir} not found on host")

        # 1. Test load_project_from_json
        data = load_project_from_json(test_dir)
        self.assertEqual(data["name"], "test")
        self.assertEqual(data["project_uuid"], "2e4241b323074cddbdc5ddc27ae19a8c")
        self.assertEqual(len(data["spectra"]), 6)
        self.assertGreaterEqual(len(data.get("analyses", [])), 7)

        # 2. Test import_project end-to-end
        req = schemas.ProjectImportRequest(directory_path=test_dir)
        proj = import_project(req, current_user=self.user, db=self.db)
        self.assertEqual(proj.name == "test", True)
        self.assertEqual(len(proj.spectra), 6)
        self.assertGreaterEqual(len(proj.analyses), 7)

        # 3. Test idempotency (re-importing should not violate unique constraints)
        proj2 = import_project(req, current_user=self.user, db=self.db)
        self.assertEqual(proj2.id, proj.id)
        self.assertEqual(len(proj2.spectra), 6)
        self.assertGreaterEqual(len(proj2.analyses), 7)

        # 4. Test cascade deletion
        proj_id = proj.id
        self.db.delete(proj)
        self.db.commit()

        orphans_s = self.db.query(models.Spectrum).filter(models.Spectrum.project_id == proj_id).all()
        self.assertEqual(len(orphans_s), 0)
        orphans_a = self.db.query(models.Analysis).filter(models.Analysis.project_id == proj_id).all()
        self.assertEqual(len(orphans_a), 0)
