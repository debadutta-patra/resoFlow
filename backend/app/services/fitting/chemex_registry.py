from __future__ import annotations

import inspect
import types
from functools import lru_cache
from typing import Any, Dict, List, Literal, Optional, Sequence, Set, Tuple, Union

import pydantic
from pydantic import BaseModel
from pydantic.fields import FieldInfo

# Import ChemEx loaders and factories
try:
    import chemex.experiments.factories as factories
    import chemex.experiments.loader as loader
    loader.register_experiments()
    CHEMEX_AVAILABLE = True
except Exception:
    CHEMEX_AVAILABLE = False


# Units mapping by parameter / field name conventions
FIELD_UNITS_MAP: Dict[str, str] = {
    "time_t1": "s",
    "time_t2": "s",
    "time_equil": "s",
    "time_equil_1": "s",
    "time_equil_2": "s",
    "time_grad": "s",
    "taua": "s",
    "taub": "s",
    "t_zeta": "s",
    "d1": "s",
    "carrier": "ppm",
    "carrier_dec": "ppm",
    "carrier_h": "ppm",
    "carrier_n": "ppm",
    "b1_frq": "Hz",
    "b1_frq_dec": "Hz",
    "b1_eff": "Hz",
    "b1_inh_scale": "fraction",
    "b1_inh_res": "points",
    "cos_n": "points",
    "cos_res": "points",
    "pw90": "s",
    "pw90_h": "s",
    "pw90_n": "s",
    "pw_eburp": "s",
    "pw_reburp": "s",
    "tauc": "s",
    "taucc": "s",
    "delta": "s",
    "gradient": "G/cm",
    "tau": "s",
    "ncyc_max": "points",
    "h_larmor_frq": "MHz",
    "temperature": "K",
    "p_total": "M",
    "l_total": "M",
    "d2o": "fraction",
    "sw": "Hz",
}

# Spin system format definitions
SPIN_KEY_FORMATS: Dict[str, Dict[str, Any]] = {
    "single_15n": {
        "format": "single_15n",
        "description": "Single-spin 15N (e.g. G2N or 2N)",
        "example": "G2N",
        "nuclei": ["15n"],
        "observed_spin": "15n",
    },
    "two_spin_15n_1h": {
        "format": "two_spin_15n_1h",
        "description": "Two-spin 15N-1H TROSY (e.g. G2N-HN)",
        "example": "G2N-HN",
        "nuclei": ["15n", "1h"],
        "observed_spin": "15n",
    },
    "two_spin_1h_15n": {
        "format": "two_spin_1h_15n",
        "description": "Two-spin 1H-15N in-phase/anti-phase (e.g. G2HN-N)",
        "example": "G2HN-N",
        "nuclei": ["1h", "15n"],
        "observed_spin": "1h",
    },
    "single_13c": {
        "format": "single_13c",
        "description": "Single-spin 13C (e.g. G2C or 2C)",
        "example": "G2C",
        "nuclei": ["13c"],
        "observed_spin": "13c",
    },
    "methyl_mq": {
        "format": "methyl_mq",
        "description": "Methyl 13C-1H multiple-quantum (e.g. L3CD1-HD1)",
        "example": "L3CD1-HD1",
        "nuclei": ["13c", "1h"],
        "observed_spin": "13c",
    },
    "methyl_1h": {
        "format": "methyl_1h",
        "description": "Methyl 1H in-phase/anti-phase (e.g. L3HD1-CD1)",
        "example": "L3HD1-CD1",
        "nuclei": ["1h", "13c"],
        "observed_spin": "1h",
    },
}

