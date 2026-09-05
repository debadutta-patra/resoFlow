import numpy as np
import pandas as pd
from lmfit import Model
from typing import List, Dict, Any, Optional
import os
import logging

logger = logging.getLogger(__name__)

from ..path_utils import resolve_existing_path

def relax_function(time, amplitude, rate):
    """Exponential decay function: I(t) = I0 * exp(-R * t)"""
    return amplitude * np.exp(-rate * time)

def fit_exponential_decay(times: np.ndarray, intensities: np.ndarray, weights: np.ndarray = None, initial_amplitude: float = None, initial_rate: float = None):
    """
    Fit exponential decay to the given intensities over time.
    Returns the fit result object.
    """
    model = Model(relax_function)
    
    if initial_amplitude is None or initial_amplitude <= 0:
        max_int = float(np.max(intensities)) if len(intensities) > 0 else 1.0
        initial_amplitude = max_int if max_int > 0 else 1.0

    if initial_rate is None or initial_rate <= 0:
        dt = float(np.max(times) - np.min(times)) if len(times) > 0 else 1.0
        initial_rate = 1.0 / max(dt, 1e-4)

    params = model.make_params(amplitude=initial_amplitude, rate=initial_rate)
    
    # Add bounds
    params['amplitude'].set(min=0)
    params['rate'].set(min=0)
    
    result = model.fit(intensities, params, time=times, weights=weights)
    return result

def parse_vdlist(path: str) -> np.ndarray:
    """Parse NMRPipe vdlist file (DELAYS). Resolves host/container paths if needed."""
    resolved_path = resolve_existing_path(path)
    if not resolved_path or not os.path.exists(resolved_path):
        raise FileNotFoundError(f"VD list file not found: {path}")

    with open(resolved_path, 'r') as f:
        # Read lines, strip whitespace, ignore empty lines and scientific notation if any
        delays = []
        for line in f:
            line = line.strip()
            if not line:
                continue
            # Handle standard suffixes (m, u, n, etc.)
            val = line.lower()
            factor = 1.0
            if val.endswith('m'):
                factor = 1e-3
                val = val[:-1]
            elif val.endswith('u'):
                factor = 1e-6
                val = val[:-1]
            elif val.endswith('n'):
                factor = 1e-9
                val = val[:-1]
            elif val.endswith('s'):
                val = val[:-1]
                
            try:
                delays.append(float(val) * factor)
            except ValueError:
                logger.warning(f"Could not parse delay value: {line}")
        return np.array(delays)

def parse_vclist(path: str, delay: float) -> np.ndarray:
    """Parse NMRPipe vclist file (LOOP COUNTS) and multiply by constant delay."""
    resolved_path = resolve_existing_path(path)
    if not resolved_path or not os.path.exists(resolved_path):
        raise FileNotFoundError(f"VC list file not found: {path}")

    with open(resolved_path, 'r') as f:
        counts = [float(line.strip()) for line in f if line.strip()]
        return np.array(counts) * float(delay)

def get_relaxation_times(spectrum: Any) -> Optional[np.ndarray]:
    """
    Determine relaxation times based on spectrum type and lists.
    Supports T1/R1 and T2/R2 (case-insensitive), both vclist+delay and vdlist,
    and automatic host-to-container path resolution.
    """
    exp_type = (getattr(spectrum, "experiment_type", "") or "").upper().strip()
    vdlist_raw = getattr(spectrum, "vdlist_path", None)
    vclist_raw = getattr(spectrum, "vclist_path", None)
    delay_val = getattr(spectrum, "delay", None)

    vd_resolved = resolve_existing_path(vdlist_raw) if vdlist_raw else None
    vc_resolved = resolve_existing_path(vclist_raw) if vclist_raw else None

    has_vd = bool(vd_resolved and os.path.exists(vd_resolved))
    has_vc = bool(vc_resolved and os.path.exists(vc_resolved) and delay_val is not None and float(delay_val) > 0)

    try:
        # T1 / R1 experiments typically use VD list (variable delay)
        if exp_type in ["T1", "R1"]:
            if has_vd:
                return parse_vdlist(vd_resolved)
            elif has_vc:
                return parse_vclist(vc_resolved, float(delay_val))

        # T2 / R2 experiments can use VC list (loop count) * delay OR direct VD list
        elif exp_type in ["T2", "R2"]:
            if has_vc:
                return parse_vclist(vc_resolved, float(delay_val))
            elif has_vd:
                return parse_vdlist(vd_resolved)

        # General fallback: use whatever valid list is provided
        if has_vd:
            return parse_vdlist(vd_resolved)
        elif has_vc:
            return parse_vclist(vc_resolved, float(delay_val))

    except Exception as e:
        logger.warning(f"Failed to parse relaxation times for spectrum {getattr(spectrum, 'name', 'unknown')}: {e}")
        return None

    return None


