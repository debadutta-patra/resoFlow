import os
import json
import logging
import numpy as np
from datetime import datetime
from billiard.pool import Pool
from ...celery_app import celery_app
from .relaxation import get_relaxation_times, extract_peak_intensities_from_results, fit_exponential_decay
from ... import models, database

logger = logging.getLogger(__name__)

def fit_single_peak(args):
    """Worker function for multiprocessing."""
    times_all, intensities_all, intensities_err_all, assignment, res_num, res_name = args
    try:
        
        # Calculate weights = 1/sigma. Use 1.0 (unweighted) if sigma is 0.
        weights = None
        if intensities_err_all:
            errs = np.array(intensities_err_all)
            weights = np.where(errs > 0, 1.0 / errs, 0.0) # lmfit uses weights as 1/sigma
            # If all weights are 0, fall back to unweighted
            if np.all(weights == 0):
                weights = None

        fit_result = fit_exponential_decay(np.array(times_all), np.array(intensities_all), weights=weights)
        
        # Calculate RMSE
        residuals = np.array(intensities_all) - fit_result.best_fit
        rmse = np.sqrt(np.mean(residuals**2))
        
        # If no weights were provided, redchi is just chisqr/ndof which can be huge.
        # Let's provide a 'normalized' redchi assuming a 1% error floor if weights are None
        # to give the user a more familiar number around 1.0 for a good fit.
        redchi = float(fit_result.redchi)
        if weights is None:
            # Assume 1% error of max intensity or intensities themselves for stats
            err_stat = np.max(np.abs(intensities_all)) * 0.01
            if err_stat > 0:
                redchi = float(np.sum((residuals / err_stat)**2) / fit_result.nfree)

        # Generate dense fit line for smooth plotting and uncertainty band
        times_min = np.min(times_all)
        times_max = np.max(times_all)
        # Extend slightly for visual padding
        padding = (times_max - times_min) * 0.05
        fit_times_dense = np.linspace(max(0, times_min - padding), times_max + padding, 100)
        fit_intensities_dense = fit_result.eval(time=fit_times_dense)
        
        # Calculate 1-sigma prediction interval
        try:
            fit_uncertainty_dense = fit_result.eval_uncertainty(time=fit_times_dense, sigma=1)
        except Exception:
            # Fallback if uncertainty calculation fails (e.g. singular matrix)
            fit_uncertainty_dense = np.zeros_like(fit_intensities_dense)

        return {
            "assignment": assignment,
            "res_num": res_num,
            "res_name": res_name,
            "rate": float(fit_result.params['rate'].value),
            "rate_err": float(fit_result.params['rate'].stderr) if fit_result.params['rate'].stderr else 0.0,
            "amplitude": float(fit_result.params['amplitude'].value),
            "amplitude_err": float(fit_result.params['amplitude'].stderr) if fit_result.params['amplitude'].stderr else 0.0,
            "chisqr": float(fit_result.chisqr),
            "redchi": float(redchi),
            "rmse": float(rmse),
            "times": times_all,
            "intensities": intensities_all,
            "intensities_err": intensities_err_all,
            "fit_times_dense": fit_times_dense.tolist(),
            "fit_intensities_dense": fit_intensities_dense.tolist(),
            "fit_uncertainty_dense": fit_uncertainty_dense.tolist()
        }
    except Exception as e:
        # Can't use global logger easily here if it's not thread-safe or initialized same way
        print(f"Fit failed for peak {assignment}: {str(e)}")
        return None

from ..path_utils import resolve_existing_path