MODULE_METADATA: Dict[str, Dict[str, Any]] = {
    # ── 15N Amide CEST Modules ───────────────────────────────────────────
    "cest_15n": {
        "display_name": "15N CW CEST",
        "family": "cest",
        "probe": "15N",
        "observed_nucleus": "15N",
        "xi_ratio": 0.101329118,
        "default_carrier": 117.0,
        "unit_label": "ppm (¹⁵N)",
        "sanity_range": [100.0, 135.0],
        "default_zoom_span": 20.0,
        "max_dw_warn": 6.0,
        "spin_system_format": "single_15n",
        "docs_url": "https://chemex.readthedocs.io/en/latest/experiments/cest_15n.html",
        "description": "Pure in-phase 15N chemical exchange saturation transfer (CEST) experiment.",
    },
    "cest_15n_cw": {
        "display_name": "15N Continuous-Wave Decoupling CEST",
        "family": "cest",
        "probe": "15N",
        "observed_nucleus": "15N",
        "xi_ratio": 0.101329118,
        "default_carrier": 117.0,
        "unit_label": "ppm (¹⁵N)",
        "sanity_range": [100.0, 135.0],
        "default_zoom_span": 20.0,
        "max_dw_warn": 6.0,
        "spin_system_format": "single_15n",
        "docs_url": "https://chemex.readthedocs.io/en/latest/experiments/cest_15n_cw.html",
        "description": "15N CEST experiment with 1H continuous-wave decoupling during relaxation.",
    },
    "cest_15n_tr": {
        "display_name": "15N TROSY CEST",
        "family": "cest",
        "probe": "15N",
        "observed_nucleus": "15N",
        "xi_ratio": 0.101329118,
        "default_carrier": 117.0,
        "unit_label": "ppm (¹⁵N)",
        "sanity_range": [100.0, 135.0],
        "default_zoom_span": 20.0,
        "max_dw_warn": 6.0,
        "spin_system_format": "two_spin_15n_1h",
        "flags": ["antitrosy"],
        "docs_url": "https://chemex.readthedocs.io/en/latest/experiments/cest_15n_tr.html",
        "description": "TROSY-based 15N CEST experiment for large macromolecules (>30 kDa).",
    },

    # ── 13C CEST Modules ────────────────────────────────────────────────
    "cest_13c": {
        "display_name": "13C In-Phase CEST",
        "family": "cest",
        "probe": "13C",
        "observed_nucleus": "13C",
        "xi_ratio": 0.25144953,
        "default_carrier": 40.0,
        "unit_label": "ppm (¹³C)",
        "sanity_range": [0.0, 220.0],
        "default_zoom_span": 15.0,
        "max_dw_warn": 8.0,
        "spin_system_format": "single_13c",
        "docs_url": "https://chemex.readthedocs.io/en/latest/experiments/cest_13c.html",
        "description": "Pure in-phase 13C CEST experiment for aliphatic or carbonyl resonances.",
    },

    # ── 1H Amide CEST Modules ───────────────────────────────────────────
    "cest_1hn_ap": {
        "display_name": "1HN Anti-Phase CEST",
        "family": "cest",
        "probe": "1HN",
        "observed_nucleus": "1H",
        "xi_ratio": 1.0,
        "default_carrier": 8.5,
        "unit_label": "ppm (¹H)",
        "sanity_range": [6.0, 11.5],
        "default_zoom_span": 2.0,
        "max_dw_warn": 1.5,
        "spin_system_format": "two_spin_1h_15n",
        "docs_url": "https://chemex.readthedocs.io/en/latest/experiments/cest_1hn_ap.html",
        "description": "Anti-phase 1H-15N CEST experiment for amide protons.",
    },
    "cest_1hn_ip_ap": {
        "display_name": "1HN IP/AP CEST",
        "family": "cest",
        "probe": "1HN",
        "observed_nucleus": "1H",
        "xi_ratio": 1.0,
        "default_carrier": 8.5,
        "unit_label": "ppm (¹H)",
        "sanity_range": [6.0, 11.5],
        "default_zoom_span": 2.0,
        "max_dw_warn": 1.5,
        "spin_system_format": "two_spin_1h_15n",
        "flags": ["eta_block"],
        "docs_url": "https://chemex.readthedocs.io/en/latest/experiments/cest_1hn_ip_ap.html",
        "description": "In-phase/anti-phase 1H-15N CEST experiment with exchange-induced cross-relaxation.",
    },

    # ── Methyl 1H CEST Modules ──────────────────────────────────────────
    "cest_ch3_1h_ip_ap": {
        "display_name": "CH3 1H IP/AP CEST",
        "family": "cest",
        "probe": "13CH3",
        "observed_nucleus": "1H",
        "xi_ratio": 1.0,
        "default_carrier": 1.0,
        "unit_label": "ppm (¹H)",
        "sanity_range": [-0.5, 4.0],
        "default_zoom_span": 1.5,
        "max_dw_warn": 1.5,
        "spin_system_format": "methyl_1h",
        "docs_url": "https://chemex.readthedocs.io/en/latest/experiments/cest_ch3_1h_ip_ap.html",
        "description": "In-phase/anti-phase 1H CEST experiment for 13CH3 methyl side-chains.",
    },

    # ── DANTE / D-CEST Modules ──────────────────────────────────────────
    "dcest_15n": {
        "display_name": "15N D-CEST (DANTE)",
        "family": "cest",
        "probe": "15N",
        "observed_nucleus": "15N",
        "xi_ratio": 0.101329118,
        "default_carrier": 117.0,
        "unit_label": "ppm (¹⁵N)",
        "sanity_range": [100.0, 135.0],
        "default_zoom_span": 20.0,
        "max_dw_warn": 6.0,
        "spin_system_format": "single_15n",
        "docs_url": "https://chemex.readthedocs.io/en/latest/experiments/dcest_15n.html",
        "description": "D-CEST 15N experiment using DANTE pulse trains.",
    },
    "dcest_13c": {
        "display_name": "13C D-CEST (DANTE)",
        "family": "cest",
        "probe": "13C",
        "observed_nucleus": "13C",
        "xi_ratio": 0.25144953,
        "default_carrier": 40.0,
        "unit_label": "ppm (¹³C)",
        "sanity_range": [0.0, 220.0],
        "default_zoom_span": 15.0,
        "max_dw_warn": 8.0,
        "spin_system_format": "single_13c",
        "docs_url": "https://chemex.readthedocs.io/en/latest/experiments/dcest_13c.html",
        "description": "D-CEST 13C experiment using DANTE pulse trains.",
    },

    # ── CPMG Modules ───────────────────────────────────────────────────
    "cpmg_15n_rc": {
        "display_name": "15N Relaxation-Compensated CPMG",
        "family": "cpmg",
        "probe": "15N",
        "observed_nucleus": "15N",
        "xi_ratio": 0.101329118,
        "default_carrier": 117.0,
        "unit_label": "ppm (¹⁵N)",
        "spin_system_format": "two_spin_15n_1h",
        "docs_url": "https://chemex.readthedocs.io/en/latest/experiments/cpmg_15n_rc.html",
        "description": "Relaxation-compensated 15N CPMG experiment (two CPMG blocks with central P-element).",
    },
    "cpmg_15n_ip": {
        "display_name": "15N In-Phase CPMG",
        "family": "cpmg",
        "probe": "15N",
        "observed_nucleus": "15N",
        "xi_ratio": 0.101329118,
        "default_carrier": 117.0,
        "unit_label": "ppm (¹⁵N)",
        "spin_system_format": "single_15n",
        "docs_url": "https://chemex.readthedocs.io/en/latest/experiments/cpmg_15n_ip.html",
        "description": "In-phase 15N CPMG relaxation dispersion experiment.",
        "variants": {
            "phase_cycle": {
                "0013": "cpmg_15n_ip_0013",
            }
        }
    },
    "cpmg_15n_ip_0013": {
        "display_name": "15N In-Phase CPMG (0013)",
        "family": "cpmg",
        "probe": "15N",
        "observed_nucleus": "15N",
        "xi_ratio": 0.101329118,
        "default_carrier": 117.0,
        "unit_label": "ppm (¹⁵N)",
        "spin_system_format": "single_15n",
        "docs_url": "https://chemex.readthedocs.io/en/latest/experiments/cpmg_15n_ip_0013.html",
        "description": "15N in-phase CPMG experiment with 0013 phase cycling.",
        "parent_module": "cpmg_15n_ip",
    },
    "cpmg_15n_tr": {
        "display_name": "15N TROSY CPMG",
        "family": "cpmg",
        "probe": "15N",
        "observed_nucleus": "15N",
        "xi_ratio": 0.101329118,
        "default_carrier": 117.0,
        "unit_label": "ppm (¹⁵N)",
        "spin_system_format": "two_spin_15n_1h",
        "docs_url": "https://chemex.readthedocs.io/en/latest/experiments/cpmg_15n_tr.html",
        "description": "TROSY-based 15N CPMG relaxation dispersion experiment.",
        "variants": {
            "phase_cycle": {
                "0013": "cpmg_15n_tr_0013",
            },
            "antitrosy": True,
        }
    },
    "cpmg_15n_tr_0013": {
        "display_name": "15N TROSY CPMG (0013)",
        "family": "cpmg",
        "probe": "15N",
        "observed_nucleus": "15N",
        "xi_ratio": 0.101329118,
        "default_carrier": 117.0,
        "unit_label": "ppm (¹⁵N)",
        "spin_system_format": "two_spin_15n_1h",
        "docs_url": "https://chemex.readthedocs.io/en/latest/experiments/cpmg_15n_tr_0013.html",
        "description": "15N TROSY-based CPMG experiment with 0013 phase cycling.",
        "parent_module": "cpmg_15n_tr",
    },
    "cpmg_1hn_ap": {
        "display_name": "1HN Anti-Phase CPMG",
        "family": "cpmg",
        "probe": "1HN",
        "observed_nucleus": "1H",
        "xi_ratio": 1.0,
        "default_carrier": 8.5,
        "unit_label": "ppm (¹H)",
        "spin_system_format": "two_spin_1h_15n",
        "docs_url": "https://chemex.readthedocs.io/en/latest/experiments/cpmg_1hn_ap.html",
        "description": "Anti-phase 1H-15N CPMG relaxation dispersion experiment.",
        "variants": {
            "phase_cycle": {
                "0013": "cpmg_1hn_ap_0013",
            }
        }
    },
    "cpmg_1hn_ap_0013": {
        "display_name": "1HN Anti-Phase CPMG (0013)",
        "family": "cpmg",
        "probe": "1HN",
        "observed_nucleus": "1H",
        "xi_ratio": 1.0,
        "default_carrier": 8.5,
        "unit_label": "ppm (¹H)",
        "spin_system_format": "two_spin_1h_15n",
        "docs_url": "https://chemex.readthedocs.io/en/latest/experiments/cpmg_1hn_ap_0013.html",
        "description": "1HN anti-phase CPMG experiment with 0013 phase cycling.",
        "parent_module": "cpmg_1hn_ap",
    },
    "cpmg_ch3_mq": {
        "display_name": "CH3 Multiple-Quantum CPMG",
        "family": "cpmg",
        "probe": "13CH3",
        "observed_nucleus": "13C",
        "xi_ratio": 0.25144953,
        "default_carrier": 20.0,
        "unit_label": "ppm (¹³C)",
        "spin_system_format": "methyl_mq",
        "docs_url": "https://chemex.readthedocs.io/en/latest/experiments/cpmg_ch3_mq.html",
        "description": "CH3 multiple-quantum (MQ) CPMG relaxation dispersion experiment.",
    },
    "cpmg_ch3_13c_h2c": {
        "display_name": "CH3 13C H2C CPMG",
        "family": "cpmg",
        "probe": "13CH3",
        "observed_nucleus": "13C",
        "xi_ratio": 0.25144953,
        "default_carrier": 20.0,
        "unit_label": "ppm (¹³C)",
        "spin_system_format": "methyl_mq",
        "docs_url": "https://chemex.readthedocs.io/en/latest/experiments/cpmg_ch3_13c_h2c.html",
        "description": "CH3 13C H2C CPMG relaxation dispersion experiment.",
        "variants": {
            "phase_cycle": {
                "0013": "cpmg_ch3_13c_h2c_0013",
            }
        }
    },
    "cpmg_ch3_13c_h2c_0013": {
        "display_name": "CH3 13C H2C CPMG (0013)",
        "family": "cpmg",
        "probe": "13CH3",
        "observed_nucleus": "13C",
        "xi_ratio": 0.25144953,
        "default_carrier": 20.0,
        "unit_label": "ppm (¹³C)",
        "spin_system_format": "methyl_mq",
        "docs_url": "https://chemex.readthedocs.io/en/latest/experiments/cpmg_ch3_13c_h2c_0013.html",
        "description": "CH3 13C H2C CPMG experiment with 0013 phase cycling.",
        "parent_module": "cpmg_ch3_13c_h2c",
    },
    "cpmg_13c_ip": {
        "display_name": "13C In-Phase CPMG",
        "family": "cpmg",
        "probe": "13C",
        "observed_nucleus": "13C",
        "xi_ratio": 0.25144953,
        "default_carrier": 40.0,
        "unit_label": "ppm (¹³C)",
        "spin_system_format": "single_13c",
        "docs_url": "https://chemex.readthedocs.io/en/latest/experiments/cpmg_13c_ip.html",
        "description": "In-phase 13C CPMG relaxation dispersion experiment.",
    },
    "cpmg_13co_ap": {
        "display_name": "13CO Anti-Phase CPMG",
        "family": "cpmg",
        "probe": "13CO",
        "observed_nucleus": "13C",
        "xi_ratio": 0.25144953,
        "default_carrier": 175.0,
        "unit_label": "ppm (¹³C)",
        "spin_system_format": "single_13c",
        "docs_url": "https://chemex.readthedocs.io/en/latest/experiments/cpmg_13co_ap.html",
        "description": "Anti-phase 13CO CPMG relaxation dispersion experiment.",
    },
    "cpmg_hn_dq_zq": {
        "display_name": "15N-1H DQ/ZQ CPMG",
        "family": "cpmg",
        "probe": "15N-1H",
        "observed_nucleus": "15N",
        "xi_ratio": 0.101329118,
        "default_carrier": 117.0,
        "unit_label": "ppm (¹⁵N)",
        "spin_system_format": "two_spin_15n_1h",
        "docs_url": "https://chemex.readthedocs.io/en/latest/experiments/cpmg_hn_dq_zq.html",
        "description": "Double- and zero-quantum 15N-1H CPMG relaxation dispersion experiment.",
        "flags": ["dq_flg"],
    },
    "cpmg_ch3_1h_sq": {
        "display_name": "CH3 1H Single-Quantum CPMG",
        "family": "cpmg",
        "probe": "13CH3",
        "observed_nucleus": "1H",
        "xi_ratio": 1.0,
        "default_carrier": 1.0,
        "unit_label": "ppm (¹H)",
        "spin_system_format": "methyl_1h",
        "docs_url": "https://chemex.readthedocs.io/en/latest/experiments/cpmg_ch3_1h_sq.html",
        "description": "Single-quantum 1H CPMG relaxation dispersion experiment for 13CH3 methyl groups.",
    },
    "cpmg_ch3_1h_dq": {
        "display_name": "CH3 1H Double-Quantum CPMG",
        "family": "cpmg",
        "probe": "13CH3",
        "observed_nucleus": "1H",
        "xi_ratio": 1.0,
        "default_carrier": 1.0,
        "unit_label": "ppm (¹H)",
        "spin_system_format": "methyl_1h",
        "docs_url": "https://chemex.readthedocs.io/en/latest/experiments/cpmg_ch3_1h_dq.html",
        "description": "Double-quantum 1H CPMG relaxation dispersion experiment for 13CH3 methyl groups.",
    },
    "cpmg_ch3_1h_tq": {
        "display_name": "CH3 1H Triple-Quantum CPMG",
        "family": "cpmg",
        "probe": "13CH3",
        "observed_nucleus": "1H",
        "xi_ratio": 1.0,
        "default_carrier": 1.0,
        "unit_label": "ppm (¹H)",
        "spin_system_format": "methyl_1h",
        "docs_url": "https://chemex.readthedocs.io/en/latest/experiments/cpmg_ch3_1h_tq.html",
        "description": "Triple-quantum 1H CPMG relaxation dispersion experiment for 13CH3 methyl groups.",
    },
    "cpmg_ch3_1h_tq_diff": {
        "display_name": "CH3 1H Triple-Quantum Diffusion CPMG",
        "family": "cpmg",
        "probe": "13CH3",
        "observed_nucleus": "1H",
        "xi_ratio": 1.0,
        "default_carrier": 1.0,
        "unit_label": "ppm (¹H)",
        "spin_system_format": "methyl_1h",
        "docs_url": "https://chemex.readthedocs.io/en/latest/experiments/cpmg_ch3_1h_tq_diff.html",
        "description": "Triple-quantum 1H CPMG experiment with pulsed-field gradient diffusion filter.",
    },
    "cpmg_chd2_1h_ap": {
        "display_name": "13CHD2 1H Anti-Phase CPMG",
        "family": "cpmg",
        "probe": "13CHD2",
        "observed_nucleus": "1H",
        "xi_ratio": 1.0,
        "default_carrier": 1.0,
        "unit_label": "ppm (¹H)",
        "spin_system_format": "methyl_1h",
        "docs_url": "https://chemex.readthedocs.io/en/latest/experiments/cpmg_chd2_1h_ap.html",
        "description": "Anti-phase 1H CPMG relaxation dispersion experiment for 13CHD2 methyl groups.",
    },

    # ── Relaxation Modules ──────────────────────────────────────────────
    "relaxation_nz": {
        "display_name": "Longitudinal 15N (Nz) Relaxation",
        "family": "relaxation",
        "probe": "15N",
        "observed_nucleus": "15N",
        "xi_ratio": 0.101329118,
        "default_carrier": 117.0,
        "unit_label": "ppm (¹⁵N)",
        "spin_system_format": "single_15n",
        "docs_url": "https://chemex.readthedocs.io/en/latest/experiments/relaxation_nz.html",
        "description": "Longitudinal 15N relaxation (R1) experiment.",
    },
    "relaxation_hznz": {
        "display_name": "Longitudinal 1H-15N (HzNz) Relaxation",
        "family": "relaxation",
        "probe": "15N",
        "observed_nucleus": "15N",
        "xi_ratio": 0.101329118,
        "default_carrier": 117.0,
        "unit_label": "ppm (¹⁵N)",
        "spin_system_format": "two_spin_15n_1h",
        "docs_url": "https://chemex.readthedocs.io/en/latest/experiments/relaxation_hznz.html",
        "description": "Longitudinal 1H-15N two-spin order (HzNz) relaxation experiment.",
    },
}


