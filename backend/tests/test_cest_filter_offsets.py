import json
import os
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models, security
from app.routers.analysis import generate_cest_files


@pytest.fixture
def db_session(tmp_path):
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    models.Base.metadata.create_all(bind=engine)
    Session = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    db = Session()

    user = models.User(
        email="cest_test@lab.org",
        full_name="CEST Tester",
        hashed_password=security.get_password_hash("password123"),
        is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    yield db, user
    db.close()


def _create_mock_files(tmp_path):
    # Create fake f3list
    f3list_file = tmp_path / "f3list.txt"
    f3list_file.write_text("117.0\n118.0\n119.0\n")

    # Create fake peak fitting results JSON
    results_file = tmp_path / "results.json"
    results_data = {
        "results": [
            {
                "assignment": "10ALA",
                "res_num": "10",
                "res_name": "ALA",
                "planes": [
                    {"plane": 0, "height": 1000.0, "height_err": 10.0},
                    {"plane": 1, "height": 900.0, "height_err": 10.0},
                    {"plane": 2, "height": 850.0, "height_err": 10.0},
                ],
            }
        ]
    }
    results_file.write_text(json.dumps(results_data))

    return str(f3list_file), str(results_file)


def test_default_filter_offsets_by_b1(tmp_path, db_session):
    db, user = db_session
    f3list_path, results_path = _create_mock_files(tmp_path)

    project_dir = tmp_path / "test_project"
    project_dir.mkdir()

    project = models.Project(
        name="CEST Test Project",
        local_directory_path=str(project_dir),
        user_id=user.id,
    )
    db.add(project)
    db.commit()
    db.refresh(project)

    analysis = models.Analysis(
        name="Test CEST Analysis",
        analysis_type="15N-CEST",
        project_id=project.id,
        status="CONFIGURED",
    )
    db.add(analysis)

    # Spectrum 1: B1 = 25.0 Hz
    s1 = models.Spectrum(
        name="spec_25hz.ft2",
        project_id=project.id,
        experiment_type="CEST",
        is_fitted=True,
        b1=25.0,
        b0=600.0,
        carrier=117.0,
        t_relax=0.5,
        f3list_path=f3list_path,
        results_json_path=results_path,
    )
    # Spectrum 2: B1 = 50.0 Hz
    s2 = models.Spectrum(
        name="spec_50hz.ft2",
        project_id=project.id,
        experiment_type="CEST",
        is_fitted=True,
        b1=50.0,
        b0=600.0,
        carrier=117.0,
        t_relax=0.5,
        f3list_path=f3list_path,
        results_json_path=results_path,
    )
    db.add_all([s1, s2])
    db.commit()
    db.refresh(analysis)
    db.refresh(s1)
    db.refresh(s2)

    # 1. Generate without filter_offsets passed in request:
    # Each spectrum should default to [0.0, B1]
    res = generate_cest_files(
        request={"spectrum_ids": [s1.id, s2.id]},
        analysis=analysis,
        db=db,
        current_user=user,
    )

    experiments = res["experiments"]
    assert len(experiments) == 2

    exp_25 = next(e for e in experiments if e["b1"] == 25.0)
    exp_50 = next(e for e in experiments if e["b1"] == 50.0)

    assert "filter_offsets = [[0.0, 25.0]]" in exp_25["toml_content"]
    assert "filter_offsets = [[0.0, 50.0]]" in exp_50["toml_content"]


def test_custom_filter_offsets_by_spectrum(tmp_path, db_session):
    db, user = db_session
    f3list_path, results_path = _create_mock_files(tmp_path)

    project_dir = tmp_path / "test_project_custom"
    project_dir.mkdir()

    project = models.Project(
        name="Custom Offsets Project",
        local_directory_path=str(project_dir),
        user_id=user.id,
    )
    db.add(project)
    db.commit()

    analysis = models.Analysis(
        name="Custom CEST Analysis",
        analysis_type="15N-CEST",
        project_id=project.id,
        status="CONFIGURED",
    )
    db.add(analysis)

    s1 = models.Spectrum(
        name="spec_25hz.ft2",
        project_id=project.id,
        experiment_type="CEST",
        is_fitted=True,
        b1=25.0,
        b0=600.0,
        carrier=117.0,
        t_relax=0.5,
        f3list_path=f3list_path,
        results_json_path=results_path,
    )
    s2 = models.Spectrum(
        name="spec_66hz.ft2",
        project_id=project.id,
        experiment_type="CEST",
        is_fitted=True,
        b1=66.8,
        b0=600.0,
        carrier=117.0,
        t_relax=0.5,
        f3list_path=f3list_path,
        results_json_path=results_path,
    )
    db.add_all([s1, s2])
    db.commit()
    db.refresh(analysis)
    db.refresh(s1)
    db.refresh(s2)

    # Provide explicit filter_offsets_by_spectrum
    custom_offsets = {
        s1.id: [[0.0, 25.0], [500.0, 30.0]],
        # s2 omitted: should default to [0.0, 66.8]
    }
    res = generate_cest_files(
        request={
            "spectrum_ids": [s1.id, s2.id],
            "filter_offsets_by_spectrum": custom_offsets,
        },
        analysis=analysis,
        db=db,
        current_user=user,
    )

    experiments = res["experiments"]
    exp_25 = next(e for e in experiments if e["b1"] == 25.0)
    exp_66 = next(e for e in experiments if e["b1"] == 66.8)

    assert "filter_offsets = [[0.0, 25.0], [500.0, 30.0]]" in exp_25["toml_content"]
    assert "filter_offsets = [[0.0, 66.8]]" in exp_66["toml_content"]


def test_flat_list_carrier_adaptation(tmp_path, db_session):
    db, user = db_session
    f3list_path, results_path = _create_mock_files(tmp_path)

    project_dir = tmp_path / "test_project_flat"
    project_dir.mkdir()

    project = models.Project(
        name="Flat List Adaptation Project",
        local_directory_path=str(project_dir),
        user_id=user.id,
    )
    db.add(project)
    db.commit()

    analysis = models.Analysis(
        name="Flat List CEST Analysis",
        analysis_type="15N-CEST",
        project_id=project.id,
        status="CONFIGURED",
    )
    db.add(analysis)

    s1 = models.Spectrum(
        name="spec_25hz.ft2",
        project_id=project.id,
        experiment_type="CEST",
        is_fitted=True,
        b1=25.0,
        b0=600.0,
        carrier=117.0,
        t_relax=0.5,
        f3list_path=f3list_path,
        results_json_path=results_path,
    )
    s2 = models.Spectrum(
        name="spec_50hz.ft2",
        project_id=project.id,
        experiment_type="CEST",
        is_fitted=True,
        b1=50.0,
        b0=600.0,
        carrier=117.0,
        t_relax=0.5,
        f3list_path=f3list_path,
        results_json_path=results_path,
    )
    db.add_all([s1, s2])
    db.commit()
    db.refresh(analysis)
    db.refresh(s1)
    db.refresh(s2)

    # Legacy flat list containing offset 0
    res = generate_cest_files(
        request={
            "spectrum_ids": [s1.id, s2.id],
            "filter_offsets": [[0.0, 25.0], [1000.0, 50.0]],
        },
        analysis=analysis,
        db=db,
        current_user=user,
    )

    experiments = res["experiments"]
    exp_25 = next(e for e in experiments if e["b1"] == 25.0)
    exp_50 = next(e for e in experiments if e["b1"] == 50.0)

    # 25 Hz has B1=25.0 carrier filter + 1000.0
    assert "filter_offsets = [[0.0, 25.0], [1000.0, 50.0]]" in exp_25["toml_content"]
    # 50 Hz adapts carrier filter to 50.0 + 1000.0
    assert "filter_offsets = [[0.0, 50.0], [1000.0, 50.0]]" in exp_50["toml_content"]
