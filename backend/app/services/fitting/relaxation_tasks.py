import os
import json
import logging
import numpy as np
from datetime import datetime
from billiard.pool import Pool
from ...celery_app import celery_app
from .relaxation import get_relaxation_times, extract_peak_intensities_from_results, fit_exponential_decay
from .relaxation_noise import (
    resolve_noise_model,
    apply_residual_scaling,
    compute_dataset_pooled_duplicate_sigma,
)
from .relaxation_uncertainty import (
    compute_relaxation_covariance,
    compute_hetnoe_covariance,
    build_covariance_uncertainty_result,
    uncertainty_result_to_statistics_payload,
)
from .relaxation_sampling import (
    run_relaxation_resampling_analysis,
    save_relaxation_statistics_files,
)
from ... import models, database

logger = logging.getLogger(__name__)

def fit_single_peak(args):
    """Worker function for multiprocessing."""
    global_duplicate_sigma = None
    if len(args) >= 9:
        times_all, intensities_all, intensities_err_all, assignment, res_num, res_name, noise_source, spectral_rmsd, global_duplicate_sigma = args[:9]
    elif len(args) == 8:
        times_all, intensities_all, intensities_err_all, assignment, res_num, res_name, noise_source, spectral_rmsd = args[:8]
    elif len(args) == 7:
        times_all, intensities_all, intensities_err_all, assignment, res_num, res_name, noise_source = args
        spectral_rmsd = None
    else:
        times_all, intensities_all, intensities_err_all, assignment, res_num, res_name = args
        noise_source = "lineshape"
        spectral_rmsd = None

    try:
        t_arr = np.asarray(times_all, dtype=np.float64)
        y_arr = np.asarray(intensities_all, dtype=np.float64)
        y_err = np.asarray(intensities_err_all, dtype=np.float64) if intensities_err_all else None

        # Resolve point uncertainties via explicit NoiseModel
        sigmas, noise_meta = resolve_noise_model(
            t_arr,
            y_arr,
            lineshape_errs=y_err,
            requested_source=noise_source,
            spectral_rmsd=spectral_rmsd,
            global_duplicate_sigma=global_duplicate_sigma,
        )

        weights = np.where(sigmas > 0, 1.0 / sigmas, 1.0)
        fit_result = fit_exponential_decay(t_arr, y_arr, weights=weights)

        amplitude = float(fit_result.params['amplitude'].value)
        rate = float(fit_result.params['rate'].value)
        residuals = y_arr - fit_result.best_fit

        # If residual-scaled requested, inflate sigma so reduced chi2 = 1.0
        if noise_source == "residual_scaled":
            sigmas, scale_factor = apply_residual_scaling(sigmas, residuals, n_params=2)
            noise_meta["residual_scale_factor"] = scale_factor
            weights = np.where(sigmas > 0, 1.0 / sigmas, 1.0)
            fit_result = fit_exponential_decay(
                t_arr, y_arr, weights=weights, initial_amplitude=amplitude, initial_rate=rate
            )
            amplitude = float(fit_result.params['amplitude'].value)
            rate = float(fit_result.params['rate'].value)
            residuals = y_arr - fit_result.best_fit

        # Compute asymptotic covariance matrix errors
        cov_errs, cov_mat, cov_diag = compute_relaxation_covariance(
            t_arr, y_arr, sigmas, amplitude, rate
        )

        rate_err = float(cov_errs["rate_err"])
        amp_err = float(cov_errs["amplitude_err"])
        rmse = float(np.sqrt(np.mean(residuals**2)))

        # Generate dense fit line for smooth plotting and uncertainty band
        times_min = float(np.min(t_arr))
        times_max = float(np.max(t_arr))
        padding = (times_max - times_min) * 0.05
        fit_times_dense = np.linspace(max(0, times_min - padding), times_max + padding, 100)
        fit_intensities_dense = fit_result.eval(time=fit_times_dense)

        try:
            fit_uncertainty_dense = fit_result.eval_uncertainty(time=fit_times_dense, sigma=1)
        except Exception:
            fit_uncertainty_dense = np.zeros_like(fit_intensities_dense)

        return {
            "assignment": assignment,
            "res_num": res_num,
            "res_name": res_name,
            "rate": rate,
            "rate_err": rate_err,
            "amplitude": amplitude,
            "amplitude_err": amp_err,
            "chisqr": float(cov_diag["chisqr"]),
            "redchi": float(cov_diag["redchi"]),
            "rmse": rmse,
            "times": times_all,
            "intensities": intensities_all,
            "intensities_err": sigmas.tolist(),
            "fit_times_dense": fit_times_dense.tolist(),
            "fit_intensities_dense": fit_intensities_dense.tolist(),
            "fit_uncertainty_dense": fit_uncertainty_dense.tolist(),
            "noise_metadata": noise_meta,
            "covariance_diagnostics": cov_diag,
            "cov_matrix": cov_mat.tolist(),
        }
    except Exception as e:
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

    # Parse configured noise model and uncertainty method
    params = json.loads(analysis.parameters) if analysis.parameters else {}
    noise_source = params.get("noise_model", "lineshape")
    uncertainty_method = params.get("uncertainty_method", "covariance")
    n_samples = int(params.get("n_samples", 500))
    raw_seed = params.get("seed")
    seed = None
    if raw_seed is not None and str(raw_seed).strip():
        try:
            seed = int(raw_seed)
        except (ValueError, TypeError):
            seed = None

    _log(f"Configured noise model: {noise_source}")
    _log(f"Configured uncertainty method: {uncertainty_method} (samples={n_samples}, seed={seed})")

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

        # Estimate spectral RMSD from reference spectrum if available
        first_s = spectra[0]
        spectral_rmsd = None
        try:
            first_spec_path = resolve_existing_path(getattr(first_s, 'filepath', None))
            if first_spec_path and os.path.exists(first_spec_path):
                import nmrglue as ng
                dic, sdata = ng.pipe.read(first_spec_path)
                plane0 = sdata[0] if sdata.ndim >= 3 else sdata
                from ..spectrum.plotting import estimate_noise_mad
                spectral_rmsd = float(estimate_noise_mad(plane0))
                _log(f"Estimated spectral baseline noise: {spectral_rmsd:.2e}")
        except Exception as e:
            logger.debug(f"Could not read spectral noise from raw spectrum: {e}")

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
            intensities_err_all = []
            
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

                i_unsat = float(intensities_all[unsat_idx])
                i_sat = float(intensities_all[sat_idx])
                e_unsat = float(intensities_err_all[unsat_idx]) if intensities_err_all else 0.0
                e_sat = float(intensities_err_all[sat_idx]) if intensities_err_all else 0.0

                sigmas_noe, noise_meta = resolve_noise_model(
                    np.array([0.0, 1.0]),
                    np.array([i_unsat, i_sat]),
                    lineshape_errs=np.array([e_unsat, e_sat]),
                    requested_source=noise_source,
                    spectral_rmsd=spectral_rmsd,
                )
                s_unsat, s_sat = float(sigmas_noe[0]), float(sigmas_noe[1])

                ratio, ratio_err, int_68, int_95, diag = compute_hetnoe_covariance(
                    i_sat, i_unsat, s_sat, s_unsat
                )

                results.append({
                    "assignment": assignment,
                    "res_num": res_num,
                    "res_name": res_name,
                    "rate": ratio,
                    "rate_err": ratio_err,
                    "amplitude": i_unsat,
                    "amplitude_err": s_unsat,
                    "chisqr": 0.0,
                    "redchi": 0.0,
                    "times": [0, 1],
                    "intensities": [i_unsat, i_sat],
                    "intensities_err": [s_unsat, s_sat],
                    "fit_intensities": [0.0, 0.0],
                    "noise_metadata": noise_meta,
                    "covariance_diagnostics": diag,
                    "interval_68": list(int_68),
                    "interval_95": list(int_95),
                })
                continue

            # Prepare arguments for relaxation fitting
            fit_args.append((
                times_all, 
                intensities_all, 
                intensities_err_all,
                assignment, 
                res_num, 
                res_name,
                noise_source,
                spectral_rmsd,
            ))

        if not is_hetnoe:
            if not fit_args:
                raise ValueError("No peaks were found to fit. Ensure the reference spectrum is peak-fitted.")

            # Compute dataset-wide pooled duplicate noise if duplicate delay points exist
            peak_t_y = [(a[0], a[1]) for a in fit_args]
            global_dup_sigma = compute_dataset_pooled_duplicate_sigma(peak_t_y)
            if global_dup_sigma is not None:
                _log(f"Dataset-wide pooled duplicate delay noise: {global_dup_sigma:.2e}")
                fit_args = [(*a, global_dup_sigma) for a in fit_args]
            else:
                fit_args = [(*a, None) for a in fit_args]

            _log(f"Inherited {len(fit_args)} peaks to fit. Running parallel fitting with {workers} worker(s)...")

            pool_results = []
            total_peaks = len(fit_args)
            with Pool(processes=workers) as pool:
                for idx, r in enumerate(pool.imap(fit_single_peak, fit_args), 1):
                    pool_results.append(r)
                    if res_file and (idx % max(1, total_peaks // 20) == 0 or idx == total_peaks):
                        try:
                            with open(os.path.join(os.path.dirname(res_file), "progress.json"), "w", encoding="utf-8") as pf:
                                json.dump({
                                    "kind": "fit",
                                    "stage": "Fitting",
                                    "percent": int((idx / total_peaks) * 85),
                                    "message": f"Fitted peak {idx}/{total_peaks}...",
                                    "updated_at": datetime.now().timestamp(),
                                }, pf)
                        except Exception:
                            pass
                
            peak_results = [r for r in pool_results if r is not None]
        else:
            peak_results = results

        # Build normalized UncertaintyResult for Covariance baseline
        point_estimates = {}
        standard_errors = {}
        atype = (analysis.analysis_type or "").upper()
        rate_param_name = "HETNOE" if atype == "HETNOE" else atype
        amp_param_name = "I_REF" if atype == "HETNOE" else "I0"

        for p in peak_results:
            assign = p["assignment"]
            point_estimates[f"{rate_param_name}, NUC->{assign}"] = p["rate"]
            standard_errors[f"{rate_param_name}, NUC->{assign}"] = p["rate_err"]
            point_estimates[f"{amp_param_name}, NUC->{assign}"] = p["amplitude"]
            standard_errors[f"{amp_param_name}, NUC->{assign}"] = p["amplitude_err"]

        cov_result = build_covariance_uncertainty_result(
            point_estimates,
            standard_errors,
            noise_source=noise_source,
            diagnostics={"n_peaks": len(peak_results), "analysis_type": atype},
        )

        unc_results_map = {"covariance": cov_result}
        correlations_by_method: dict[str, Any] = {}

        # Save results
        res_file = resolve_existing_path(analysis.results_path) or analysis.results_path
        if res_file:
            run_dir = os.path.dirname(res_file)
            os.makedirs(run_dir, exist_ok=True)

            # Persist Parameters/fitted.toml for ChemEx-style readers
            param_dir = os.path.join(run_dir, "Parameters")
            os.makedirs(param_dir, exist_ok=True)
            fitted_toml_path = os.path.join(param_dir, "fitted.toml")
            try:
                with open(fitted_toml_path, "w", encoding="utf-8") as pf:
                    for p_name, pt in point_estimates.items():
                        parts = p_name.split(", ")
                        if len(parts) == 2:
                            sec, k = parts[0], parts[1]
                            pf.write(f'["{sec}"]\n"{k}" = {pt}\n\n')
                        else:
                            pf.write(f'["{p_name}"]\nvalue = {pt}\n\n')
            except Exception as exc:
                logger.warning(f"Could not write fitted.toml: {exc}")

            # Persist summary.toml, diagnostics.toml, correlations.tsv in Statistics/Covariance/
            cov_stat_dir = os.path.join(run_dir, "Statistics", "Covariance")
            os.makedirs(cov_stat_dir, exist_ok=True)
            summary_toml_path = os.path.join(cov_stat_dir, "summary.toml")
            diag_toml_path = os.path.join(cov_stat_dir, "diagnostics.toml")
            corr_tsv_path = os.path.join(cov_stat_dir, "correlations.tsv")
            try:
                with open(summary_toml_path, "w", encoding="utf-8") as sf:
                    for p_name, pt in point_estimates.items():
                        se = standard_errors.get(p_name, 0.0)
                        sf.write(f'["{p_name}"]\n')
                        sf.write(f'mean = {pt}\n')
                        sf.write(f'median = {pt}\n')
                        sf.write(f'standard_deviation = {se}\n')
                        sf.write(f'percentile_95_lower = {pt - 1.95996 * se}\n')
                        sf.write(f'percentile_95_upper = {pt + 1.95996 * se}\n')
                        sf.write(f'stderr = {se}\n')
                        sf.write(f'sample_count = 1\n\n')

                with open(diag_toml_path, "w", encoding="utf-8") as df:
                    df.write('method_name = "Covariance"\n')
                    df.write('requested_samples = 1\n')
                    df.write('completed_samples = 1\n')
                    df.write('status = "completed"\n')

                param_keys = list(point_estimates.keys())
                with open(corr_tsv_path, "w", encoding="utf-8") as cf:
                    cf.write("\t" + "\t".join(param_keys) + "\n")
                    for k1 in param_keys:
                        row = []
                        for k2 in param_keys:
                            if k1 == k2:
                                row.append("1.0")
                            else:
                                row.append("0.0")
                        cf.write(k1 + "\t" + "\t".join(row) + "\n")
            except Exception as exc:
                logger.warning(f"Could not write covariance files: {exc}")

            # Run Resampling Uncertainty Estimation if requested
            u_method_norm = uncertainty_method.lower().strip()
            if u_method_norm in ("monte_carlo", "mc", "bootstrap", "bs", "bootstrap_case", "bs_case", "mcmc"):
                if u_method_norm in ("monte_carlo", "mc"):
                    stat_folder = "MonteCarlo"
                    canon_key = "monte_carlo"
                    method_title = "Monte Carlo"
                elif u_method_norm in ("bootstrap", "bs", "bootstrap_residuals"):
                    stat_folder = "Bootstrap"
                    canon_key = "bootstrap"
                    method_title = "Bootstrap"
                elif u_method_norm in ("bootstrap_case", "bs_case"):
                    stat_folder = "Bootstrap"
                    canon_key = "bootstrap"
                    method_title = "Bootstrap (Case)"
                elif u_method_norm in ("mcmc",):
                    stat_folder = "MCMC"
                    canon_key = "mcmc"
                    method_title = "MCMC"
                else:
                    stat_folder = "MonteCarlo"
                    canon_key = "monte_carlo"
                    method_title = "Monte Carlo"

                def _resample_progress_cb(cur: int, total: int, msg: str):
                    try:
                        p_file = os.path.join(run_dir, "progress.json")
                        pct = 85 + int((cur / max(1, total)) * 14)
                        with open(p_file, "w", encoding="utf-8") as pf:
                            json.dump({
                                "kind": "resample",
                                "stage": f"Resampling ({method_title})",
                                "percent": pct,
                                "message": msg,
                                "updated_at": datetime.now().timestamp(),
                            }, pf)
                    except Exception:
                        pass

                _log(f"Starting {method_title} uncertainty estimation ({n_samples} samples, seed={seed})...")
                resampled_result, rep_mat, p_names, chi_arr, diag_dict = run_relaxation_resampling_analysis(
                    peak_results=peak_results,
                    analysis_type=analysis.analysis_type,
                    method=u_method_norm,
                    n_samples=n_samples,
                    seed=seed,
                    noise_source=noise_source,
                    progress_callback=_resample_progress_cb,
                )
                _log(f"Completed {method_title} resampling across {len(peak_results)} peaks.")

                # Save ChemEx-compatible Statistics folder
                resamp_stat_dir = os.path.join(run_dir, "Statistics", stat_folder)
                save_relaxation_statistics_files(
                    resamp_stat_dir,
                    method_title,
                    resampled_result,
                    rep_mat,
                    p_names,
                    chisqr_array=chi_arr,
                    diagnostics=diag_dict,
                )

                unc_results_map[canon_key] = resampled_result
                if "correlations" in diag_dict:
                    correlations_by_method[canon_key] = diag_dict["correlations"]

                # Update peak_results with resampled error and confidence intervals
                # Point estimates (rate, amplitude) remain 100% bit-identical
                for p in peak_results:
                    assign = p["assignment"]
                    r_name = f"{rate_param_name}, NUC->{assign}"
                    a_name = f"{amp_param_name}, NUC->{assign}"
                    p["rate_err_cov"] = p["rate_err"]
                    p["amplitude_err_cov"] = p["amplitude_err"]
                    if r_name in resampled_result.sd:
                        p["rate_err"] = float(resampled_result.sd[r_name])
                        p["rate_err_resampled"] = float(resampled_result.sd[r_name])
                    if a_name in resampled_result.sd:
                        p["amplitude_err"] = float(resampled_result.sd[a_name])
                        p["amplitude_err_resampled"] = float(resampled_result.sd[a_name])
                    if r_name in resampled_result.intervals:
                        p["interval_68"] = list(resampled_result.intervals[r_name].interval_68)
                        p["interval_95"] = list(resampled_result.intervals[r_name].interval_95)

            uncertainty_stats = uncertainty_result_to_statistics_payload(
                unc_results_map,
                correlations_by_method=correlations_by_method,
            )

            # Emit final completion state to progress.json
            progress_file = os.path.join(run_dir, "progress.json")
            try:
                with open(progress_file, "w", encoding="utf-8") as pf:
                    json.dump({
                        "kind": "fit",
                        "stage": "Completed",
                        "percent": 100,
                        "message": f"Fitted {len(peak_results)} peaks.",
                        "updated_at": datetime.now().timestamp(),
                    }, pf)
            except Exception:
                pass

            results_payload = {
                "analysis_uuid": analysis_uuid,
                "timestamp": datetime.now().isoformat(),
                "noise_model": noise_source,
                "uncertainty_method": uncertainty_method,
                "peak_results": peak_results,
                "uncertainty_statistics": uncertainty_stats,
                "uncertainty_results": {k: v.model_dump() for k, v in unc_results_map.items()},
            }

            with open(res_file, 'w', encoding="utf-8") as f:
                json.dump(results_payload, f, indent=4)

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
