import os
import shutil
import logging

logger = logging.getLogger("uvicorn.error")

def delete_file_safely(filepath: str):
    """Delete a file if it exists, logging any errors."""
    if not filepath:
        return
        
    try:
        if os.path.exists(filepath) and os.path.isfile(filepath):
            os.remove(filepath)
            logger.info(f"Deleted file: {filepath}")
    except Exception as e:
        logger.error(f"Failed to delete file {filepath}: {str(e)}")

def delete_directory_safely(dirpath: str):
    """Recursively delete a directory if it exists, logging any errors."""
    if not dirpath:
        return
        
    try:
        if os.path.exists(dirpath) and os.path.isdir(dirpath):
            shutil.rmtree(dirpath)
            logger.info(f"Deleted directory: {dirpath}")
    except Exception as e:
        logger.error(f"Failed to delete directory {dirpath}: {str(e)}")

def cleanup_spectrum_files(spectrum, project_root: str):
    """
    Clean up JSON metadata and fitting results for a spectrum.
    Handles both legacy flat paths and new hierarchical structures.
    """
    # 1. Delete spectrum metadata JSON
    s_uuid = spectrum.spectrum_uuid or f"legacy_{spectrum.id}"
    spectrum_json = os.path.join(project_root, f"spectrum_{s_uuid}.json")
    delete_file_safely(spectrum_json)
    
    # 2. Delete fitting results JSON
    if spectrum.results_json_path:
        fit_path = spectrum.results_json_path
        delete_file_safely(fit_path)
        
        # If it's in a run-specific folder, try to delete the folder if it becomes empty
        run_dir = os.path.dirname(fit_path)
        if "peak_fitting/run_" in run_dir:
            try:
                if os.path.exists(run_dir) and not os.listdir(run_dir):
                    os.rmdir(run_dir)
                    logger.info(f"Deleted empty run directory: {run_dir}")
            except Exception:
                pass # Non-critical failure
