import json
import os
from unittest.mock import patch, MagicMock
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models, security
from app.routers.exchange import (
    generate_exchange_files,
    get_exchange_config,
    update_exchange_config,
    get_exchange_profiles,
    get_exchange_method_parameters,
    get_exchange_logs,
    run_exchange_analysis,
    _get_exchange_run_dir,
)
from app.services.fitting.chemex_jobs import build_fit_spec
from app.services.fitting.exchange_tasks import _setup_exchange_directory
from app.services.fitting.experiments.models import GeneratedExperiment


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
        email="exchange_test@lab.org",
        full_name="Exchange Tester",
        hashed_password=security.get_password_hash("password123"),
        is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    project_dir = tmp_path / "project"
    project_dir.mkdir(parents=True, exist_ok=True)

    project = models.Project(
        name="Exchange Project",
        project_uuid="proj-uuid-1",
        user_id=user.id,
        local_directory_path=str(project_dir),
    )
    db.add(project)
    db.commit()
    db.refresh(project)

    analysis = models.Analysis(
        name="combined_exchange",
        analysis_uuid="an-uuid-1",
        analysis_type="EXCHANGE",
        status="SETUP",
        project_id=project.id,
    )
    db.add(analysis)
    db.commit()
    db.refresh(analysis)

    yield db, user, project, analysis
    db.close()


def test_generate_exchange_files_detects_cpmg_and_cest(db_session):
    db, user, project, analysis = db_session

    s1 = models.Spectrum(
        name="s_cpmg_rd.ft2",
        spectrum_uuid="spec-1",
        project_id=project.id,
        experiment_type="CPMG-RD",
        b0=600.0,
        is_fitted=True,
    )
    s2 = models.Spectrum(
        name="s_cpmg_plain.ft2",
        spectrum_uuid="spec-2",
        project_id=project.id,
        experiment_type="CPMG",
        b0=800.0,
        is_fitted=True,
    )
    s3 = models.Spectrum(
        name="s_cest.ft2",
        spectrum_uuid="spec-3",
        project_id=project.id,
        experiment_type="CEST",
        b0=600.0,
        b1=30.0,
        is_fitted=True,
    )
    s4 = models.Spectrum(
        name="s_none.ft2",
        spectrum_uuid="spec-4",
        project_id=project.id,
        experiment_type=None,
        b0=600.0,
        is_fitted=False,
    )
    db.add_all([s1, s2, s3, s4])
    db.commit()

    mock_gen_cpmg = GeneratedExperiment(
        toml_content="[experiment]\ntype = 'cpmg'",
        written_data_files={"10ALA": "data1.dat", "11GLY": "data2.dat"},
        inspection_profiles=[
            {
                "residue": "10ALA",
                "full_residue": "A10",
                "cs_a": 120.5,
                "overall_rex": 5.2,
                "estimated_dw": 2.1,
                "experiments": [{"b0": 600.0, "r2eff": [10.0], "nu_cpmg": [100.0]}],
            }
        ],
        settings_hash="hash1",
    )
    mock_gen_cest = GeneratedExperiment(
        toml_content="[experiment]\ntype = 'cest'",
        written_data_files={"10ALA": "res1.dat"},
        inspection_profiles=[
            {
                "residue": "10ALA",
                "full_residue": "A10",
                "profile": [],
            }
        ],
        settings_hash="hash2",
    )

    with patch("app.routers.exchange.build_cpmg_experiment", return_value=mock_gen_cpmg) as mock_cpmg_build, \
         patch("app.routers.exchange.build_cest_experiment", return_value=mock_gen_cest) as mock_cest_build:
        result = generate_exchange_files(
            request={"spectrum_ids": [s1.id, s2.id, s3.id, s4.id], "model": "2st"},
            analysis=analysis,
            db=db,
            current_user=user,
        )

        assert result["status"] == "success"
        experiments = result["experiments"]
        assert len(experiments) == 3

        # s1 (CPMG-RD) and s2 (CPMG) both invoked build_cpmg_experiment
        assert mock_cpmg_build.call_count == 2
        # s3 (CEST) invoked build_cest_experiment
        assert mock_cest_build.call_count == 1

        filenames = [e["filename"] for e in experiments]
        assert any("cpmg_600MHz_spec_1.toml" in fn for fn in filenames)
        assert any("cpmg_800MHz_spec_2.toml" in fn for fn in filenames)
        assert any("cest_600MHz_30hz.toml" in fn for fn in filenames)

        # Check cpmg_profiles and parameter_config
        assert len(result["cpmg_profiles"]) >= 1
        assert "parameter_config" in result
        assert "globals" in result["parameter_config"]
        assert "pb" in result["parameter_config"]["globals"]
        assert "kex_ab" in result["parameter_config"]["globals"]


def test_exchange_config_get_and_put(db_session):
    db, user, project, analysis = db_session

    # PUT config
    new_cfg = {"model": "2st", "test_param": "hello_exchange"}
    res_put = update_exchange_config(
        request=new_cfg,
        analysis=analysis,
        db=db,
        current_user=user,
    )
    assert res_put["status"] == "success"

    # GET config
    res_get = get_exchange_config(analysis=analysis, current_user=user)
    assert res_get.get("test_param") == "hello_exchange"
    assert res_get.get("model") == "2st"


