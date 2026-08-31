import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.path import Path
from typing import Tuple, List

def estimate_noise_mad(data: np.ndarray) -> float:
    """Estimate noise level using Median Absolute Deviation."""
    return 1.4826 * np.median(np.abs(data - np.median(data)))

def extract_paths(cs) -> Tuple[List[float], List[float]]:
    """Extract (x, y) coordinates from matplotlib contour set."""
    xs, ys = [], []
    try:
        # matplotlib >= 3.8
        all_paths = cs.get_paths()
        for path in all_paths:
            verts = path.vertices
            codes = path.codes
            if codes is None:
                xs.extend(verts[:, 0].tolist() + [None])
                ys.extend(verts[:, 1].tolist() + [None])
            else:
                seg_start = 0
                for i, code in enumerate(codes):
                    if code == Path.MOVETO and i > 0:
                        xs.extend(verts[seg_start:i, 0].tolist() + [None])
                        ys.extend(verts[seg_start:i, 1].tolist() + [None])
                        seg_start = i
                xs.extend(verts[seg_start:, 0].tolist() + [None])
                ys.extend(verts[seg_start:, 1].tolist() + [None])
    except AttributeError:
        # matplotlib < 3.8 fallback
        for collection in cs.collections:
            for path in collection.get_paths():
                verts = path.vertices
                xs.extend(verts[:, 0].tolist() + [None])
                ys.extend(verts[:, 1].tolist() + [None])
    return xs, ys

def generate_contours(
    x_axis: np.ndarray, 
    y_axis: np.ndarray, 
    plane: np.ndarray, 
    base_level: float, 
    multiplier: float, 
    number_contours: int
) -> dict:
    """Generate positive and negative contour paths for Plotly."""
    positive_base_level = base_level
    negative_base_level = -1 * positive_base_level
    
    cl_positive = [positive_base_level * (multiplier ** i) for i in range(number_contours)]
    cl_negative = sorted([negative_base_level * (multiplier ** i) for i in range(number_contours)])
    
    fig_mpl, ax_mpl = plt.subplots()
    
    cs_pos = ax_mpl.contour(x_axis, y_axis, plane, levels=cl_positive)
    cs_neg = ax_mpl.contour(x_axis, y_axis, plane, levels=cl_negative)
    plt.close(fig_mpl)

    xs_pos, ys_pos = extract_paths(cs_pos)
    xs_neg, ys_neg = extract_paths(cs_neg)
    
    return {
        "xs_pos": xs_pos,
        "ys_pos": ys_pos,
        "xs_neg": xs_neg,
        "ys_neg": ys_neg
    }