def _unwrap_type(annotation: Any) -> Tuple[Any, bool]:
    origin = getattr(annotation, "__origin__", None)
    args = getattr(annotation, "__args__", ())

    if origin is Union or isinstance(annotation, types.UnionType):
        non_none_args = [a for a in args if a is not type(None)]
        is_optional = len(non_none_args) < len(args)
        if len(non_none_args) == 1:
            return non_none_args[0], is_optional
        return annotation, is_optional

    return annotation, False


def _extract_field_type(field_info: FieldInfo, annotation: Any) -> Tuple[str, Optional[List[Any]], Any]:
    unwrapped, is_opt = _unwrap_type(annotation)
    origin = getattr(unwrapped, "__origin__", None)
    args = getattr(unwrapped, "__args__", ())

    if origin is Literal or getattr(unwrapped, "_name", None) == "Literal":
        return "enum", list(args), unwrapped

    if origin in (list, List, Sequence, Set, set, tuple, Tuple):
        return "array", None, unwrapped

    if origin in (dict, Dict):
        return "object", None, unwrapped

    if unwrapped is float or unwrapped == "float":
        return "float", None, unwrapped
    if unwrapped is int or unwrapped == "integer":
        return "integer", None, unwrapped
    if unwrapped is bool or unwrapped == "boolean":
        return "boolean", None, unwrapped
    if unwrapped is str or unwrapped == "string":
        return "string", None, unwrapped

    if isinstance(unwrapped, type) and issubclass(unwrapped, BaseModel):
        return "nested_model", None, unwrapped

    return "any", None, unwrapped


