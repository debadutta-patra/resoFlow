"""Project settings / user preferences: partial updates, ownership, project.json dual-write."""

import json
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import database, models, security
from app.main import app
from app.services.project_settings import (
    ProjectSettingsUpdate,
    load_project_settings,
    merge_project_settings,
)


@pytest.fixture()
def env():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    models.Base.metadata.create_all(bind=engine)
    Session = sessionmaker(autocommit=False, autoflush=False, bind=engine)

    def override_get_db():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[database.get_db] = override_get_db
    tmp = tempfile.TemporaryDirectory()
    db = Session()
    users = []
    for email in ("a@test.com", "b@test.com"):
        u = models.User(email=email, full_name=email, hashed_password=security.get_password_hash("pw123456"), is_active=True)
        db.add(u)
        users.append(u)
    db.commit()
    proj_dir = Path(tmp.name) / "proj"
    proj_dir.mkdir()
    project = models.Project(name="P", local_directory_path=str(proj_dir), user_id=users[0].id)
    db.add(project)
    db.commit()
    client = TestClient(app)

    def headers(email):
        r = client.post("/auth/login", data={"username": email, "password": "pw123456"})
        assert r.status_code == 200, r.text
        return {"Authorization": f"Bearer {r.json()['access_token']}"}

    yield client, project.project_uuid, proj_dir, headers
    db.close()
    app.dependency_overrides.clear()
    tmp.cleanup()


def test_defaults_and_partial_update(env):
    client, puuid, proj_dir, headers = env
    h = headers("a@test.com")
    r = client.get(f"/api/projects/{puuid}/settings", headers=h)
    assert r.status_code == 200
    assert r.json() == {"sequence_offset": 0, "scientific_checks": {}, "named_selections": [], "method_templates": []}

    sel = {"id": "s1", "name": "dip residues", "residues": ["14N", "23N"]}
    r = client.patch(f"/api/projects/{puuid}/settings", json={"named_selections": [sel]}, headers=h)
    assert r.status_code == 200
    r = client.patch(f"/api/projects/{puuid}/settings", json={"sequence_offset": 5}, headers=h)
    body = r.json()
    # The second update kept the first key.
    assert body["sequence_offset"] == 5
    assert body["named_selections"][0]["name"] == "dip residues"

    # Dual-written to project.json.
    data = json.loads((proj_dir / "project.json").read_text())
    assert data["settings"]["named_selections"][0]["residues"] == ["14N", "23N"]
    assert data["settings"]["sequence_offset"] == 5


def test_other_user_cannot_read_or_write(env):
    client, puuid, _, headers = env
    h = headers("b@test.com")
    assert client.get(f"/api/projects/{puuid}/settings", headers=h).status_code in (403, 404)
    assert client.patch(f"/api/projects/{puuid}/settings", json={"sequence_offset": 1}, headers=h).status_code in (403, 404)


def test_rejects_unknown_keys(env):
    client, puuid, _, headers = env
    r = client.patch(f"/api/projects/{puuid}/settings", json={"bogus": 1}, headers=headers("a@test.com"))
    assert r.status_code == 422


def test_user_preferences(env):
    client, _, _, headers = env
    h = headers("a@test.com")
    assert client.get("/api/users/me/preferences", headers=h).json() == {"method_templates": []}
    tmpl = {"id": "t1", "name": "Mine", "description": "d", "config": {"steps": []}}
    r = client.patch("/api/users/me/preferences", json={"method_templates": [tmpl]}, headers=h)
    assert r.status_code == 200
    assert client.get("/api/users/me/preferences", headers=h).json()["method_templates"][0]["name"] == "Mine"
    # Private to the user.
    assert client.get("/api/users/me/preferences", headers=headers("b@test.com")).json() == {"method_templates": []}


def test_lenient_load_drops_bad_and_unknown_values():
    s = load_project_settings({"sequence_offset": "x", "future_key": 1, "named_selections": []})
    assert s.sequence_offset == 0
    merged = merge_project_settings({"sequence_offset": 3}, ProjectSettingsUpdate(scientific_checks={"b1_fields": {"enabled": False}}))
    assert merged.sequence_offset == 3 and merged.scientific_checks["b1_fields"].enabled is False