def validate_relaxation_spectrum(spectrum: Any, analysis_type: str = "") -> Optional[str]:
    """
    Validate spectrum prerequisites for relaxation fitting (R1, R2, T1, T2).
    Returns None if valid, or a descriptive error message string explaining what is missing or wrong.
    """
    spec_name = getattr(spectrum, "name", "Unknown")
    exp_type_raw = getattr(spectrum, "experiment_type", None)
    if isinstance(exp_type_raw, str) and exp_type_raw.strip():
        exp_type = exp_type_raw.upper().strip()
    elif isinstance(analysis_type, str) and analysis_type.strip():
        exp_type = analysis_type.upper().strip()
    else:
        exp_type = ""

    vdlist_raw = getattr(spectrum, "vdlist_path", None)
    if not isinstance(vdlist_raw, str):
        vdlist_raw = None
    vclist_raw = getattr(spectrum, "vclist_path", None)
    if not isinstance(vclist_raw, str):
        vclist_raw = None
    delay_val = getattr(spectrum, "delay", None)

    if exp_type in ["T1", "R1"]:
        if vdlist_raw:
            resolved = resolve_existing_path(vdlist_raw)
            if not resolved or not os.path.exists(resolved):
                return f"Spectrum '{spec_name}': VD List file not found at '{vdlist_raw}'."
            try:
                times = parse_vdlist(resolved)
                if len(times) == 0:
                    return f"Spectrum '{spec_name}': VD List file '{vdlist_raw}' is empty."
            except Exception as e:
                return f"Spectrum '{spec_name}': Failed to parse numbers from VD List file '{vdlist_raw}': {e}"
            return None
        elif vclist_raw:
            resolved = resolve_existing_path(vclist_raw)
            if not resolved or not os.path.exists(resolved):
                return f"Spectrum '{spec_name}': VC List file not found at '{vclist_raw}'."
            if delay_val is None or float(delay_val) <= 0:
                return f"Spectrum '{spec_name}': Delay value must be greater than 0 when using VC List (current: {delay_val})."
            try:
                times = parse_vclist(resolved, float(delay_val))
                if len(times) == 0:
                    return f"Spectrum '{spec_name}': VC List file '{vclist_raw}' is empty."
            except Exception as e:
                return f"Spectrum '{spec_name}': Failed to parse numbers from VC List file '{vclist_raw}': {e}"
            return None
        else:
            return f"Spectrum '{spec_name}': Missing VD List (or VC List & Delay). Please configure it in Spectra settings."

    elif exp_type in ["T2", "R2"]:
        if vclist_raw:
            resolved = resolve_existing_path(vclist_raw)
            if not resolved or not os.path.exists(resolved):
                return f"Spectrum '{spec_name}': VC List file not found at '{vclist_raw}'."
            if delay_val is None or float(delay_val) <= 0:
                return f"Spectrum '{spec_name}': Delay value must be greater than 0 when using VC List (current: {delay_val})."
            try:
                times = parse_vclist(resolved, float(delay_val))
                if len(times) == 0:
                    return f"Spectrum '{spec_name}': VC List file '{vclist_raw}' is empty."
            except Exception as e:
                return f"Spectrum '{spec_name}': Failed to parse numbers from VC List file '{vclist_raw}': {e}"
            return None
        elif vdlist_raw:
            resolved = resolve_existing_path(vdlist_raw)
            if not resolved or not os.path.exists(resolved):
                return f"Spectrum '{spec_name}': VD List file not found at '{vdlist_raw}'."
            try:
                times = parse_vdlist(resolved)
                if len(times) == 0:
                    return f"Spectrum '{spec_name}': VD List file '{vdlist_raw}' is empty."
            except Exception as e:
                return f"Spectrum '{spec_name}': Failed to parse numbers from VD List file '{vdlist_raw}': {e}"
            return None
        else:
            return f"Spectrum '{spec_name}': Missing VC List & Delay (or VD List). Please configure it in Spectra settings."

    return None


def extract_peak_intensities_from_results(results_json_path: str, assignment: str) -> Optional[np.ndarray]:
    """Extract intensities across planes for a specific assignment from fitting JSON."""
    import json
    if not os.path.exists(results_json_path):
        return None
        
    with open(results_json_path, 'r') as f:
        data = json.load(f)
    
    peak_entries = [p for p in data.get('results', []) if p.get('assignment') == assignment]
    if not peak_entries:
        return None
        
    # Check if this is the nested format (one entry with a 'planes' list)
    if len(peak_entries) == 1 and 'planes' in peak_entries[0]:
        planes = sorted(peak_entries[0]['planes'], key=lambda p: p.get('plane', 0))
        return np.array([p.get('height', 0.0) for p in planes])
        
    # Otherwise assume flat format (multiple entries, each with a 'plane' key)
    peak_entries.sort(key=lambda p: p.get('plane', 0))
    return np.array([p.get('height', 0.0) for p in peak_entries])

def calculate_hetnoe_ratio(sat_intensity: float, unsat_intensity: float, sat_err: float = 0.0, unsat_err: float = 0.0):
    """
    Calculate hetNOE ratio (I_sat / I_unsat) and propagate error.
    ratio = I_sat / I_unsat
    error = |ratio| * sqrt((sigma_sat/I_sat)^2 + (sigma_unsat/I_unsat)^2)
    """
    if unsat_intensity == 0:
        return 0.0, 0.0
        
    ratio = sat_intensity / unsat_intensity
    
    # Error propagation
    if sat_err > 0 and unsat_err > 0:
        # Relative errors
        rel_sat = sat_err / abs(sat_intensity) if sat_intensity != 0 else 0
        rel_unsat = unsat_err / abs(unsat_intensity)
        ratio_err = abs(ratio) * np.sqrt(rel_sat**2 + rel_unsat**2)
    else:
        ratio_err = 0.0
        
    return float(ratio), float(ratio_err)