def _introspect_model_schema(model_cls: type[BaseModel]) -> Dict[str, Any]:
    fields_schema: Dict[str, Any] = {}

    for fname, finfo in model_cls.model_fields.items():
        ann = finfo.annotation
        ftype, enum_vals, target_cls = _extract_field_type(finfo, ann)

        default_val = finfo.default
        if default_val is pydantic.fields.PydanticUndefined or default_val is ...:
            default_val = None
            is_required = True
        else:
            is_required = finfo.is_required()

        constraints = {}
        if finfo.metadata:
            for meta in finfo.metadata:
                for attr in ("ge", "gt", "le", "lt", "min_length", "max_length"):
                    if hasattr(meta, attr):
                        constraints[attr] = getattr(meta, attr)

        unit = FIELD_UNITS_MAP.get(fname)
        description = finfo.description or getattr(finfo, "title", None)

        field_entry: Dict[str, Any] = {
            "name": fname,
            "type": ftype,
            "required": is_required,
            "default": default_val,
            "unit": unit,
            "description": description,
        }

        if enum_vals:
            field_entry["enum"] = enum_vals
        if constraints:
            field_entry["constraints"] = constraints

        if ftype == "nested_model" and isinstance(target_cls, type) and issubclass(target_cls, BaseModel):
            field_entry["nested_fields"] = _introspect_model_schema(target_cls)
            subclasses = target_cls.__subclasses__()
            if subclasses:
                sub_variants: Dict[str, Any] = {}
                for sub in subclasses:
                    sub_name = sub.__name__.replace("DistributionConfig", "").replace("Config", "").lower()
                    sub_variants[sub_name] = {
                        "name": sub_name,
                        "class_name": sub.__name__,
                        "fields": _introspect_model_schema(sub)
                    }
                field_entry["subclasses"] = sub_variants

        fields_schema[fname] = field_entry

    return fields_schema


