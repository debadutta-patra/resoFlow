import os
import json
import unittest
import math
from app.services.fitting.chemex_parser import (
    parse_fitted_toml_content,
    parse_statistics_toml,
    compute_inverse_variance_stats,
    parse_chemex_run_parameters,
    evaluate_source_compatibility,
)


class TestChemExParser(unittest.TestCase):
    def test_parse_fitted_toml_content_with_uncertainties(self):
        content = """
[GLOBAL]
KEX_AB =  3.40473e+02 # ±5.33617e+00
PB     =  3.60021e-03 # ±2.58552e-05

[CS_A]
3N  =  1.20190e+02 # ±2.55664e-02
6N  =  1.21728e+02 # ±2.20278e-02

[DW_AB]
3N  =  3.59175e+00 # ±1.76469e-01
6N  = -1.28022e-02 # ±9.25259e+00
A60N = -6.28163e-02 # (error not calculated)
PB = 0.05 # (fixed)
"""
        parsed = parse_fitted_toml_content(content)
        self.assertIn("GLOBAL", parsed)
        self.assertIn("CS_A", parsed)
        self.assertIn("DW_AB", parsed)

        # Global checks
        self.assertAlmostEqual(parsed["GLOBAL"]["KEX_AB"]["value"], 340.473, places=3)
        self.assertAlmostEqual(parsed["GLOBAL"]["KEX_AB"]["err"], 5.33617, places=5)
        self.assertAlmostEqual(parsed["GLOBAL"]["PB"]["value"], 0.00360021, places=8)
        self.assertAlmostEqual(parsed["GLOBAL"]["PB"]["err"], 0.0000258552, places=10)

        # Residue checks
        self.assertAlmostEqual(parsed["CS_A"]["3N"]["value"], 120.19, places=2)
        self.assertAlmostEqual(parsed["CS_A"]["3N"]["err"], 0.0255664, places=6)

        self.assertAlmostEqual(parsed["DW_AB"]["3N"]["value"], 3.59175, places=5)
        self.assertAlmostEqual(parsed["DW_AB"]["3N"]["err"], 0.176469, places=6)

        # (error not calculated)
        self.assertAlmostEqual(parsed["DW_AB"]["A60N"]["value"], -0.0628163, places=6)
        self.assertIsNone(parsed["DW_AB"]["A60N"]["err"])
        self.assertFalse(parsed["DW_AB"]["A60N"]["is_fixed"])

        # (fixed)
        self.assertAlmostEqual(parsed["DW_AB"]["PB"]["value"], 0.05, places=2)
        self.assertIsNone(parsed["DW_AB"]["PB"]["err"])
        self.assertTrue(parsed["DW_AB"]["PB"]["is_fixed"])

    def test_compute_inverse_variance_stats(self):
        # Test items with valid uncertainties
        items = [
            {"value": 100.0, "err": 2.0},  # weight = 1/4 = 0.25
            {"value": 110.0, "err": 2.0},  # weight = 1/4 = 0.25
        ]
        stats = compute_inverse_variance_stats(items)
        self.assertAlmostEqual(stats["value"], 105.0, places=4)
        self.assertAlmostEqual(stats["err"], 1.4142, places=3)
        self.assertEqual(stats["count"], 2)
        self.assertEqual(stats["valid_err_count"], 2)
        self.assertEqual(stats["min"], 100.0)
        self.assertEqual(stats["max"], 110.0)
        self.assertEqual(stats["median"], 105.0)
        self.assertEqual(stats["iqr"], 5.0)

        # Test fallback to arithmetic mean when errors are None
        no_err_items = [
            {"value": 10.0, "err": None},
            {"value": 20.0, "err": None},
            {"value": 30.0, "err": None},
        ]
        stats_no_err = compute_inverse_variance_stats(no_err_items)
        self.assertAlmostEqual(stats_no_err["value"], 20.0, places=4)
        self.assertEqual(stats_no_err["valid_err_count"], 0)
        self.assertEqual(stats_no_err["median"], 20.0)
        self.assertEqual(stats_no_err["min"], 10.0)
        self.assertEqual(stats_no_err["max"], 30.0)

    def test_parse_real_global_run(self):
        run_dir = "/home/debadutta/Documents/test/cest_fitting/ba38acbb-3055-4a52-a228-9977a0d8d903"
        if not os.path.exists(run_dir) or not os.path.exists(os.path.join(run_dir, "Output", "parameters.toml")):
            self.skipTest("Test run Output directory not ready or in progress")

        res = parse_chemex_run_parameters(run_dir)
        self.assertEqual(res["fit_mode"], "global")
        self.assertIn("kex_ab", res["globals"])
        self.assertGreater(res["globals"]["kex_ab"]["value"], 0.0)
        self.assertGreater(res["globals"]["pb"]["value"], 0.0)

        self.assertGreaterEqual(len(res["residues"]), 3)
        self.assertIn("14N", res["residues"])
        self.assertIn("55N", res["residues"])
        self.assertIn("65N", res["residues"])
        self.assertGreater(res["residues"]["14N"]["dw_ab"]["value"], 0.0)

        self.assertGreater(res["statistics"]["chi2_red"], 0.0)



    def test_parse_real_individual_run(self):
        run_dir = "/home/debadutta/Documents/drb2d1_relaxation/high_conc/drb2d1/cest_fitting/785a5349-2366-43df-acc4-fb51a44a03af"
        if not os.path.exists(run_dir):
            self.skipTest("Test run directory not found")

        res = parse_chemex_run_parameters(run_dir)
        self.assertEqual(res["fit_mode"], "individual")
        self.assertIn("kex_ab", res["globals"])
        self.assertIsNotNone(res["globals"]["kex_ab"]["stats"])
        self.assertGreater(res["globals"]["kex_ab"]["stats"]["median"], 0)
        self.assertGreaterEqual(len(res["residues"]), 50)

    def test_evaluate_source_compatibility(self):
        base_target = {
            "analysis_type": "15N-CEST",
            "model": "2st",
            "nucleus": "15N",
            "temperature": 298.15,
            "static_field": 600.0,
        }

        # 1. Perfectly compatible run
        src_compat = {
            "analysis_type": "15N-CEST",
            "model": "2st",
            "nucleus": "15N",
            "temperature": 298.15,
            "static_field": 600.0,
        }
        is_compat, block, warn = evaluate_source_compatibility(src_compat, base_target)
        self.assertTrue(is_compat)
        self.assertEqual(len(block), 0)
        self.assertEqual(len(warn), 0)

        # 2. Block on kinetic model mismatch (2st vs 3st)
        src_3st = {
            "analysis_type": "15N-CEST",
            "model": "3st",
            "nucleus": "15N",
            "temperature": 298.15,
            "static_field": 600.0,
        }
        is_compat, block, warn = evaluate_source_compatibility(src_3st, base_target)
        self.assertFalse(is_compat)
        self.assertTrue(any("kinetic model" in b.lower() for b in block))

        # 3. Block on nucleus mismatch (15N vs 13C)
        src_13c = {
            "analysis_type": "13C-CEST",
            "model": "2st",
            "nucleus": "13C",
            "temperature": 298.15,
            "static_field": 600.0,
        }
        is_compat, block, warn = evaluate_source_compatibility(src_13c, base_target)
        self.assertFalse(is_compat)
        self.assertTrue(any("nucleus" in b.lower() for b in block))

        # 4. Warn on temperature mismatch (298.15 vs 303.15)
        src_warm = {
            "analysis_type": "15N-CEST",
            "model": "2st",
            "nucleus": "15N",
            "temperature": 303.15,
            "static_field": 600.0,
        }
        is_compat, block, warn = evaluate_source_compatibility(src_warm, base_target)
        self.assertTrue(is_compat)
        self.assertEqual(len(block), 0)
        self.assertEqual(len(warn), 1)
        self.assertTrue(any("temperature" in w.lower() for w in warn))

        # 5. Allow static field difference without blocking or warning
        src_800 = {
            "analysis_type": "15N-CEST",
            "model": "2st",
            "nucleus": "15N",
            "temperature": 298.15,
            "static_field": 800.0,
        }
        is_compat, block, warn = evaluate_source_compatibility(src_800, base_target)
        self.assertTrue(is_compat)
        self.assertEqual(len(block), 0)
        self.assertEqual(len(warn), 0)

    def test_extract_excluded_residues(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp_dir:
            config_path = os.path.join(tmp_dir, "config.json")
            with open(config_path, "w") as f:
                json.dump({
                    "parameter_config": {
                        "excludedResidues": ["14N", "88N"]
                    }
                }, f)

            param_path = os.path.join(tmp_dir, "parameters.toml")
            with open(param_path, "w") as f:
                f.write("""
[CS_A]
3N = 120.19
# 25N = 118.50
""")

            res = parse_chemex_run_parameters(tmp_dir)
            self.assertIn("excluded_residues", res)
            self.assertIn("14N", res["excluded_residues"])
            self.assertIn("88N", res["excluded_residues"])
            self.assertIn("25N", res["excluded_residues"])

    def test_parse_multifile_parameters_fixed_constrained_fitted(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp_dir:
            params_dir = os.path.join(tmp_dir, "Output", "Parameters")
            os.makedirs(params_dir, exist_ok=True)

            # fixed.toml
            with open(os.path.join(params_dir, "fixed.toml"), "w") as f:
                f.write("""
["CS_A, T->25.0C"]
3N = 120.19 # (fixed)
35N = 123.479 # (fixed)
""")

            # constrained.toml
            with open(os.path.join(params_dir, "constrained.toml"), "w") as f:
                f.write("""
["CS_B, T->25.0C"]
3N = 123.792 # ±1.18344e-01 ([CS_A, NUC->3N] + [DW_AB, NUC->3N])
35N = 125.767 # ±4.52060e-02 ([CS_A, NUC->35N] + [DW_AB, NUC->35N])
""")

            # fitted.toml
            with open(os.path.join(params_dir, "fitted.toml"), "w") as f:
                f.write("""
[GLOBAL]
"KEX_AB, T->25.0C" = 3.36095e+02 # ±9.03302e+00
"PB, T->25.0C" = 3.52394e-03 # ±4.50798e-05

["DW_AB, T->25.0C"]
3N = 3.60188e+00 # ±1.18344e-01
35N = 2.28797e+00 # ±4.52060e-02
""")

            res = parse_chemex_run_parameters(tmp_dir)
            self.assertIn("3N", res["residues"])
            self.assertIn("35N", res["residues"])

            # Check 3N parameters
            p3 = res["residues"]["3N"]
            self.assertAlmostEqual(p3["cs_a"]["value"], 120.19, places=2)
            self.assertTrue(p3["cs_a"]["is_fixed"])
            self.assertAlmostEqual(p3["cs_b"]["value"], 123.792, places=3)
            self.assertAlmostEqual(p3["dw_ab"]["value"], 3.60188, places=4)
            self.assertAlmostEqual(p3["dw_ab"]["err"], 0.118344, places=6)

            # Check Globals
            self.assertAlmostEqual(res["globals"]["kex_ab"]["value"], 336.095, places=3)
            self.assertAlmostEqual(res["globals"]["kex_ab"]["err"], 9.03302, places=4)
            self.assertAlmostEqual(res["globals"]["pb"]["value"], 0.00352394, places=7)


class TestFieldDependentParameters(unittest.TestCase):
    """Field-dependent rates are a vector, not one arbitrarily chosen value.

    ChemEx writes one section per field for R1_A/R1_B/R2_A/R2_B. Collapsing
    them -- which extract_base_name does, since it strips every qualifier --
    silently keeps whichever section came last in the file. For R2,0 across
    500 and 800 MHz that is a difference of tens of percent, and it produces
    a plausible number rather than an obvious failure.
    """

    MULTI_FIELD_TOML = """
[GLOBAL]
KEX_AB =  3.84732e+02 # ±2.18658e+01
PB     =  7.16564e-02 # ±2.52130e-03

[DW_AB]
31N =  1.95915e+00 # ±4.19417e-02

["R2_A, B0->800.0MHZ"]
31N =  7.94425e+00 # ±4.02940e-01

["R2_A, B0->500.0MHZ"]
31N =  5.83417e+00 # ±2.58888e-01
"""

    def _parse(self, content):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp_dir:
            with open(os.path.join(tmp_dir, "fitted.toml"), "w") as f:
                f.write(content)
            return parse_chemex_run_parameters(tmp_dir)

    def test_every_field_is_reported(self):
        res = self._parse(self.MULTI_FIELD_TOML)
        r2a = res["residues"]["31N"]["r2_a"]

        self.assertTrue(r2a["multi_field"])
        self.assertEqual(len(r2a["by_field"]), 2)
        by_field = {e["field_mhz"]: e for e in r2a["by_field"]}
        self.assertAlmostEqual(by_field[500.0]["value"], 5.83417, places=5)
        self.assertAlmostEqual(by_field[500.0]["err"], 0.258888, places=6)
        self.assertAlmostEqual(by_field[800.0]["value"], 7.94425, places=5)
        self.assertAlmostEqual(by_field[800.0]["err"], 0.402940, places=6)

    def test_by_field_is_sorted_ascending(self):
        """Sections appear 800 then 500 in the source; order must not leak."""
        res = self._parse(self.MULTI_FIELD_TOML)
        fields = [e["field_mhz"] for e in res["residues"]["31N"]["r2_a"]["by_field"]]
        self.assertEqual(fields, [500.0, 800.0])

    def test_scalar_value_is_the_lowest_field_not_the_file_order(self):
        """Previously this was whichever section came last. Now it is defined."""
        res = self._parse(self.MULTI_FIELD_TOML)
        r2a = res["residues"]["31N"]["r2_a"]
        self.assertAlmostEqual(r2a["value"], 5.83417, places=5)
        self.assertEqual(r2a["field_mhz"], 500.0)

    def test_fields_are_listed_at_the_top_level(self):
        res = self._parse(self.MULTI_FIELD_TOML)
        self.assertEqual(res["fields_mhz"], [500.0, 800.0])

    def test_field_independent_parameters_are_unchanged(self):
        """cs_a, dw_ab and the globals must keep their original flat shape.

        These are the parameters the inherit-parameters flow actually reads,
        so the vector change must not reach them.
        """
        res = self._parse(self.MULTI_FIELD_TOML)
        dw = res["residues"]["31N"]["dw_ab"]
        self.assertEqual(set(dw), {"value", "err", "is_fixed"})
        self.assertNotIn("by_field", dw)
        self.assertNotIn("multi_field", dw)
        self.assertAlmostEqual(dw["value"], 1.95915, places=5)

        kex = res["globals"]["kex_ab"]
        self.assertNotIn("by_field", kex)
        self.assertAlmostEqual(kex["value"], 384.732, places=3)

    def test_single_field_still_reports_a_vector_of_one(self):
        res = self._parse("""
["R2_A, B0->600.3MHZ"]
31N =  6.10000e+00 # ±2.00000e-01
""")
        r2a = res["residues"]["31N"]["r2_a"]
        self.assertFalse(r2a["multi_field"])
        self.assertEqual(len(r2a["by_field"]), 1)
        self.assertAlmostEqual(r2a["value"], 6.1, places=5)
        self.assertEqual(r2a["field_mhz"], 600.3)
        self.assertEqual(res["fields_mhz"], [600.3])

    def test_unqualified_rate_keeps_the_flat_shape(self):
        """A rate written without a B0 qualifier behaves exactly as before."""
        res = self._parse("""
[R2_A]
31N =  6.10000e+00 # ±2.00000e-01
""")
        r2a = res["residues"]["31N"]["r2_a"]
        self.assertEqual(set(r2a), {"value", "err", "is_fixed"})
        self.assertAlmostEqual(r2a["value"], 6.1, places=5)
        self.assertEqual(res["fields_mhz"], [])

    def test_all_four_field_dependent_families_are_vectorised(self):
        res = self._parse("""
["R1_A, B0->500.0MHZ"]
31N =  1.10000e+00
["R1_A, B0->800.0MHZ"]
31N =  1.40000e+00
["R1_B, B0->500.0MHZ"]
31N =  1.20000e+00
["R1_B, B0->800.0MHZ"]
31N =  1.50000e+00
["R2_A, B0->500.0MHZ"]
31N =  5.80000e+00
["R2_A, B0->800.0MHZ"]
31N =  7.90000e+00
["R2_B, B0->500.0MHZ"]
31N =  6.80000e+00
["R2_B, B0->800.0MHZ"]
31N =  8.90000e+00
""")
        for name in ("r1_a", "r1_b", "r2_a", "r2_b"):
            entry = res["residues"]["31N"][name]
            self.assertTrue(entry["multi_field"], name)
            self.assertEqual(len(entry["by_field"]), 2, name)

    def test_repeated_field_across_files_does_not_duplicate(self):
        """A later file overriding the same field replaces, never appends."""
        import tempfile
        with tempfile.TemporaryDirectory() as tmp_dir:
            with open(os.path.join(tmp_dir, "parameters.toml"), "w") as f:
                f.write('["R2_A, B0->500.0MHZ"]\n31N = 5.00000e+00\n')
            with open(os.path.join(tmp_dir, "fitted.toml"), "w") as f:
                f.write('["R2_A, B0->500.0MHZ"]\n31N = 5.83417e+00\n')
            res = parse_chemex_run_parameters(tmp_dir)

        r2a = res["residues"]["31N"]["r2_a"]
        self.assertEqual(len(r2a["by_field"]), 1)
        # fitted.toml is processed last and wins, as it did before.
        self.assertAlmostEqual(r2a["value"], 5.83417, places=5)
        self.assertFalse(r2a["multi_field"])


if __name__ == "__main__":
    unittest.main()
