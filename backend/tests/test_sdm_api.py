# Copyright (C) 2026 resoFlow Authors
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

"""
API-level tests for spectral density mapping: input validation, project
scoping, and the experimental Rex feature gate.

Follows the pattern in test_dashboard_scoping.py -- in-memory SQLite, the
real FastAPI app with get_db overridden, two users so cross-user isolation
is exercised rather than assumed.
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import database, models, security
from app.features import ENABLE_EXPERIMENTAL_SDM_REX
from app.main import app

SDM_URL = "/api/projects/{p}/spectral-density"


def _peak_results(rates, errs, assignments):
    return {
        "peak_results": [
            {
                "assignment": a,
                "res_num": int("".join(c for c in a if c.isdigit()) or 0),
                "res_name": "GLY",
                "rate": r,
                "rate_err": e,
            }
            for a, r, e in zip(assignments, rates, errs)
        ]
    }


class TestSpectralDensityApi(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = create_engine(
            "sqlite:///:memory:",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        cls.TestingSessionLocal = sessionmaker(
            autocommit=False, autoflush=False, bind=cls.engine
        )
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
        self.db = self.TestingSessionLocal()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        os.environ.pop(ENABLE_EXPERIMENTAL_SDM_REX, None)
        self.addCleanup(lambda: os.environ.pop(ENABLE_EXPERIMENTAL_SDM_REX, None))

        self.user_a = models.User(
            email="a@test.com", full_name="A",
            hashed_password=security.get_password_hash("pw"),
            is_active=True, is_superuser=False,
        )
        self.user_b = models.User(
            email="b@test.com", full_name="B",
            hashed_password=security.get_password_hash("pw"),
            is_active=True, is_superuser=False,
        )
        self.db.add_all([self.user_a, self.user_b])
        self.db.commit()

        self.project = models.Project(
            name="P", local_directory_path=self.tmp.name, user_id=self.user_a.id
        )
        self.project_b = models.Project(
            name="PB", local_directory_path=self.tmp.name, user_id=self.user_b.id
        )
        self.db.add_all([self.project, self.project_b])
        self.db.commit()
        self.db.refresh(self.project)
        self.db.refresh(self.project_b)

        self.token_a = security.create_access_token(data={"sub": self.user_a.email})
        self.token_b = security.create_access_token(data={"sub": self.user_b.email})

    def tearDown(self):
        self.db.close()

    # -- helpers ---------------------------------------------------------

    def _auth(self, token):
        return {"Authorization": f"Bearer {token}"}

    def _make_source(self, project, atype, rates, errs, assignments, b0=600.13,
                     status="COMPLETED"):
        spectrum = models.Spectrum(
            name=f"{atype}-spec", file_path="/nowhere", project_id=project.id, b0=b0
        )
        self.db.add(spectrum)
        self.db.commit()
        self.db.refresh(spectrum)

        analysis = models.Analysis(
            name=f"{atype} run", analysis_type=atype,
            project_id=project.id, status=status,
        )
        analysis.spectra = [spectrum]
        self.db.add(analysis)
        self.db.commit()
        self.db.refresh(analysis)

        run_dir = os.path.join(self.tmp.name, f"{atype.lower()}_fitting",
                               analysis.analysis_uuid)
        os.makedirs(run_dir, exist_ok=True)
        path = os.path.join(run_dir, "results.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(_peak_results(rates, errs, assignments), handle)
        analysis.results_path = path
        self.db.commit()
        self.db.refresh(analysis)
        return analysis

    def _standard_sources(self, project=None, b0_r2=600.13, assignments=None):
        project = project or self.project
        assignments = assignments or ["G10N", "A11N", "L12N", "V13N"]
        n = len(assignments)
        r1 = self._make_source(project, "R1", [1.35] * n, [0.03] * n, assignments)
        r2 = self._make_source(project, "R2", [12.1] * n, [0.30] * n, assignments,
                               b0=b0_r2)
        noe = self._make_source(project, "hetNOE", [0.78] * n, [0.04] * n, assignments)
        return r1, r2, noe

    def _create_body(self, r1, r2, noe, **overrides):
        body = {
            "name": "SDM run",
            "source_r1_analysis_uuid": r1.analysis_uuid,
            "source_r2_analysis_uuid": r2.analysis_uuid,
            "source_noe_analysis_uuid": noe.analysis_uuid,
        }
        body.update(overrides)
        return body

    # -- happy path ------------------------------------------------------

    def test_create_and_fetch_spectral_density(self):
        r1, r2, noe = self._standard_sources()
        resp = self.client.post(
            SDM_URL.format(p=self.project.project_uuid),
            json=self._create_body(r1, r2, noe),
            headers=self._auth(self.token_a),
        )
        self.assertEqual(resp.status_code, 201, resp.text)
        body = resp.json()
        self.assertEqual(body["status"], "COMPLETED")
        self.assertFalse(body["experimental"])

        results = body["results"]
        self.assertEqual(len(results["residues"]), 4)
        self.assertEqual(results["j_units"], "ns/rad")
        self.assertEqual(results["b0_h_mhz"], 600.13)
        # The J(0) exchange caveat travels with the results, not only the docs.
        self.assertIn("exchange", results["j0_caveat"].lower())

        row = results["residues"][0]
        self.assertEqual(len(row["covariance"]), 3)
        self.assertEqual(len(row["covariance"][0]), 3)
        # Full covariance, not just variances: off-diagonals are populated.
        self.assertNotEqual(row["covariance"][0][1], 0.0)
        # Inputs are echoed so a row is self-contained.
        for key in ("r1", "r2", "noe", "sigma", "j0", "j_wn", "j_h"):
            self.assertIn(key, row)

        uuid = body["analysis_uuid"]
        detail = self.client.get(
            f"{SDM_URL.format(p=self.project.project_uuid)}/{uuid}",
            headers=self._auth(self.token_a),
        )
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(len(detail.json()["results"]["residues"]), 4)

    def test_constants_snapshot_distinguishes_runs(self):
        """Re-running with a different CSA must be self-describing."""
        r1, r2, noe = self._standard_sources()
        url = SDM_URL.format(p=self.project.project_uuid)

        first = self.client.post(
            url, json=self._create_body(r1, r2, noe), headers=self._auth(self.token_a)
        ).json()
        second = self.client.post(
            url,
            json=self._create_body(
                r1, r2, noe, name="other CSA",
                constants={"r_nh_preset": "1.02", "delta_sigma_preset": "-172"},
            ),
            headers=self._auth(self.token_a),
        ).json()

        snap_a = first["results"]["constants_snapshot"]
        snap_b = second["results"]["constants_snapshot"]
        self.assertNotEqual(snap_a, snap_b)
        self.assertAlmostEqual(snap_a["delta_sigma_ppm"], -160.0)
        self.assertAlmostEqual(snap_b["delta_sigma_ppm"], -172.0)
        # A different CSA must actually move J(0).
        self.assertNotAlmostEqual(
            first["results"]["residues"][0]["j0"],
            second["results"]["residues"][0]["j0"],
        )

    def test_list_endpoint_returns_created_analyses(self):
        r1, r2, noe = self._standard_sources()
        url = SDM_URL.format(p=self.project.project_uuid)
        self.client.post(url, json=self._create_body(r1, r2, noe),
                         headers=self._auth(self.token_a))
        listing = self.client.get(url, headers=self._auth(self.token_a))
        self.assertEqual(listing.status_code, 200)
        self.assertEqual(len(listing.json()), 1)
        self.assertEqual(listing.json()[0]["name"], "SDM run")

    def test_delete_removes_analysis(self):
        r1, r2, noe = self._standard_sources()
        url = SDM_URL.format(p=self.project.project_uuid)
        uuid = self.client.post(url, json=self._create_body(r1, r2, noe),
                                headers=self._auth(self.token_a)).json()["analysis_uuid"]
        resp = self.client.delete(f"{url}/{uuid}", headers=self._auth(self.token_a))
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(
            self.client.get(url, headers=self._auth(self.token_a)).json(), []
        )

    # -- 5.1.1 field consistency ----------------------------------------

    def test_field_mismatch_is_rejected_not_warned(self):
        """A 600/800 mix produces plausible nonsense, so it must hard-fail."""
        r1, r2, noe = self._standard_sources(b0_r2=800.2)
        resp = self.client.post(
            SDM_URL.format(p=self.project.project_uuid),
            json=self._create_body(r1, r2, noe),
            headers=self._auth(self.token_a),
        )
        self.assertEqual(resp.status_code, 422, resp.text)
        detail = resp.json()["detail"]
        self.assertIn("different static fields", detail["message"])
        # Every field is named so the UI can point at the odd one out.
        self.assertIn("fields_mhz", detail)
        self.assertEqual(detail["fields_mhz"]["R2"], 800.2)
        self.assertEqual(detail["fields_mhz"]["R1"], 600.13)

    def test_small_field_difference_is_tolerated(self):
        """Two '600 MHz' instruments rarely report identical frequencies."""
        r1, r2, noe = self._standard_sources(b0_r2=600.42)
        resp = self.client.post(
            SDM_URL.format(p=self.project.project_uuid),
            json=self._create_body(r1, r2, noe),
            headers=self._auth(self.token_a),
        )
        self.assertEqual(resp.status_code, 201, resp.text)

    def test_missing_b0_is_rejected_rather_than_defaulted(self):
        assignments = ["G10N", "A11N"]
        r1 = self._make_source(self.project, "R1", [1.3, 1.3], [0.03, 0.03],
                               assignments, b0=None)
        r2 = self._make_source(self.project, "R2", [12.0, 12.0], [0.3, 0.3],
                               assignments)
        noe = self._make_source(self.project, "hetNOE", [0.8, 0.8], [0.04, 0.04],
                                assignments)
        resp = self.client.post(
            SDM_URL.format(p=self.project.project_uuid),
            json=self._create_body(r1, r2, noe),
            headers=self._auth(self.token_a),
        )
        self.assertEqual(resp.status_code, 422)
        self.assertIn("static field", resp.json()["detail"]["message"])

    # -- 5.1.2 residue matching ------------------------------------------

    def test_residue_intersection_reports_specific_reasons(self):
        r1 = self._make_source(self.project, "R1", [1.3] * 4, [0.03] * 4,
                               ["G10N", "A11N", "L12N", "V13N"])
        r2 = self._make_source(self.project, "R2", [12.0] * 3, [0.3] * 3,
                               ["G10N", "A11N", "L12N"])
        noe = self._make_source(self.project, "hetNOE", [0.8] * 2, [0.04] * 2,
                                ["G10N", "A11N"])
        resp = self.client.post(
            SDM_URL.format(p=self.project.project_uuid),
            json=self._create_body(r1, r2, noe),
            headers=self._auth(self.token_a),
        )
        self.assertEqual(resp.status_code, 201, resp.text)
        results = resp.json()["results"]

        self.assertEqual(len(results["residues"]), 2)
        excluded = {e["residue"]: e["reason"] for e in results["excluded_residues"]}
        self.assertEqual(len(excluded), 2)
        self.assertIn("missing hetNOE", excluded["L12N"])
        self.assertIn("missing R2", excluded["V13N"])
        self.assertIn("missing hetNOE", excluded["V13N"])
        self.assertEqual(results["summary"]["n_excluded"], 2)

    def test_no_common_residues_is_rejected(self):
        r1 = self._make_source(self.project, "R1", [1.3], [0.03], ["G10N"])
        r2 = self._make_source(self.project, "R2", [12.0], [0.3], ["A11N"])
        noe = self._make_source(self.project, "hetNOE", [0.8], [0.04], ["L12N"])
        resp = self.client.post(
            SDM_URL.format(p=self.project.project_uuid),
            json=self._create_body(r1, r2, noe),
            headers=self._auth(self.token_a),
        )
        self.assertEqual(resp.status_code, 422)
        self.assertIn("nothing to map", resp.json()["detail"]["message"])

    # -- 5.1.5 negative NOE is valid --------------------------------------

    def test_negative_noe_is_mapped_and_flagged_not_filtered(self):
        assignments = ["G10N", "A11N"]
        r1 = self._make_source(self.project, "R1", [1.3, 1.3], [0.03, 0.03],
                               assignments)
        r2 = self._make_source(self.project, "R2", [12.0, 4.0], [0.3, 0.2],
                               assignments)
        noe = self._make_source(self.project, "hetNOE", [0.78, -0.55],
                                [0.04, 0.08], assignments)
        resp = self.client.post(
            SDM_URL.format(p=self.project.project_uuid),
            json=self._create_body(r1, r2, noe),
            headers=self._auth(self.token_a),
        )
        self.assertEqual(resp.status_code, 201, resp.text)
        results = resp.json()["results"]
        self.assertEqual(len(results["residues"]), 2)

        by_res = {r["assignment"]: r for r in results["residues"]}
        self.assertIn("negative_noe", by_res["A11N"]["flags"])
        self.assertEqual(by_res["G10N"]["flags"], [])
        # Flag descriptions travel with the summary so the UI can explain them.
        self.assertIn("negative_noe", results["summary"]["flag_descriptions"])

    # -- source state validation ------------------------------------------

    def test_incomplete_source_is_rejected(self):
        r1, r2, noe = self._standard_sources()
        r1.status = "RUNNING"
        self.db.commit()
        resp = self.client.post(
            SDM_URL.format(p=self.project.project_uuid),
            json=self._create_body(r1, r2, noe),
            headers=self._auth(self.token_a),
        )
        self.assertEqual(resp.status_code, 422)
        self.assertIn("COMPLETED", resp.json()["detail"]["message"])

    def test_unknown_source_uuid_is_404(self):
        r1, r2, noe = self._standard_sources()
        resp = self.client.post(
            SDM_URL.format(p=self.project.project_uuid),
            json=self._create_body(r1, r2, noe,
                                   source_r1_analysis_uuid="does-not-exist"),
            headers=self._auth(self.token_a),
        )
        self.assertEqual(resp.status_code, 404)

    # -- scoping ----------------------------------------------------------

    def test_cross_user_isolation(self):
        r1, r2, noe = self._standard_sources()
        url = SDM_URL.format(p=self.project.project_uuid)
        uuid = self.client.post(url, json=self._create_body(r1, r2, noe),
                                headers=self._auth(self.token_a)).json()["analysis_uuid"]

        # User B owns a different project and must not reach A's analysis.
        self.assertEqual(
            self.client.get(url, headers=self._auth(self.token_b)).status_code, 403
        )
        self.assertEqual(
            self.client.get(f"{url}/{uuid}",
                            headers=self._auth(self.token_b)).status_code, 403
        )
        self.assertEqual(
            self.client.delete(f"{url}/{uuid}",
                               headers=self._auth(self.token_b)).status_code, 403
        )
        self.assertEqual(
            self.client.get(f"{url}/{uuid}/export.csv",
                            headers=self._auth(self.token_b)).status_code, 403
        )

    def test_unauthenticated_access_is_rejected(self):
        url = SDM_URL.format(p=self.project.project_uuid)
        self.assertEqual(self.client.get(url).status_code, 401)
        self.assertEqual(self.client.post(url, json={}).status_code, 401)

    def test_analysis_from_another_project_is_not_reachable(self):
        r1, r2, noe = self._standard_sources()
        url = SDM_URL.format(p=self.project.project_uuid)
        uuid = self.client.post(url, json=self._create_body(r1, r2, noe),
                                headers=self._auth(self.token_a)).json()["analysis_uuid"]
        other = SDM_URL.format(p=self.project_b.project_uuid)
        # User B owns project_b, so this is a 404 on the analysis rather than
        # a 403 on the project -- the analysis simply is not in that project.
        self.assertEqual(
            self.client.get(f"{other}/{uuid}",
                            headers=self._auth(self.token_b)).status_code, 404
        )

    def test_non_sdm_analysis_uuid_is_not_served_by_this_router(self):
        r1, _, _ = self._standard_sources()
        url = SDM_URL.format(p=self.project.project_uuid)
        resp = self.client.get(f"{url}/{r1.analysis_uuid}",
                               headers=self._auth(self.token_a))
        self.assertEqual(resp.status_code, 404)
        self.assertIn("not a spectral density", resp.json()["detail"])

    # -- CSV export -------------------------------------------------------

    def test_csv_export_contains_values_and_provenance(self):
        r1, r2, noe = self._standard_sources()
        url = SDM_URL.format(p=self.project.project_uuid)
        uuid = self.client.post(url, json=self._create_body(r1, r2, noe),
                                headers=self._auth(self.token_a)).json()["analysis_uuid"]
        resp = self.client.get(f"{url}/{uuid}/export.csv",
                               headers=self._auth(self.token_a))
        self.assertEqual(resp.status_code, 200)
        self.assertIn("text/csv", resp.headers["content-type"])
        text = resp.text
        self.assertIn("J(0) [ns/rad]", text)
        self.assertIn("Cov J0-JwN", text)
        self.assertIn("variant=farrow1995", text)
        self.assertIn("delta_sigma=-160.0 ppm", text)
        self.assertIn("G10N", text)
        # A non-experimental export carries no experimental marker.
        self.assertNotIn("EXPERIMENTAL", text)

    def test_csv_export_lists_excluded_residues(self):
        r1 = self._make_source(self.project, "R1", [1.3] * 2, [0.03] * 2,
                               ["G10N", "A11N"])
        r2 = self._make_source(self.project, "R2", [12.0], [0.3], ["G10N"])
        noe = self._make_source(self.project, "hetNOE", [0.8], [0.04], ["G10N"])
        url = SDM_URL.format(p=self.project.project_uuid)
        uuid = self.client.post(url, json=self._create_body(r1, r2, noe),
                                headers=self._auth(self.token_a)).json()["analysis_uuid"]
        text = self.client.get(f"{url}/{uuid}/export.csv",
                               headers=self._auth(self.token_a)).text
        self.assertIn("# Excluded residues", text)
        self.assertIn("A11N", text)

    # -- 7. experimental Rex gate -----------------------------------------

    def test_rex_request_is_rejected_when_flag_is_disabled(self):
        r1, r2, noe = self._standard_sources()
        resp = self.client.post(
            SDM_URL.format(p=self.project.project_uuid),
            json=self._create_body(
                r1, r2, noe,
                rex_source="cpmg_analysis",
                rex_cpmg_analysis_uuid="some-cpmg-uuid",
            ),
            headers=self._auth(self.token_a),
        )
        self.assertEqual(resp.status_code, 422, resp.text)
        # The refusal names the flag, so the operator knows what to set.
        self.assertIn(ENABLE_EXPERIMENTAL_SDM_REX, resp.json()["detail"])

    def test_multi_field_rex_source_is_also_gated(self):
        r1, r2, noe = self._standard_sources()
        resp = self.client.post(
            SDM_URL.format(p=self.project.project_uuid),
            json=self._create_body(r1, r2, noe, rex_source="multi_field"),
            headers=self._auth(self.token_a),
        )
        self.assertEqual(resp.status_code, 422)
        self.assertIn(ENABLE_EXPERIMENTAL_SDM_REX, resp.json()["detail"])

    def test_schema_accepts_rex_field_regardless_of_the_flag(self):
        """Gating is at the API layer, so stored records still deserialise."""
        from app.services.sdm.schemas import RexSource, SpectralDensityCreate

        model = SpectralDensityCreate(
            name="x", source_r1_analysis_uuid="a",
            source_r2_analysis_uuid="b", source_noe_analysis_uuid="c",
            rex_source="cpmg_analysis", rex_cpmg_analysis_uuid="d",
        )
        self.assertEqual(model.rex_source, RexSource.CPMG_ANALYSIS)

    def test_default_request_is_not_experimental(self):
        r1, r2, noe = self._standard_sources()
        body = self.client.post(
            SDM_URL.format(p=self.project.project_uuid),
            json=self._create_body(r1, r2, noe),
            headers=self._auth(self.token_a),
        ).json()
        self.assertFalse(body["experimental"])
        self.assertIsNone(body["results"]["experimental_notice"])

    # -- capabilities ------------------------------------------------------

    def test_capabilities_reports_the_flag_state(self):
        resp = self.client.get("/api/capabilities")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertIn("features", body)
        self.assertFalse(body["features"]["experimental_sdm_rex"])
        # The flag name is advertised so the UI can tell the user what to set.
        self.assertEqual(
            body["flags"]["experimental_sdm_rex"], ENABLE_EXPERIMENTAL_SDM_REX
        )

    def test_capabilities_follows_the_environment(self):
        os.environ[ENABLE_EXPERIMENTAL_SDM_REX] = "true"
        body = self.client.get("/api/capabilities").json()
        self.assertTrue(body["features"]["experimental_sdm_rex"])

        os.environ[ENABLE_EXPERIMENTAL_SDM_REX] = "0"
        body = self.client.get("/api/capabilities").json()
        self.assertFalse(body["features"]["experimental_sdm_rex"])

    # -- error method ------------------------------------------------------

    def test_monte_carlo_error_method_produces_comparable_errors(self):
        r1, r2, noe = self._standard_sources()
        url = SDM_URL.format(p=self.project.project_uuid)
        analytic = self.client.post(
            url, json=self._create_body(r1, r2, noe),
            headers=self._auth(self.token_a),
        ).json()["results"]
        mc = self.client.post(
            url,
            json=self._create_body(
                r1, r2, noe, name="mc", error_method="monte_carlo",
                n_replicates=20000, seed=11,
            ),
            headers=self._auth(self.token_a),
        ).json()["results"]

        self.assertEqual(mc["error_method"], "monte_carlo")
        for key in ("j0_err", "j_wn_err", "j_h_err"):
            a = analytic["residues"][0][key]
            m = mc["residues"][0][key]
            self.assertAlmostEqual(a, m, delta=0.05 * abs(a))
        # Point estimates stay analytic; MC only replaces the covariance.
        self.assertAlmostEqual(
            analytic["residues"][0]["j0"], mc["residues"][0]["j0"], places=12
        )


if __name__ == "__main__":
    unittest.main()


class TestSpectralDensityReport(TestSpectralDensityApi):
    """PDF report generation goes through the shared generator, not a fork."""

    def test_report_renders_a_pdf_with_the_section(self):
        r1, r2, noe = self._standard_sources()
        url = SDM_URL.format(p=self.project.project_uuid)
        uuid = self.client.post(url, json=self._create_body(r1, r2, noe),
                                headers=self._auth(self.token_a)).json()["analysis_uuid"]
        resp = self.client.post(f"{url}/{uuid}/report",
                                headers=self._auth(self.token_a))
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.headers["content-type"], "application/pdf")
        self.assertTrue(resp.content.startswith(b"%PDF"))
        self.assertGreater(len(resp.content), 5000)

    def test_report_html_contains_the_spectral_density_section(self):
        """Assert on the rendered HTML, where the section content is legible."""
        from app.services.reporting.model import build_report_model
        from app.services.reporting.render import render_html

        r1, r2, noe = self._standard_sources()
        url = SDM_URL.format(p=self.project.project_uuid)
        created = self.client.post(url, json=self._create_body(r1, r2, noe),
                                   headers=self._auth(self.token_a)).json()

        analysis = (
            self.db.query(models.Analysis)
            .filter(models.Analysis.analysis_uuid == created["analysis_uuid"])
            .first()
        )
        run_dir = os.path.dirname(analysis.results_path)
        model = build_report_model(run_dir, analysis.name, analysis_type="SDM")
        html = render_html(model, style="screen")

        self.assertIn("Reduced Spectral Density Mapping", html)
        self.assertIn("J(0) vs J(", html)
        self.assertIn("Per-Residue Spectral Densities", html)
        self.assertIn("ns", html)
        # The J(0) exchange caveat is in the report as well as the UI.
        self.assertIn("assumes no chemical exchange", html)
        # The systematic band is described separately from statistical error.
        self.assertIn("not</em> included in the per-residue", html)
        # A non-experimental report carries no marker.
        self.assertNotIn("experimental-marker", html)

    def test_report_is_refused_for_an_incomplete_analysis(self):
        r1, r2, noe = self._standard_sources()
        url = SDM_URL.format(p=self.project.project_uuid)
        uuid = self.client.post(url, json=self._create_body(r1, r2, noe),
                                headers=self._auth(self.token_a)).json()["analysis_uuid"]
        analysis = (
            self.db.query(models.Analysis)
            .filter(models.Analysis.analysis_uuid == uuid).first()
        )
        analysis.status = "RUNNING"
        self.db.commit()
        resp = self.client.post(f"{url}/{uuid}/report",
                                headers=self._auth(self.token_a))
        self.assertEqual(resp.status_code, 400)

    def test_experimental_report_carries_the_footer_marker(self):
        """An experimental result must not escape looking validated.

        The marker is a page string, so it lands in EVERY page footer -- not
        just the cover someone might not print.
        """
        from app.services.reporting.model import build_report_model
        from app.services.reporting.render import render_html

        os.environ[ENABLE_EXPERIMENTAL_SDM_REX] = "true"
        r1, r2, noe = self._standard_sources()
        url = SDM_URL.format(p=self.project.project_uuid)
        created = self.client.post(
            url,
            json=self._create_body(r1, r2, noe, rex_source="multi_field"),
            headers=self._auth(self.token_a),
        )
        self.assertEqual(created.status_code, 201, created.text)
        body = created.json()
        self.assertTrue(body["experimental"])
        self.assertIn("EXPERIMENTAL", body["experimental_notice"])

        analysis = (
            self.db.query(models.Analysis)
            .filter(models.Analysis.analysis_uuid == body["analysis_uuid"]).first()
        )
        self.assertTrue(analysis.experimental)

        model = build_report_model(
            os.path.dirname(analysis.results_path), analysis.name, analysis_type="SDM"
        )
        html = render_html(model, style="screen")
        self.assertIn("experimental-marker", html)
        self.assertIn("EXPERIMENTAL", html)

        csv_text = self.client.get(f"{url}/{body['analysis_uuid']}/export.csv",
                                   headers=self._auth(self.token_a)).text
        self.assertTrue(csv_text.startswith("#"))
        self.assertIn("EXPERIMENTAL", csv_text.split("\n")[0])


class TestCpmgR2Provenance(TestSpectralDensityApi):
    """R2,0 from a CPMG fit as an alternative R2 provenance.

    ChemEx's fitted R2_A already has exchange removed by the fitted model, so
    this needs no Rex subtraction and is a PRODUCTION path -- it is not gated
    by the experimental flag and does not mark the analysis experimental.
    """

    def _make_cpmg(self, project, blocks, status="COMPLETED"):
        """Create a CPMG analysis whose fitted.toml holds R2_A blocks.

        Args:
            blocks: {field_label_or_None: {residue_key: (value, err)}}
        """
        analysis = models.Analysis(
            name="CPMG run", analysis_type="CPMG",
            project_id=project.id, status=status,
        )
        self.db.add(analysis)
        self.db.commit()
        self.db.refresh(analysis)

        run_dir = os.path.join(self.tmp.name, "cpmg_fitting", analysis.analysis_uuid)
        os.makedirs(os.path.join(run_dir, "Parameters"), exist_ok=True)
        lines = ["[DW_AB]", '15N = 2.13116e+00 # ±2.13113e-02', ""]
        for field, residues in blocks.items():
            lines.append(f'["R2_A, B0->{field}"]' if field else "[R2_A]")
            for res, (value, err) in residues.items():
                lines.append(f"{res} = {value:.5e} # ±{err:.5e}")
            lines.append("")
        with open(os.path.join(run_dir, "Parameters", "fitted.toml"), "w",
                  encoding="utf-8") as handle:
            handle.write("\n".join(lines))

        analysis.results_path = os.path.join(run_dir, "results.json")
        self.db.commit()
        self.db.refresh(analysis)
        return analysis

    def test_echo_decay_is_the_default_provenance(self):
        r1, r2, noe = self._standard_sources()
        body = self.client.post(
            SDM_URL.format(p=self.project.project_uuid),
            json=self._create_body(r1, r2, noe),
            headers=self._auth(self.token_a),
        ).json()
        self.assertEqual(body["results"]["r2_provenance"], "echo_decay")

    def test_cpmg_r2_0_is_used_when_requested(self):
        r1, _, noe = self._standard_sources()
        cpmg = self._make_cpmg(self.project, {"600.13MHZ": {"15N": (8.4, 0.21)}})
        # The R1/NOE sources must carry residue 15 for the intersection.
        r1 = self._make_source(self.project, "R1", [1.35], [0.03], ["G15N"])
        noe = self._make_source(self.project, "hetNOE", [0.78], [0.04], ["G15N"])

        resp = self.client.post(
            SDM_URL.format(p=self.project.project_uuid),
            json=self._create_body(r1, cpmg, noe, r2_provenance="cpmg_r2_0"),
            headers=self._auth(self.token_a),
        )
        self.assertEqual(resp.status_code, 201, resp.text)
        results = resp.json()["results"]
        self.assertEqual(results["r2_provenance"], "cpmg_r2_0")
        self.assertEqual(len(results["residues"]), 1)
        # The exchange-free R2,0 is what reached the mapping.
        self.assertAlmostEqual(results["residues"][0]["r2"], 8.4, places=4)
        self.assertAlmostEqual(results["residues"][0]["r2_err"], 0.21, places=4)

    def test_cpmg_r2_0_is_not_experimental(self):
        """R2,0 is exchange-free by construction, not an Rex correction."""
        cpmg = self._make_cpmg(self.project, {"600.13MHZ": {"15N": (8.4, 0.21)}})
        r1 = self._make_source(self.project, "R1", [1.35], [0.03], ["G15N"])
        noe = self._make_source(self.project, "hetNOE", [0.78], [0.04], ["G15N"])

        # The experimental Rex flag is off (setUp clears it) and this still works.
        body = self.client.post(
            SDM_URL.format(p=self.project.project_uuid),
            json=self._create_body(r1, cpmg, noe, r2_provenance="cpmg_r2_0"),
            headers=self._auth(self.token_a),
        ).json()
        self.assertFalse(body["experimental"])
        self.assertEqual(body["results"]["rex_source"], "none")
        self.assertIsNone(body["results"]["experimental_notice"])

    def test_multi_field_cpmg_selects_the_matching_block(self):
        """The critical case: a 500/800 fit must not hand back the wrong field.

        The same residue differs by two thirds between blocks, and the general
        ChemEx parser collapses them because it strips the B0 qualifier. This
        asserts the field-aware selection actually selects.
        """
        cpmg = self._make_cpmg(self.project, {
            "500.0MHZ": {"15N": (4.00996, 0.227191)},
            "800.0MHZ": {"15N": (6.67323, 0.342271)},
        })
        r1 = self._make_source(self.project, "R1", [1.35], [0.03], ["G15N"], b0=800.0)
        noe = self._make_source(self.project, "hetNOE", [0.78], [0.04], ["G15N"], b0=800.0)

        body = self.client.post(
            SDM_URL.format(p=self.project.project_uuid),
            json=self._create_body(r1, cpmg, noe, r2_provenance="cpmg_r2_0"),
            headers=self._auth(self.token_a),
        )
        self.assertEqual(body.status_code, 201, body.text)
        row = body.json()["results"]["residues"][0]
        self.assertAlmostEqual(row["r2"], 6.67323, places=4)
        self.assertNotAlmostEqual(row["r2"], 4.00996, places=2)

        # And the 500 MHz mapping picks the other block.
        r1_500 = self._make_source(self.project, "R1", [1.35], [0.03], ["G15N"], b0=500.0)
        noe_500 = self._make_source(self.project, "hetNOE", [0.78], [0.04], ["G15N"], b0=500.0)
        row_500 = self.client.post(
            SDM_URL.format(p=self.project.project_uuid),
            json=self._create_body(r1_500, cpmg, noe_500, name="500",
                                   r2_provenance="cpmg_r2_0"),
            headers=self._auth(self.token_a),
        ).json()["results"]["residues"][0]
        self.assertAlmostEqual(row_500["r2"], 4.00996, places=4)

    def test_missing_field_block_is_rejected_with_the_available_fields(self):
        cpmg = self._make_cpmg(self.project, {
            "500.0MHZ": {"15N": (4.00996, 0.227191)},
            "800.0MHZ": {"15N": (6.67323, 0.342271)},
        })
        r1 = self._make_source(self.project, "R1", [1.35], [0.03], ["G15N"], b0=600.13)
        noe = self._make_source(self.project, "hetNOE", [0.78], [0.04], ["G15N"], b0=600.13)

        resp = self.client.post(
            SDM_URL.format(p=self.project.project_uuid),
            json=self._create_body(r1, cpmg, noe, r2_provenance="cpmg_r2_0"),
            headers=self._auth(self.token_a),
        )
        self.assertEqual(resp.status_code, 422, resp.text)
        detail = resp.json()["detail"]
        self.assertIn("no R2,0 at 600.13 MHz", detail["message"])
        self.assertEqual(detail["available_mhz"], [500.0, 800.0])

    def test_single_field_block_without_a_qualifier_is_accepted(self):
        cpmg = self._make_cpmg(self.project, {None: {"15N": (8.4, 0.21)}})
        r1 = self._make_source(self.project, "R1", [1.35], [0.03], ["G15N"])
        noe = self._make_source(self.project, "hetNOE", [0.78], [0.04], ["G15N"])
        resp = self.client.post(
            SDM_URL.format(p=self.project.project_uuid),
            json=self._create_body(r1, cpmg, noe, r2_provenance="cpmg_r2_0"),
            headers=self._auth(self.token_a),
        )
        self.assertEqual(resp.status_code, 201, resp.text)
        self.assertAlmostEqual(resp.json()["results"]["residues"][0]["r2"], 8.4, places=4)

    def test_cpmg_without_r2_a_is_rejected(self):
        cpmg = self._make_cpmg(self.project, {})
        r1 = self._make_source(self.project, "R1", [1.35], [0.03], ["G15N"])
        noe = self._make_source(self.project, "hetNOE", [0.78], [0.04], ["G15N"])
        resp = self.client.post(
            SDM_URL.format(p=self.project.project_uuid),
            json=self._create_body(r1, cpmg, noe, r2_provenance="cpmg_r2_0"),
            headers=self._auth(self.token_a),
        )
        self.assertEqual(resp.status_code, 422)
        self.assertIn("no fitted R2_A", resp.json()["detail"]["message"])

    def test_incomplete_cpmg_is_rejected(self):
        cpmg = self._make_cpmg(self.project, {"600.13MHZ": {"15N": (8.4, 0.21)}},
                               status="RUNNING")
        r1 = self._make_source(self.project, "R1", [1.35], [0.03], ["G15N"])
        noe = self._make_source(self.project, "hetNOE", [0.78], [0.04], ["G15N"])
        resp = self.client.post(
            SDM_URL.format(p=self.project.project_uuid),
            json=self._create_body(r1, cpmg, noe, r2_provenance="cpmg_r2_0"),
            headers=self._auth(self.token_a),
        )
        self.assertEqual(resp.status_code, 422)
        self.assertIn("COMPLETED", resp.json()["detail"]["message"])

    def test_peak_assignments_intersect_chemex_spin_keys(self):
        """"G15N" from peak fitting must match ChemEx's "15N".

        Matching on the symbol-carrying canonical form would drop every
        residue as "missing R2" while looking like a legitimate empty
        intersection.
        """
        cpmg = self._make_cpmg(self.project, {
            "600.13MHZ": {"10N": (8.4, 0.21), "11N": (9.1, 0.22)},
        })
        r1 = self._make_source(self.project, "R1", [1.35, 1.3], [0.03, 0.03],
                               ["G10N", "A11N"])
        noe = self._make_source(self.project, "hetNOE", [0.78, 0.75], [0.04, 0.04],
                                ["G10N", "A11N"])
        results = self.client.post(
            SDM_URL.format(p=self.project.project_uuid),
            json=self._create_body(r1, cpmg, noe, r2_provenance="cpmg_r2_0"),
            headers=self._auth(self.token_a),
        ).json()["results"]

        self.assertEqual(len(results["residues"]), 2)
        self.assertEqual(results["excluded_residues"], [])
        # The informative spelling survives into the table, not the bare key.
        self.assertEqual(
            sorted(r["assignment"] for r in results["residues"]), ["A11N", "G10N"]
        )

    def test_symbol_disagreement_between_sources_is_excluded(self):
        """Symbol-free matching must not silently merge two different residues.

        Residue 10 is G in R1/hetNOE but A in R2 -- matching on the bare
        number would fuse them. Residue 11 agrees everywhere and must still
        map, so the conflict costs only the residue it affects.
        """
        r1 = self._make_source(self.project, "R1", [1.35, 1.30], [0.03, 0.03],
                               ["G10N", "A11N"])
        r2 = self._make_source(self.project, "R2", [12.1, 12.5], [0.30, 0.30],
                               ["A10N", "A11N"])
        noe = self._make_source(self.project, "hetNOE", [0.78, 0.75], [0.04, 0.04],
                                ["G10N", "A11N"])
        results = self.client.post(
            SDM_URL.format(p=self.project.project_uuid),
            json=self._create_body(r1, r2, noe),
            headers=self._auth(self.token_a),
        ).json()["results"]

        self.assertEqual([r["assignment"] for r in results["residues"]], ["A11N"])
        self.assertEqual(len(results["excluded_residues"]), 1)
        excluded = results["excluded_residues"][0]
        self.assertIn("symbol disagrees", excluded["reason"])
        self.assertIn("A", excluded["reason"])
        self.assertIn("G", excluded["reason"])

    def test_total_symbol_disagreement_leaves_nothing_to_map(self):
        r1 = self._make_source(self.project, "R1", [1.35], [0.03], ["G10N"])
        r2 = self._make_source(self.project, "R2", [12.1], [0.30], ["A10N"])
        noe = self._make_source(self.project, "hetNOE", [0.78], [0.04], ["G10N"])
        resp = self.client.post(
            SDM_URL.format(p=self.project.project_uuid),
            json=self._create_body(r1, r2, noe),
            headers=self._auth(self.token_a),
        )
        self.assertEqual(resp.status_code, 422)
        detail = resp.json()["detail"]
        self.assertIn("nothing to map", detail["message"])
        self.assertIn("symbol disagrees", detail["excluded_residues"][0]["reason"])
