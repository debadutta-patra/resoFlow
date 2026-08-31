import numpy as np
import pandas as pd
from lmfit import Model
from typing import List, Dict, Any, Optional
import os
import logging

logger = logging.getLogger(__name__)

def relax_function(time, amplitude, rate):
    """Exponential decay function: I(t) = I0 * exp(-R * t)"""
    return amplitude * np.exp(-rate * time)

def fit_exponential_decay(times: np.ndarray, intensities: np.ndarray, weights: np.ndarray = None, initial_amplitude: float = None, initial_rate: float = 1.0):
    """
    Fit exponential decay to the given intensities over time.
    Returns the fit result object.
    """
    model = Model(relax_function)
    params = model.make_params(amplitude=initial_amplitude if initial_amplitude else intensities[0], 
                              rate=initial_rate)
    
    # Add bounds
    params['amplitude'].set(min=0)
    params['rate'].set(min=0)
    
    result = model.fit(intensities, params, time=times, weights=weights)
    return result

def parse_vdlist(path: str) -> np.ndarray:
    """Parse NMRPipe vdlist file (DELAYS)."""
    with open(path, 'r') as f:
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
    with open(path, 'r') as f:
        counts = [float(line.strip()) for line in f if line.strip()]
        return np.array(counts) * delay

def get_relaxation_times(spectrum: Any) -> Optional[np.ndarray]:
    """Determine relaxation times based on spectrum type and lists."""
    if spectrum.experiment_type == "T1" and spectrum.vdlist_path:
        return parse_vdlist(spectrum.vdlist_path)
    elif spectrum.experiment_type == "T2" and spectrum.vclist_path and spectrum.delay:
        return parse_vclist(spectrum.vclist_path, spectrum.delay)
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