def test_get_exchange_method_parameters(db_session):
    db, user, project, analysis = db_session

    res_2st = get_exchange_method_parameters(model="2st", analysis=analysis, current_user=user)
    params_2st = res_2st["parameters"] if isinstance(res_2st, dict) and "parameters" in res_2st else res_2st
    param_names_2st = [p["name"] for p in params_2st]
    assert "PB" in param_names_2st
    assert "KEX_AB" in param_names_2st
    assert "CS_A" in param_names_2st
    assert "DW_AB" in param_names_2st
    assert "R1_B" in param_names_2st
    assert "R2_B" in param_names_2st

    res_3st = get_exchange_method_parameters(model="3st", analysis=analysis, current_user=user)
    params_3st = res_3st["parameters"] if isinstance(res_3st, dict) and "parameters" in res_3st else res_3st
    param_names_3st = [p["name"] for p in params_3st]
    assert "PC" in param_names_3st
    assert "KEX_BC" in param_names_3st
    assert "R1_C" in param_names_3st
    assert "R2_C" in param_names_3st


def test_run_exchange_analysis_dispatches_celery_task(db_session):
    db, user, project, analysis = db_session

    with patch("app.routers.exchange.run_exchange_analysis_task.apply_async") as mock_apply:
        res = run_exchange_analysis(
            request={"model": "2st"},
            analysis=analysis,
            db=db,
            current_user=user,
        )

        assert res["status"] == "PENDING"
        assert res["analysis_uuid"] == analysis.analysis_uuid
        assert mock_apply.called
        call_kwargs = mock_apply.call_args[1]
        assert call_kwargs["queue"] == "chemex"


def test_exchange_chemex_command_builder(tmp_path):
    run_dir = tmp_path / "exchange_run"
    exp_dir = run_dir / "Experiments"
    exp_dir.mkdir(parents=True)
    param_dir = run_dir / "Parameters"
    param_dir.mkdir(parents=True)
    methods_dir = run_dir / "Methods"
    methods_dir.mkdir(parents=True)

    (exp_dir / "cest_600mhz.toml").write_text("[experiment]")
    (exp_dir / "cpmg_600mhz.toml").write_text("[experiment]")
    (param_dir / "parameters.toml").write_text("[GLOBAL]")
    (methods_dir / "method.toml").write_text("[STEP1]")

    dirs = {
        "experiments_dir": str(exp_dir),
        "parameters_dir": str(param_dir),
        "methods_dir": str(methods_dir),
    }
    spec = build_fit_spec(dirs, {"model": "2st"}, job_dir=run_dir)

    assert spec.model == "2st"
    assert any("cest_600mhz.toml" in x for x in spec.experiment_files)
    assert any("cpmg_600mhz.toml" in x for x in spec.experiment_files)

    # Add stale ChemEx output files to parameters_dir
    (param_dir / "constrained.toml").write_text("[DW_AB]")
    (param_dir / "fitted.toml").write_text("[CS_A]")
    (param_dir / "fixed.toml").write_text("[R1_A]")

    spec2 = build_fit_spec(dirs, {"model": "2st"}, job_dir=run_dir)
    # Verify ONLY parameters.toml is passed in parameter_files
    assert len(spec2.parameter_files) == 1
    assert spec2.parameter_files[0].endswith("parameters.toml")
    assert not any("constrained.toml" in x for x in spec2.parameter_files)
    assert not any("fitted.toml" in x for x in spec2.parameter_files)
    assert not any("fixed.toml" in x for x in spec2.parameter_files)

    # Test that _setup_exchange_directory cleans stale toml files
    config_dict = {
        "parameters_toml": "[GLOBAL]\nPB = 0.05",
        "method_toml": "[STEP1]",
        "experiments": [],
    }
    _setup_exchange_directory(str(run_dir), config_dict)
    assert not (param_dir / "constrained.toml").exists()
    assert not (param_dir / "fitted.toml").exists()
    assert not (param_dir / "fixed.toml").exists()
    assert (param_dir / "parameters.toml").exists()



def test_exchange_logs_include_progress_and_status(db_session):
    """The Exchange logs route reports live progress (incl. current method step) like CEST/CPMG."""
    db, user, project, analysis = db_session
    run_dir = _get_exchange_run_dir(analysis)
    with open(os.path.join(run_dir, "chemex.log"), "w") as f:
        f.write("hello\n")
    progress = {"kind": "fit", "iteration": 4, "redchi": 1.2, "step": {"name": "GLOBAL_FIT", "index": 1, "total": 2}}
    with open(os.path.join(run_dir, "progress.json"), "w") as f:
        json.dump(progress, f)

    res = get_exchange_logs(analysis=analysis, current_user=user)
    assert res["logs"] == "hello\n"
    assert res["status"] == "SETUP"
    assert res["progress"]["step"]["name"] == "GLOBAL_FIT"