@celery_app.task(bind=True)
def run_relaxation_analysis_task(self, analysis_uuid: str, spectrum_ids: list, workers: int = 1):
    """
    Celery task to perform relaxation analysis fit for a given set of spectra.
    """
    db = next(database.get_db())
    analysis = db.query(models.Analysis).filter(models.Analysis.analysis_uuid == analysis_uuid).first()
    if not analysis:
        logger.error(f"Analysis {analysis_uuid} not found")
        return

    analysis.status = "RUNNING"
    analysis.error_message = None
    db.commit()

    log_file = resolve_existing_path(analysis.log_path) or analysis.log_path
    if log_file:
        os.makedirs(os.path.dirname(log_file), exist_ok=True)

    def _log(msg: str):
        logger.info(f"[{analysis_uuid}] {msg}")
        if log_file:
            try:
                with open(log_file, 'a') as lf:
                    lf.write(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")
            except Exception:
                pass

    _log(f"Starting {analysis.analysis_type} relaxation analysis (ID: {analysis_uuid})")
    _log(f"Configured parallel workers: {workers}")

    try:
        results = []
        spectra = db.query(models.Spectrum).filter(models.Spectrum.id.in_(spectrum_ids)).all()
        if not spectra:
            raise ValueError("No valid spectra found for analysis.")
        
        is_hetnoe = analysis.analysis_type == "hetNOE"
        use_height = getattr(analysis, 'use_height', False)
        
        # Field names based on use_height
        val_field = 'height' if use_height else 'amp'
        err_field = 'height_err' if use_height else 'amp_err'

        # Determine relaxation times for each spectrum
        spectrum_data = []
        for s in spectra:
            times = get_relaxation_times(s)
            if times is not None:
                spectrum_data.append({"spectrum": s, "times": times})
                _log(f"Spectrum '{s.name}': Loaded {len(times)} relaxation points.")
            elif is_hetnoe:
                # hetNOE doesn't need relaxation times, it uses planes
                # We provide dummy times [0, 1] to represent the two planes
                spectrum_data.append({"spectrum": s, "times": np.array([0, 1])})
                _log(f"Spectrum '{s.name}': Loaded hetNOE planes.")
            else:
                _log(f"WARNING: No relaxation times found for spectrum '{s.name}'. Check VD/VC list.")
                logger.warning(f"No relaxation times found for spectrum {s.name}")

        if not spectrum_data:
            raise ValueError("No valid spectra or relaxation times found. Please check VD/VC list paths in Spectra settings.")

        # Get peak assignments from the first spectrum's fitting results (inheritance)
        # We assume all spectra have the same peaks or we use the union
        first_s = spectra[0]
        first_res_path = resolve_existing_path(first_s.results_json_path)
        if not first_res_path or not os.path.exists(first_res_path):
            raise ValueError(f"First spectrum '{first_s.name}' must be peak-fitted to inherit assignments.")
            
        with open(first_res_path, 'r') as f:
            peak_fit_data = json.load(f)
            
        fit_args = []
        processed_assignments = set()
        
        for peak in peak_fit_data.get('results', []):
            assignment = peak.get('assignment')
            if not assignment or assignment in processed_assignments:
                continue
                
            processed_assignments.add(assignment)
                
            # Collect intensities across all selected spectra for this residue
            times_all = []
            intensities_all = []
            intensities_err_all = [] # New: for error propagation
            
            for sd in spectrum_data:
                s = sd["spectrum"]
                times = sd["times"]
                
                # Extract intensities from this spectrum for this assignment
                s_res_path = resolve_existing_path(s.results_json_path)
                if s_res_path and os.path.exists(s_res_path):
                    ints = None
                    ints_err = None
                    
                    with open(s_res_path, 'r') as f:
                        data = json.load(f)
                    
                    p_entries = [p for p in data.get('results', []) if p.get('assignment') == assignment]
                    if p_entries:
                        if len(p_entries) == 1 and 'planes' in p_entries[0]:
                            planes = sorted(p_entries[0]['planes'], key=lambda p: p.get('plane', 0))
                            ints = np.array([p.get(val_field, 0.0) for p in planes])
                            ints_err = np.array([p.get(err_field, 0.0) for p in planes])
                        else:
                            p_entries.sort(key=lambda p: p.get('plane', 0))
                            ints = np.array([p.get(val_field, 0.0) for p in p_entries])
                            ints_err = np.array([p.get(err_field, 0.0) for p in p_entries])

                    if ints is not None:
                        if len(ints) == len(times):
                            times_all.extend(times.tolist())
                            intensities_all.extend(ints.tolist())
                            if ints_err is not None:
                                intensities_err_all.extend(ints_err.tolist())
                            else:
                                intensities_err_all.extend([0.0] * len(ints))
                        else:
                            logger.warning(f"Intensity count ({len(ints)}) does not match time count ({len(times)}) for spectrum {s.name} for peak {assignment}")

            if not intensities_all:
                continue
            
            # Extract metadata with case-insensitive fallback
            res_num = peak.get('res_num')
            if res_num is None:
                res_num = peak.get('RES_NUM')
            
            res_name = peak.get('res_name')
            if res_name is None:
                res_name = peak.get('RES_NAME')

            if is_hetnoe:
                mode = [0, 1]
                if spectra[0].hetnoe_mode:
                    try:
                        mode = [int(x) for x in spectra[0].hetnoe_mode.split(',')]
                    except:
                        logger.warning(f"Invalid hetnoe_mode: {spectra[0].hetnoe_mode}. Using default [0,1].")
                
                unsat_idx = -1
                sat_idx = -1
                
                for i, m in enumerate(mode):
                    if m == 0:
                        unsat_idx = i
                    elif m == 1:
                        sat_idx = i
                
                if unsat_idx == -1 or sat_idx == -1:
                    unsat_idx, sat_idx = 0, 1
                    logger.warning(f"Could not identify both sat and unsat from mode {mode}. Defaulting to [0,1].")

                if unsat_idx >= len(intensities_all) or sat_idx >= len(intensities_all):
                    logger.error(f"Plane indices {unsat_idx}/{sat_idx} out of range for intensity array of size {len(intensities_all)}")
                    continue

                i_unsat = intensities_all[unsat_idx]
                i_sat = intensities_all[sat_idx]
                e_unsat = intensities_err_all[unsat_idx]
                e_sat = intensities_err_all[sat_idx]
                
                from .relaxation import calculate_hetnoe_ratio
                ratio, ratio_err = calculate_hetnoe_ratio(i_sat, i_unsat, e_sat, e_unsat)
                
                results.append({
                    "assignment": assignment,
                    "res_num": res_num,
                    "res_name": res_name,
                    "rate": ratio,
                    "rate_err": ratio_err,
                    "amplitude": i_unsat,
                    "amplitude_err": e_unsat,
                    "chisqr": 0.0,
                    "redchi": 0.0,
                    "times": [0, 1],
                    "intensities": [i_unsat, i_sat],
                    "fit_intensities": [0.0, 0.0]
                })
                continue

            # Prepare arguments for relaxation fitting
            fit_args.append((
                times_all, 
                intensities_all, 
                intensities_err_all,
                assignment, 
                res_num, 
                res_name
            ))

        if not is_hetnoe:
            if not fit_args:
                raise ValueError("No peaks were found to fit. Ensure the reference spectrum is peak-fitted.")

            _log(f"Inherited {len(fit_args)} peaks to fit. Running parallel fitting with {workers} worker(s)...")

            # Perform parallel fitting
            with Pool(processes=workers) as pool:
                pool_results = pool.map(fit_single_peak, fit_args)
                
            peak_results = [r for r in pool_results if r is not None]
        else:
            peak_results = results

        # Save results
        res_file = resolve_existing_path(analysis.results_path) or analysis.results_path
        if res_file:
            os.makedirs(os.path.dirname(res_file), exist_ok=True)
            with open(res_file, 'w') as f:
                json.dump({
                    "analysis_uuid": analysis_uuid,
                    "timestamp": datetime.now().isoformat(),
                    "peak_results": peak_results
                }, f, indent=4)

        _log(f"Analysis completed successfully. Fitted {len(peak_results)} peaks.")
        analysis.status = "COMPLETED"
        analysis.completed_at = datetime.now()
        analysis.error_message = None
        db.commit()

    except Exception as e:
        logger.exception(f"Analysis {analysis_uuid} failed")
        _log(f"ERROR: {str(e)}")
        analysis.status = "FAILED"
        analysis.error_message = str(e)
        db.commit()
    finally:
        db.close()