def _introspect_experiment_module(module_name: str) -> Optional[Dict[str, Any]]:
    if not CHEMEX_AVAILABLE or module_name not in factories.factories.creators_registry:
        return None

    creator = factories.factories.creators_registry[module_name]
    cfg_cls = creator.config_creator
    meta = MODULE_METADATA.get(module_name, {})

    sections: Dict[str, Any] = {}

    for sec_name in ["experiment", "conditions", "data", "model"]:
        if sec_name in cfg_cls.model_fields:
            sec_field = cfg_cls.model_fields[sec_name]
            sec_ann = sec_field.annotation
            unwrapped_ann, _ = _unwrap_type(sec_ann)
            if isinstance(unwrapped_ann, type) and issubclass(unwrapped_ann, BaseModel):
                sections[sec_name] = {
                    "section": sec_name,
                    "title": sec_name.capitalize(),
                    "class_name": unwrapped_ann.__name__,
                    "fields": _introspect_model_schema(unwrapped_ann),
                }

    data_error_options: List[str] = ["file"]
    if "data" in sections and "error" in sections["data"]["fields"]:
        err_enum = sections["data"]["fields"]["error"].get("enum")
        if err_enum:
            data_error_options = err_enum
        elif meta.get("family") == "cest":
            data_error_options = ["file", "scatter"]
        elif meta.get("family") == "cpmg":
            data_error_options = ["file", "duplicates"]

    spin_format_key = meta.get("spin_system_format", "single_15n")
    spin_format = SPIN_KEY_FORMATS.get(spin_format_key, SPIN_KEY_FORMATS["single_15n"])

    return {
        "module_name": module_name,
        "display_name": meta.get("display_name", module_name),
        "family": meta.get("family", "unknown"),
        "probe": meta.get("probe", "unknown"),
        "observed_nucleus": meta.get("observed_nucleus", "15N"),
        "xi_ratio": meta.get("xi_ratio", 0.101329118),
        "default_carrier": meta.get("default_carrier", 117.0),
        "unit_label": meta.get("unit_label", "ppm (¹⁵N)"),
        "sanity_range": meta.get("sanity_range", [100.0, 135.0]),
        "default_zoom_span": meta.get("default_zoom_span", 20.0),
        "max_dw_warn": meta.get("max_dw_warn", 6.0),
        "flags": meta.get("flags", []),
        "description": meta.get("description") or (cfg_cls.__doc__ or "").strip(),
        "docs_url": meta.get("docs_url", f"https://chemex.readthedocs.io/en/latest/experiments/{module_name}.html"),
        "parent_module": meta.get("parent_module"),
        "variants": meta.get("variants", {}),
        "spin_system_format": spin_format,
        "allowed_data_errors": data_error_options,
        "sections": sections,
    }


@lru_cache(maxsize=1)
def get_chemex_module_registry() -> Dict[str, Any]:
    registry: Dict[str, Any] = {}

    if not CHEMEX_AVAILABLE:
        return registry

    for mod_name in sorted(factories.factories.creators_registry.keys()):
        if mod_name.startswith("wip") or mod_name.endswith("_test"):
            continue
        mod_info = _introspect_experiment_module(mod_name)
        if mod_info:
            registry[mod_name] = mod_info

    return registry


def get_module_schema(module_name: str) -> Optional[Dict[str, Any]]:
    registry = get_chemex_module_registry()
    return registry.get(module_name)


def resolve_module_name(parent_module: str, options: Optional[Dict[str, Any]] = None) -> str:
    if not options:
        return parent_module

    phase_cycle = options.get("phase_cycle")
    if phase_cycle == "0013":
        candidate = f"{parent_module}_0013"
        registry = get_chemex_module_registry()
        if candidate in registry:
            return candidate

    return parent_module
