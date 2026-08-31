import sys
import logging
import re
import os
from pathlib import Path
from typing import List, Optional, Tuple
from enum import Enum

import numpy as np
import nmrglue as ng
import pandas as pd
import textwrap
from rich import print
from rich.console import Console


from bokeh.palettes import Category20
from scipy import ndimage
from skimage.morphology import binary_closing, disk, footprint_rectangle
from skimage.filters import threshold_otsu
from pydantic import BaseModel

from .utils import df_to_rich_table
from .fitting import make_mask

console = Console()


class UnknownFormat(Exception):
    pass


class StrucEl(str, Enum):
    square = "square"
    disk = "disk"
    rectangle = "rectangle"
    mask_method = "mask_method"


class PeaklistFormat(str, Enum):
    a2 = "a2"
    a3 = "a3"
    sparky = "sparky"
    pipe = "pipe"
    peakipy = "peakipy"
    csv = "csv"


class OutFmt(str, Enum):
    csv = "csv"
    pkl = "pkl"


AA_MAP = {
    "A": "ALA", "R": "ARG", "N": "ASN", "D": "ASP", "C": "CYS",
    "Q": "GLN", "E": "GLU", "G": "GLY", "H": "HIS", "I": "ILE",
    "L": "LEU", "K": "LYS", "M": "MET", "F": "PHE", "P": "PRO",
    "S": "SER", "T": "THR", "W": "TRP", "Y": "TYR", "V": "VAL"
}


def _standardize_residue_name(name: str) -> str:
    if not name:
        return ""
    if len(name) == 1:
        return AA_MAP.get(name.upper(), name)
    return name.upper()


def _parse_assignment(val: str, fmt: str) -> tuple[Optional[int], str, str]:
    """Parse assignment string into (res_num, res_name, standardized_ass)."""
    if not val or val == "None_dummy_0" or val == "nan":
        return None, "", "None_dummy_0"

    # Fallback/Pre-check: If it already looks like "83GLU", parse it immediately
    match_std = re.match(r"^(\d+)([A-Z]+)$", val, re.I)
    if match_std:
        res_num_str = match_std.group(1)
        res_num = int(res_num_str)
        res_name = _standardize_residue_name(match_std.group(2))
        return res_num, res_name, f"{res_num_str}{res_name}"

    res_num_val = None
    res_name = ""

    try:
        if fmt == "pipe":
            # Pipe: 23ILE
            match = re.match(r"(\d+)([A-Z]*)", val, re.I)
            if match:
                res_num_str = match.group(1)
                res_num_val = int(res_num_str)
                res_name = _standardize_residue_name(match.group(2))
        elif fmt == "a3" or fmt == "a2":
            # Analysis v3: 138.83.E.H
            parts = val.split(".")
            if len(parts) >= 3:
                res_num_str = parts[1]
                res_num_val = int(res_num_str)
                res_name = _standardize_residue_name(parts[2])
        elif fmt == "sparky":
            # Sparky: G4N-H
            match = re.match(r"([A-Z])(\d+)(.*)", val, re.I)
            if match:
                res_name = _standardize_residue_name(match.group(1))
                res_num_str = match.group(2)
                res_num_val = int(res_num_str)
    except Exception:
        pass

    if res_num_val is not None or res_name:
        res_num_str = str(res_num_val) if res_num_val is not None else ""
        standardized = f"{res_num_str}{res_name}"
        return res_num_val, res_name, standardized

    return None, "", val


class PeaklistColumns(BaseModel):
    """These are the columns required for performing fits in peakipy"""

    INDEX: int
    X_AXIS: int
    Y_AXIS: int
    X_AXISf: float
    Y_AXISf: float
    X_PPM: float
    Y_PPM: float
    XW: float
    YW: float
    XW_HZ: float
    YW_HZ: float
    HEIGHT: float
    VOL: float
    ASS: str
    X_RADIUS: float
    Y_RADIUS: float
    X_RADIUS_PPM: float
    Y_RADIUS_PPM: float
    include: str
    CLUSTID: int = 0
    MEMCNT: int = 0
    color: str = "black"
    RES_NUM: Optional[int] = None
    RES_NAME: str = ""
    lineshape: Optional[str] = None
    fraction: Optional[float] = None
    fraction_x: Optional[float] = None
    fraction_y: Optional[float] = None


class PeaklistColumnsWithClusters(PeaklistColumns):
    CLUSTID: int
    MEMCNT: int
    color: str


class BrukerUC:
    """A custom unit conversion class for Bruker processed data to mimic nmrglue's UC."""
    def __init__(self, dic: dict, dim: int):
        self.key = 'procs' if dim == 1 else 'proc2s' # Wait, in nmr_axis dim=2 was F2, dim=1 was F1.
        # But in Pseudo3D, self._f2_dim is usually 1 and self._f1_dim is 0 (if 2D) or 1,2 (if 3D).
        # Standard convention in this app seems to be f2 is direct, f1 is indirect.
        # Let's align with the user's provided logic (nmr_axis: dim=2 -> procs, dim=1 -> proc2s).
        # Actually, Pseudo3D uses f1_dim and f2_dim which are indices into udic.
        # If udic matches Bruker dims, then we should map them.
        
        # User defined nmr_axis(dic, dim=2, unit='ppm') where dim=2 is F2.
        # In Pseudo3D: self._f2_dim is the dim index.
        # If it's 2D data: data.shape is (F1, F2). udic[0] is F1, udic[1] is F2.
        # So f2_dim = 1, f1_dim = 0.
        # Thus, if dim == 1 -> procs (F2), if dim == 0 -> proc2s (F1).
        
        if 'procs' in dic and 'proc2s' in dic:
            # Map dim index to Bruker procs/proc2s
            # This is a bit heuristic. Usually the last dimension is direct (procs).
            # But let's check if the dim index is for F2 or F1.
            # In Pseudo3D.__init__, self._f2_dim and self._f1_dim are indices.
            # If dim == self._f2_dim -> procs, if dim == self._f1_dim -> proc2s.
            # We'll pass these as explicit flags or handle within.
            pass

    @classmethod
    def from_dic(cls, dic, dim_type):
        """dim_type: 'f1' or 'f2'"""
        obj = cls.__new__(cls)
        key = 'procs' if dim_type == 'f2' else 'proc2s'
        p = dic.get(key, {})
        if not p and key == 'proc2s':
             # fallback for 1D or if proc2s is missing
             p = dic.get('procs', {})
             
        obj.sf = p.get('SF', 1.0)
        obj.sw_hz = p.get('SW_p', 0.0)
        obj.offset = p.get('OFFSET', 0.0)
        obj.si = int(p.get('SI', 1))
        return obj

    def ppm_limits(self):
        p0 = self.offset
        p1 = self.offset - (self.si - 1) * self.sw_hz / (self.si * self.sf)
        return p0, p1

    def ppm(self, val):
        """Convert points to ppm."""
        return self.offset - val * self.sw_hz / (self.si * self.sf)

    def hz(self, val):
        """Convert points to Hz."""
        return self.ppm(val) * self.sf

    def __call__(self, val, unit='ppm'):
        if unit == 'ppm':
            return int(round((self.offset - val) * (self.si * self.sf) / self.sw_hz))
        return val

    def f(self, val, unit='ppm'):
        if unit == 'ppm':
            return (self.offset - val) * (self.si * self.sf) / self.sw_hz
        return float(val)

    def ppm_scale(self):
        i = np.arange(self.si)
        return self.offset - i * self.sw_hz / (self.si * self.sf)

    def __len__(self):
        return self.si

    @property
    def sw_ppm(self):
        return self.sw_hz / self.sf

    @property
    def pt_per_ppm(self):
        return self.si / self.sw_ppm

    @property
    def pt_per_hz(self):
        return self.si / self.sw_hz

    @property
    def hz_per_pt(self):
        return self.sw_hz / self.si


class Pseudo3D:
    """Read dic, data from NMRGlue and dims from input to create a Pseudo3D dataset

    :param dic: from nmrglue.pipe.read
    :type dic: dict

    :param data: data from nmrglue.pipe.read
    :type data: numpy.array

    :param dims: dimension order i.e [0,1,2] where 0 = planes, 1 = f1, 2 = f2
    :type dims: list
    """

    def __init__(self, dic, data, dims):
        # check dimensions
        if "procs" in dic or "acqus" in dic:
            # Bruker data
            self._udic = ng.bruker.guess_udic(dic, data)
            self._is_bruker = True
        else:
            # Pipe data
            self._udic = ng.pipe.guess_udic(dic, data)
            self._is_bruker = False
        
        self._ndim = self._udic["ndim"]

        if self._ndim == 1:
            err = f"""[red]
            ##########################################
                NMR Data should be either 2D or 3D
            ##########################################
            [/red]"""
            # raise TypeError(err)
            sys.exit(err)

        # check that spectrum has correct number of dims
        elif self._ndim != len(dims):
            err = f"""[red]
            #################################################################
               Your spectrum has {self._ndim} dimensions with shape {data.shape}
               but you have given a dimension order of {dims}...
            #################################################################
            [/red]"""
            # raise ValueError(err)
            sys.exit(err)

        elif (self._ndim == 2) and (len(dims) == 2):
            self._f1_dim, self._f2_dim = dims
            self._planes = 0
            if self._is_bruker:
                 self._uc_f1 = BrukerUC.from_dic(dic, 'f1')
                 self._uc_f2 = BrukerUC.from_dic(dic, 'f2')
            else:
                self._uc_f1 = ng.pipe.make_uc(dic, data, dim=self._f1_dim)
                self._uc_f2 = ng.pipe.make_uc(dic, data, dim=self._f2_dim)
            if self._is_bruker and data.ndim == 3:
                # Drop planes where max intensity is very small (near 0)
                mask = np.array([np.max(np.abs(data[i])) > 1e-6 for i in range(data.shape[0])])
                if not np.all(mask):
                    print(f"DEBUG: Dropping {np.sum(~mask)} empty planes from Bruker data.")
                    data = data[mask]
            
            # make data pseudo3d
            self._data = data.reshape((1, data.shape[0], data.shape[1]))
            self._dims = [self._planes, self._f1_dim + 1, self._f2_dim + 1]
        
        else:
            self._planes, self._f1_dim, self._f2_dim = dims
            self._dims = dims

            if self._is_bruker:
                if data.ndim == 3:
                    # Drop planes where max intensity is very small (near 0)
                    mask = np.array([np.max(np.abs(data[i])) > 1e-6 for i in range(data.shape[0])])
                    if not np.all(mask):
                        print(f"DEBUG: Dropping {np.sum(~mask)} empty planes from Bruker data.")
                        data = data[mask]
                
                self._uc_f1 = BrukerUC.from_dic(dic, 'f1')
                self._uc_f2 = BrukerUC.from_dic(dic, 'f2')
            else:
                self._uc_f2 = ng.pipe.make_uc(dic, data, dim=self._f2_dim)
                self._uc_f1 = ng.pipe.make_uc(dic, data, dim=self._f1_dim)
            
            self._data = data

        #  rearrange data if dims not in standard order
        if self._dims != [0, 1, 2]:
            # np.argsort returns indices of array for order 0,1,2 to transpose data correctly
            # self._dims = np.argsort(self._dims)
            self._data = np.transpose(data, self._dims)

        self._dic = dic
        if self._is_bruker:
            self._f2_label = dic.get('procs', {}).get('AXNNAME', 'F2')
            self._f1_label = dic.get('proc2s', {}).get('AXNNAME', 'F1')
        else:
            self._f1_label = self._udic[self._f1_dim]["label"]
            self._f2_label = self._udic[self._f2_dim]["label"]

    @property
    def uc_f1(self):
        """Return unit conversion dict for F1"""
        return self._uc_f1

    @property
    def uc_f2(self):
        """Return unit conversion dict for F2"""
        return self._uc_f2

    @property
    def dims(self):
        """Return dimension order"""
        return self._dims

    @property
    def data(self):
        """Return array containing data"""
        return self._data

    @data.setter
    def data(self, data):
        self._data = data

    @property
    def dic(self):
        return self._dic

    @property
    def udic(self):
        return self._udic

    @property
    def ndim(self):
        return self._ndim

    @property
    def f1_label(self):
        # dim label
        return self._f1_label

    @property
    def f2_label(self):
        # dim label
        return self._f2_label

    @property
    def planes(self):
        return self.dims[0]

    @property
    def n_planes(self):
        return self.data.shape[self.planes]

    @property
    def f1(self):
        return self.dims[1]

    @property
    def f2(self):
        return self.dims[2]

    # size of f1 and f2 in points
    @property
    def f2_size(self):
        """Return size of f2 dimension in points"""
        return self._udic[self._f2_dim]["size"]

    @property
    def f1_size(self):
        """Return size of f1 dimension in points"""
        return self._udic[self._f1_dim]["size"]

    # points per ppm
    @property
    def pt_per_ppm_f1(self):
        if self._is_bruker:
            return self._uc_f1.pt_per_ppm
        return self.f1_size / (
            self._udic[self._f1_dim]["sw"] / self._udic[self._f1_dim]["obs"]
        )

    @property
    def pt_per_ppm_f2(self):
        if self._is_bruker:
            return self._uc_f2.pt_per_ppm
        return self.f2_size / (
            self._udic[self._f2_dim]["sw"] / self._udic[self._f2_dim]["obs"]
        )

    # points per hz
    @property
    def pt_per_hz_f1(self):
        if self._is_bruker:
            return self._uc_f1.pt_per_hz
        return self.f1_size / self._udic[self._f1_dim]["sw"]

    @property
    def pt_per_hz_f2(self):
        if self._is_bruker:
            return self._uc_f2.pt_per_hz
        return self.f2_size / self._udic[self._f2_dim]["sw"]

    # hz per point
    @property
    def hz_per_pt_f1(self):
        return 1.0 / self.pt_per_hz_f1

    @property
    def hz_per_pt_f2(self):
        return 1.0 / self.pt_per_hz_f2

    # ppm per point
    @property
    def ppm_per_pt_f1(self):
        return 1.0 / self.pt_per_ppm_f1

    @property
    def ppm_per_pt_f2(self):
        return 1.0 / self.pt_per_ppm_f2

    # get ppm limits for ppm scales
    @property
    def f2_ppm_scale(self):
        return self.uc_f2.ppm_scale()

    @property
    def f1_ppm_scale(self):
        return self.uc_f1.ppm_scale()

    @property
    def f2_ppm_limits(self):
        return self.uc_f2.ppm_limits()

    @property
    def f1_ppm_limits(self):
        return self.uc_f1.ppm_limits()

    @property
    def f1_ppm_max(self):
        return max(self.f1_ppm_limits)

    @property
    def f1_ppm_min(self):
        return min(self.f1_ppm_limits)

    @property
    def f2_ppm_max(self):
        return max(self.f2_ppm_limits)

    @property
    def f2_ppm_min(self):
        return min(self.f2_ppm_limits)

    @property
    def f2_ppm_0(self):
        return self.f2_ppm_limits[0]

    @property
    def f2_ppm_1(self):
        return self.f2_ppm_limits[1]

    @property
    def f1_ppm_0(self):
        return self.f1_ppm_limits[0]

    @property
    def f1_ppm_1(self):
        return self.f1_ppm_limits[1]


class UnknownFormat(Exception):
    pass



class Peaklist(Pseudo3D):
    """Read analysis, sparky or NMRPipe peak list and convert to NMRPipe-ish format also find peak clusters

    Parameters
    ----------
    path : path-like or str
        path to peaklist
    data_path : ndarray
        NMRPipe format data
    fmt : str
        a2|a3|sparky|pipe
    dims: list
        [planes,y,x]
    radii: list
        [x,y] Mask radii in ppm


    Methods
    -------

    clusters :
    mask_method :
    adaptive_clusters :

    Returns
    -------
    df : pandas DataFrame
        dataframe containing peaklist

    """

    def __init__(
        self,
        path,
        data_path,
        fmt: PeaklistFormat = PeaklistFormat.a2,
        dims=[0, 1, 2],
        radii=[0.04, 0.4],
        posF1="Position F1",
        posF2="Position F2",
        verbose=False,
    ):
        if os.path.isdir(data_path):
            dic, data = ng.bruker.read_pdata(data_path)
        else:
            dic, data = ng.pipe.read(data_path)
        Pseudo3D.__init__(self, dic, data, dims)
        self.fmt = fmt
        self.peaklist_path = path
        self.data_path = data_path
        self.verbose = verbose
        self._radii = radii
        self._thres = None
        self.excluded = pd.DataFrame()
        if self.verbose:
            print(
                "Points per hz f1 = %.3f, f2 = %.3f"
                % (self.pt_per_hz_f1, self.pt_per_hz_f2)
            )

        self._analysis_to_pipe_dic = {
            "#": "INDEX",
            "Position F1": "Y_PPM", # Indirect
            "Position F2": "X_PPM", # Direct
            "Line Width F1 (Hz)": "YW_HZ",
            "Line Width F2 (Hz)": "XW_HZ",
            "Height": "HEIGHT",
            "Volume": "VOL",
            "X Radius": "X_RADIUS_PPM",
            "Y Radius": "Y_RADIUS_PPM",
        }
        self._assign_to_pipe_dic = {
            "#": "INDEX",
            "Pos F1": "Y_PPM", # Indirect
            "Pos F2": "X_PPM", # Direct
            "LW F1 (Hz)": "YW_HZ",
            "LW F2 (Hz)": "XW_HZ",
            "Height": "HEIGHT",
            "Volume": "VOL",
            "X Radius": "X_RADIUS_PPM",
            "Y Radius": "Y_RADIUS_PPM",
        }

        self._sparky_to_pipe_dic = {
            "index": "INDEX",
            "w1": "Y_PPM",
            "w2": "X_PPM",
            "lw1 (hz)": "YW_HZ",
            "lw2 (hz)": "XW_HZ",
            "Height": "HEIGHT",
            "Volume": "VOL",
            "Assignment": "ASS",
        }

        self._analysis_to_pipe_dic[posF1] = "Y_PPM"
        self._analysis_to_pipe_dic[posF2] = "X_PPM"

        self._df = self.read_peaklist()

    def read_peaklist(self):
        match self.fmt:
            case PeaklistFormat.a2:
                self._df = self._read_analysis()

            case PeaklistFormat.a3:
                self._df = self._read_assign()

            case PeaklistFormat.sparky:
                self._df = self._read_sparky()

            case PeaklistFormat.pipe:
                self._df = self._read_pipe()

            case PeaklistFormat.peakipy:
                self._df = self._read_peakipy()
            
            case PeaklistFormat.csv:
                self._df = self._read_csv()

            case _:
                raise UnknownFormat(f"I don't know this format: {self.fmt}")

        return self._df

    @property
    def df(self):
        return self._df

    @df.setter
    def df(self, df):
        self._df = df
        return self._df

    @property
    def radii(self):
        return self._radii

    def check_radius_contains_enough_points_for_fitting(self, radius, pt_per_ppm, flag):
        if (radius * pt_per_ppm) < 2.0:
            new_radius = 2.0 * (1./ pt_per_ppm)
            print(
                "\n",
                f"[red]Warning: {flag} is set to {radius:.3f} ppm which is {radius * pt_per_ppm:.3f} points[/red]" + "\n",
                f"[yellow]Setting to 2 points which is {new_radius:.3f} ppm[/yellow]" + "\n",
                f"[yellow]Consider increasing this value to improve robustness of fitting (or increase zero filling)[/yellow]" + "\n",
            )
        else:
            new_radius = radius
        return new_radius

    @property
    def f2_radius(self):
        """radius for fitting mask in f2"""
        _f2_radius = self.check_radius_contains_enough_points_for_fitting(self.radii[0], self.pt_per_ppm_f2, "--x-radius-ppm")
        return _f2_radius

    @property
    def f1_radius(self):
        """radius for fitting mask in f1"""
        _f1_radius = self.check_radius_contains_enough_points_for_fitting(self.radii[1], self.pt_per_ppm_f1, "--y-radius-ppm")
        return _f1_radius

    @property
    def analysis_to_pipe_dic(self):
        return self._analysis_to_pipe_dic

    @property
    def assign_to_pipe_dic(self):
        return self._assign_to_pipe_dic

    @property
    def sparky_to_pipe_dic(self):
        return self._sparky_to_pipe_dic

    @property
    def thres(self):
        if self._thres == None:
            self._thres = abs(threshold_otsu(self.data[0]))
            return self._thres
        else:
            return self._thres

    def validate_peaklist(self):
        if self.df.empty:
            # Ensure empty DF has the correct columns for Pydantic/Peakipy
            cols = list(PeaklistColumns.model_fields.keys())
            self.df = pd.DataFrame(columns=cols)
            return self.df
            
        # Convert NaN to None so Pydantic can handle Optional fields
        records = self.df.to_dict(orient="records")
        for record in records:
            for key, value in record.items():
                if pd.isna(value):
                    record[key] = None

        self.df = pd.DataFrame(
            [
                PeaklistColumns(**i).model_dump()
                for i in records
            ]
        )
        return self.df

    def update_df(self):
        # Perform robust column mapping first
        col_map = {str(c).lower().strip(): c for c in self.df.columns}

        # Mapping for INDEX
        if "INDEX" not in self.df.columns:
            if "#" in col_map: self.df["INDEX"] = self.df[col_map["#"]]
            elif "id" in col_map: self.df["INDEX"] = self.df[col_map["id"]]
            elif "pid" in col_map: self.df["INDEX"] = self.df[col_map["pid"]]
            else: self.df["INDEX"] = self.df.index
        # Mapping for X_PPM (Direct / F2)
        if "X_PPM" not in self.df.columns:
            if "pos f2" in col_map: self.df["X_PPM"] = self.df[col_map["pos f2"]]
            elif "pos f1" in col_map: self.df["X_PPM"] = self.df[col_map["pos f1"]] # Greedy
            elif "[pos f2]" in col_map: self.df["X_PPM"] = self.df[col_map["[pos f2]"]]
            elif "position f2" in col_map: self.df["X_PPM"] = self.df[col_map["position f2"]]

        # Mapping for Y_PPM (Indirect / F1)
        if "Y_PPM" not in self.df.columns:
            if "pos f1" in col_map: self.df["Y_PPM"] = self.df[col_map["pos f1"]]
            elif "pos f2" in col_map: self.df["Y_PPM"] = self.df[col_map["pos f2"]] # Greedy
            elif "[pos f1]" in col_map: self.df["Y_PPM"] = self.df[col_map["[pos f1]"]]
            elif "position f1" in col_map: self.df["Y_PPM"] = self.df[col_map["position f1"]]

        # Mapping for LW_HZ
        if "XW_HZ" not in self.df.columns:
            if "lw f2" in col_map: self.df["XW_HZ"] = self.df[col_map["lw f2"]]
            elif "lw_f2" in col_map: self.df["XW_HZ"] = self.df[col_map["lw_f2"]]
        if "YW_HZ" not in self.df.columns:
            if "lw f1" in col_map: self.df["YW_HZ"] = self.df[col_map["lw f1"]]
            elif "lw_f1" in col_map: self.df["YW_HZ"] = self.df[col_map["lw_f1"]]
        
        # Mapping for Radii
        if "X_RADIUS_PPM" not in self.df.columns:
            if "x radius" in col_map: self.df["X_RADIUS_PPM"] = self.df[col_map["x radius"]]
        if "Y_RADIUS_PPM" not in self.df.columns:
            if "y radius" in col_map: self.df["Y_RADIUS_PPM"] = self.df[col_map["y radius"]]

        # Mapping for Assignments
        # makes an assignment column from Assign F1 and Assign F2 if available
        if "ASS" not in self.df.columns or self.df["ASS"].isnull().all():
            if "assignment" in col_map:
                self.df["ASS"] = self.df[col_map["assignment"]]
            elif "assign f1" in col_map and "assign f2" in col_map:
                self.df["ASS"] = self.df.apply(lambda i: f"{i[col_map['assign f1']]}_{i[col_map['assign f2']]}", axis=1)
            elif "[assign f1]" in col_map and "[assign f2]" in col_map:
                 self.df["ASS"] = self.df.apply(lambda i: f"{i[col_map['[assign f1]']]}_{i[col_map['[assign f2]']]}", axis=1)
            elif "assign f1" in self.df.columns and "assign f2" in self.df.columns:
                 self.df["ASS"] = self.df.apply(lambda i: f"{i['assign f1']}_{i['assign f2']}", axis=1)
        
        if "ASS" in self.df.columns:
            self.df["ASS"] = self.df["ASS"].fillna("None_dummy_0").astype(str)
            
            # Standardize ASS and populate RES_NUM, RES_NAME
            def apply_parsing(ass_val):
                rn, rnam, std = _parse_assignment(ass_val, self.fmt.value)
                return pd.Series({"RES_NUM": rn, "RES_NAME": rnam, "ASS": std})

            residue_info = self.df["ASS"].apply(apply_parsing)
            self.df["RES_NUM"] = residue_info["RES_NUM"]
            self.df["RES_NAME"] = residue_info["RES_NAME"]
            self.df["ASS"] = residue_info["ASS"]
        else:
            self.df["ASS"] = "None_dummy_0"
            self.df["RES_NUM"] = None
            self.df["RES_NAME"] = ""

        # Add descriptive error for out-of-bounds peaklists
        if "X_PPM" not in self.df.columns or "Y_PPM" not in self.df.columns:
            raise ValueError(f"Peaklist is missing required columns 'X_PPM' or 'Y_PPM' (or identifiable synonyms like 'Pos F1', 'Pos F2'). Found columns: {list(self.df.columns)}")

        # Ensure numeric and drop rows with missing positions
        self.df["X_PPM"] = pd.to_numeric(self.df["X_PPM"], errors='coerce')
        self.df["Y_PPM"] = pd.to_numeric(self.df["Y_PPM"], errors='coerce')
        self.df = self.df.dropna(subset=["X_PPM", "Y_PPM"])
        
        # in case of missing values, try to estimate from radii
        if "XW_HZ" not in self.df.columns: self.df["XW_HZ"] = np.nan
        if "YW_HZ" not in self.df.columns: self.df["YW_HZ"] = np.nan
        
        # Helper to estimate LW in Hz from radius in PPM
        # Rough estimate: LW_HZ = Radius_PPM * Obs_Freq
        def estimate_lw(lw, radius, obs):
            # Convert to float to be sure
            try:
                flw = float(lw)
            except (ValueError, TypeError):
                flw = np.nan
            
            if (pd.isna(flw) or flw == 0) and not pd.isna(radius):
                try:
                    return float(radius) * float(obs)
                except (ValueError, TypeError):
                    return 20.0
            return flw if not pd.isna(flw) else 20.0

        obs_f2 = self._udic[self._f2_dim]["obs"]
        obs_f1 = self._udic[self._f1_dim]["obs"]
        
        self.df["XW_HZ"] = self.df.apply(lambda r: estimate_lw(r.get("XW_HZ"), r.get("X_RADIUS_PPM"), obs_f2), axis=1)
        self.df["YW_HZ"] = self.df.apply(lambda r: estimate_lw(r.get("YW_HZ"), r.get("Y_RADIUS_PPM"), obs_f1), axis=1)
        
        # Convert Hz lw to points
        self.df["XW"] = self.df.XW_HZ.apply(lambda x: x * self.pt_per_hz_f2)
        self.df["YW"] = self.df.YW_HZ.apply(lambda x: x * self.pt_per_hz_f1)

        # Handle required Height and Volume columns
        if "HEIGHT" not in self.df.columns: self.df["HEIGHT"] = 0.0
        if "VOL" not in self.df.columns: self.df["VOL"] = 0.0
        self.df["HEIGHT"] = pd.to_numeric(self.df["HEIGHT"], errors='coerce').fillna(0.0)
        self.df["VOL"] = pd.to_numeric(self.df["VOL"], errors='coerce').fillna(0.0)

        # Set required index/points columns
        self.df["X_AXIS"] = self.df.X_PPM.apply(lambda x: self.uc_f2(x, "ppm"))
        self.df["Y_AXIS"] = self.df.Y_PPM.apply(lambda x: self.uc_f1(x, "ppm"))
        self.df["X_AXISf"] = self.df.X_PPM.apply(lambda x: self.uc_f2.f(x, "ppm"))
        self.df["Y_AXISf"] = self.df.Y_PPM.apply(lambda x: self.uc_f1.f(x, "ppm"))

        # make default values for X and Y radii for fit masks
        if "X_RADIUS_PPM" not in self.df.columns: self.df["X_RADIUS_PPM"] = self.f2_radius
        if "Y_RADIUS_PPM" not in self.df.columns: self.df["Y_RADIUS_PPM"] = self.f1_radius
        
        self.df["X_RADIUS"] = self.df.X_RADIUS_PPM.apply(lambda x: x * self.pt_per_ppm_f2)
        self.df["Y_RADIUS"] = self.df.Y_RADIUS_PPM.apply(lambda x: x * self.pt_per_ppm_f1)
        
        # add include column
        if "include" not in self.df.columns:
            self.df["include"] = "yes"

        # check assignments for duplicates
        self.check_assignments()
        # check that peaks are within the bounds of the data
        self.check_peak_bounds()
        self.validate_peaklist()

    def add_fix_bound_columns(self):
        """add columns containing parameter bounds (param_upper/param_lower)
        and whether or not parameter should be fixed (yes/no)

        For parameter bounding:

            Column names are <param_name>_upper and <param_name>_lower for upper and lower bounds respectively.
            Values are given as floating point. Value of 0.0 indicates that parameter is unbounded
            X/Y positions are given in ppm
            Linewidths are given in Hz

        For parameter fixing:

            Column names are <param_name>_fix.
            Values are given as a string 'yes' or 'no'

        """
        pass

    def _read_analysis(self):
        df = pd.read_csv(self.peaklist_path, delimiter="\t")
        new_columns = [self.analysis_to_pipe_dic.get(i, i) for i in df.columns]
        pipe_columns = dict(zip(df.columns, new_columns))
        df = df.rename(index=str, columns=pipe_columns)

        return df

    def _read_assign(self):
        # Use automatic separator detection
        df = pd.read_csv(self.peaklist_path, sep=None, engine='python')
        new_columns = [self.assign_to_pipe_dic.get(i, i) for i in df.columns]
        pipe_columns = dict(zip(df.columns, new_columns))
        df = df.rename(index=str, columns=pipe_columns)

        return df

    def _read_sparky(self):
        df = pd.read_csv(
            self.peaklist_path,
            skiprows=1,
            sep=r"\s+",
            names=["ASS", "Y_PPM", "X_PPM"],
            # use only first three columns
            usecols=[i for i in range(3)],
        )
        df["INDEX"] = df.index
        # need to add LW estimate
        df["XW_HZ"] = 20.0
        df["YW_HZ"] = 20.0
        # dummy values
        df["HEIGHT"] = 0.0
        df["VOL"] = 0.0
        return df

    def _read_pipe(self):
        to_skip = 0
        with open(self.peaklist_path) as f:
            lines = f.readlines()
            for line in lines:
                if line.startswith("VARS"):
                    columns = line.strip().split()[1:]
                elif line[:5].strip(" ").isdigit():
                    break
                else:
                    to_skip += 1
        df = pd.read_csv(
            self.peaklist_path, skiprows=to_skip, names=columns, sep=r"\s+"
        )
        return df

    def _read_peakipy(self):
        import json
        with open(self.peaklist_path, 'r') as f:
            data = json.load(f)
            peaks = data.get("peaks", [])
            return pd.DataFrame(peaks)

    def _read_csv(self):
        """Load peaklist data from csv file.
        Detects separator automatically (comma or tab).
        """
        # Try comma first, then tab
        df = pd.read_csv(self.peaklist_path, sep=None, engine='python')
        df["INDEX"] = df.index
        # need to add LW estimate
        if not "XW_HZ" in df.columns:
            df["XW_HZ"] = 20.0
        if not "YW_HZ" in df.columns:
            df["YW_HZ"] = 20.0
        # dummy values
        if not "HEIGHT" in df.columns:
            df["HEIGHT"] = 0.0
        if not "VOL" in df.columns:
            df["VOL"] = 0.0
        return df

    def check_assignments(self):
        # self.df["ASS"] = self.df.
        self.df["ASS"] = self.df.ASS.astype(object)
        self.df.loc[self.df["ASS"].isnull(), "ASS"] = "None_dummy_0"
        self.df["ASS"] = self.df.ASS.astype(str)
        duplicates_bool = self.df.ASS.duplicated()
        duplicates = self.df.ASS[duplicates_bool]
        if len(duplicates) > 0:
            console.print(
                textwrap.dedent(
                    """
                #############################################################################
                    You have duplicated assignments in your list...
                    Currently each peak needs a unique assignment. Sorry about that buddy...
                #############################################################################
                """
                ),
                style="yellow",
            )
            self.df.loc[duplicates_bool, "ASS"] = [
                f"{i}_dummy_{num+1}" for num, i in enumerate(duplicates)
            ]
            if self.verbose:
                print("Here are the duplicates")
                print(duplicates)
                print(self.df.ASS)

            print(
                textwrap.dedent(
                    """
                    Creating dummy assignments for duplicates

                """
                )
            )

    def check_peak_bounds(self):
        columns_to_print = ["INDEX", "ASS", "X_AXIS", "Y_AXIS", "X_PPM", "Y_PPM"]
        
        # Initial check
        within_x = (self.df.X_PPM < self.f2_ppm_max) & (self.df.X_PPM > self.f2_ppm_min)
        within_y = (self.df.Y_PPM < self.f1_ppm_max) & (self.df.Y_PPM > self.f1_ppm_min)
        total_in = (within_x & within_y).sum()

        # Try swapping if poor coverage
        # If less than 20% of peaks are in, check if swapping helps significantly
        if total_in < len(self.df) * 0.2 and len(self.df) > 0:
            swapped_x = (self.df.Y_PPM < self.f2_ppm_max) & (self.df.Y_PPM > self.f2_ppm_min)
            swapped_x_y = (self.df.X_PPM < self.f1_ppm_max) & (self.df.X_PPM > self.f1_ppm_min)
            total_swapped = (swapped_x & swapped_x_y).sum()
            
            if total_swapped > total_in:
                print(f"DEBUG: Auto-detected transposed dimensions. Swapping X/Y. (Original in: {total_in}, Swapped in: {total_swapped})")
                
                # Swap PPM columns
                self.df["X_PPM"], self.df["Y_PPM"] = self.df["Y_PPM"].copy(), self.df["X_PPM"].copy()
                
                # Swap Hz linewidths if present
                if "XW_HZ" in self.df.columns and "YW_HZ" in self.df.columns:
                    self.df["XW_HZ"], self.df["YW_HZ"] = self.df["YW_HZ"].copy(), self.df["XW_HZ"].copy()
                
                # Recalculate derived point columns
                self.df["X_AXIS"] = self.df.X_PPM.apply(lambda x: self.uc_f2(x, "ppm"))
                self.df["Y_AXIS"] = self.df.Y_PPM.apply(lambda x: self.uc_f1(x, "ppm"))
                self.df["X_AXISf"] = self.df.X_PPM.apply(lambda x: self.uc_f2.f(x, "ppm"))
                self.df["Y_AXISf"] = self.df.Y_PPM.apply(lambda x: self.uc_f1.f(x, "ppm"))
                
                self.df["XW"] = self.df.XW_HZ.apply(lambda x: x * self.pt_per_hz_f2)
                self.df["YW"] = self.df.YW_HZ.apply(lambda x: x * self.pt_per_hz_f1)
                
                # Update within_x/y for filtering
                within_x, within_y = swapped_x, swapped_x_y

        if self.verbose:
             print(f"DEBUG: Final peaks within X: {within_x.sum()}, Peaks within Y: {within_y.sum()}")
             
        self.excluded = self.df[~(within_x & within_y)]
        self.df = self.df[within_x & within_y]
        if len(self.excluded) > 0:
            print(
                textwrap.dedent(
                    f"""[red]
                    #################################################################################

                    Excluding the following peaks as they are not within the spectrum which has shape

                    {self.data.shape}
                [/red]"""
                )
            )
            table_to_print = df_to_rich_table(
                self.excluded,
                title="Excluded",
                columns=columns_to_print,
                styles=["red" for i in columns_to_print],
            )
            print(table_to_print)
            print(
                "[red]#################################################################################[/red]"
            )

    def clusters(
        self,
        thres=None,
        struc_el: StrucEl = StrucEl.disk,
        struc_size=(3,),
        l_struc=None,
    ):
        """Find clusters of peaks

        :param thres: threshold for positive signals above which clusters are selected. If None then threshold_otsu is used
        :type thres: float

        :param struc_el: 'square'|'disk'|'rectangle'
            structuring element for binary_closing of thresholded data can be square, disc or rectangle
        :type struc_el: str

        :param struc_size: size/dimensions of structuring element
            for square and disk first element of tuple is used (for disk value corresponds to radius)
            for rectangle, tuple corresponds to (width,height).
        :type struc_size: tuple


        """
        if self.df.empty:
            raise ValueError("No peaks available for clustering. Likely all peaks were outside spectrum bounds.")

        peaks = [[y, x] for y, x in zip(self.df.Y_AXIS, self.df.X_AXIS)]

        if thres == None:
            thres = self.thres
            self._thres = abs(threshold_otsu(self.data[0]))
        else:
            self._thres = thres

        # get positive and negative
        thresh_data = np.bitwise_or(
            self.data[0] < (self._thres * -1.0), self.data[0] > self._thres
        )

        match struc_el:
            case struc_el.disk:
                radius = struc_size[0]
                if self.verbose:
                    print(f"using disk with {radius}")
                closed_data = binary_closing(thresh_data, disk(int(radius)))

            case struc_el.square:
                width = struc_size[0]
                if self.verbose:
                    print(f"using square with {width}")
                closed_data = binary_closing(thresh_data, footprint_rectangle((int(width),int(width))))

            case struc_el.rectangle:
                width, height = struc_size
                if self.verbose:
                    print(f"using rectangle with {width} and {height}")
                closed_data = binary_closing(
                    thresh_data, footprint_rectangle((int(width), int(height)))
                )

            case _:
                if self.verbose:
                    print(f"Not using any closing function")
                closed_data = thresh_data

        labeled_array, num_features = ndimage.label(closed_data, l_struc)

        # Map labels to peaks
        self.df["CLUSTID"] = [int(labeled_array[i[0], i[1]]) for i in peaks]
        
        #  renumber "0" clusters (masking background peaks as unique clusters)
        max_clustid = self.df["CLUSTID"].max()
        mask = self.df["CLUSTID"] == 0
        if int(mask.sum()) > 0:
            n_new = int(mask.sum())
            new_ids = np.arange(max_clustid + 1, n_new + max_clustid + 1, dtype=int)
            self.df.loc[mask, "CLUSTID"] = new_ids

        # count how many peaks per cluster
        self.df["MEMCNT"] = self.df.groupby("CLUSTID")["CLUSTID"].transform("count").astype(int)

        self.df["color"] = self.df.apply(
            lambda x: Category20[20][int(x.CLUSTID) % 20] if x.MEMCNT > 1 else "black",
            axis=1,
        )
        return ClustersResult(labeled_array, num_features, closed_data, peaks)

    def mask_method(self, overlap=1.0, l_struc=None):
        """connect clusters based on overlap of fitting masks

        :param overlap: fraction of mask for which overlaps are calculated
        :type overlap: float

        :returns ClusterResult: Instance of ClusterResult
        :rtype: ClustersResult
        """
        # overlap is positive
        overlap = abs(overlap)

        self._thres = threshold_otsu(self.data[0])

        mask = np.zeros(self.data[0].shape, dtype=bool)

        for ind, peak in self.df.iterrows():
            mask += make_mask(
                self.data[0],
                peak.X_AXISf,
                peak.Y_AXISf,
                peak.X_RADIUS * overlap,
                peak.Y_RADIUS * overlap,
            )

        peaks = [[y, x] for y, x in zip(self.df.Y_AXIS, self.df.X_AXIS)]
        labeled_array, num_features = ndimage.label(mask, l_struc)

        self.df.loc[:, "CLUSTID"] = [labeled_array[i[0], i[1]] for i in peaks]

        #  renumber "0" clusters
        max_clustid = self.df["CLUSTID"].max()
        n_of_zeros = len(self.df[self.df["CLUSTID"] == 0]["CLUSTID"])
        self.df.loc[self.df[self.df["CLUSTID"] == 0].index, "CLUSTID"] = np.arange(
            max_clustid + 1, n_of_zeros + max_clustid + 1, dtype=int
        )

        # count how many peaks per cluster
        for ind, group in self.df.groupby("CLUSTID"):
            self.df.loc[group.index, "MEMCNT"] = len(group)

        self.df.loc[:, "color"] = self.df.apply(
            lambda x: Category20[20][int(x.CLUSTID) % 20] if x.MEMCNT > 1 else "black",
            axis=1,
        )

        return ClustersResult(labeled_array, num_features, mask, peaks)

    def to_fuda(self):
        fname = self.peaklist_path.parent / "params.fuda"
        with open(self.peaklist_path.parent / "peaks.fuda", "w") as peaks_fuda:
            for ass, f1_ppm, f2_ppm in zip(self.df.ASS, self.df.Y_PPM, self.df.X_PPM):
                peaks_fuda.write(f"{ass}\t{f1_ppm:.3f}\t{f2_ppm:.3f}\n")
        groups = self.df.groupby("CLUSTID")
        fuda_params = Path(fname)
        overlap_peaks = ""

        for ind, group in groups:
            if len(group) > 1:
                overlap_peaks_str = ";".join(group.ASS)
                overlap_peaks += f"OVERLAP_PEAKS=({overlap_peaks_str})\n"

        fuda_file = textwrap.dedent(
            f"""\

# Read peaklist and spectrum info
PEAKLIST=peaks.fuda
SPECFILE={self.data_path}
PARAMETERFILE=(bruker;vclist)
ZCORR=ncyc
NOISE={self.thres} # you'll need to adjust this
BASELINE=N
VERBOSELEVEL=5
PRINTDATA=Y
LM=(MAXFEV=250;TOL=1e-5)
#Specify the default values. All values are in ppm:
DEF_LINEWIDTH_F1={self.f1_radius}
DEF_LINEWIDTH_F2={self.f2_radius}
DEF_RADIUS_F1={self.f1_radius}
DEF_RADIUS_F2={self.f2_radius}
SHAPE=GLORE
# OVERLAP PEAKS
{overlap_peaks}"""
        )
        with open(fuda_params, "w") as f:
            print(f"Writing FuDA file {fuda_file}")
            f.write(fuda_file)
        if self.verbose:
            print(overlap_peaks)


class ClustersResult:
    """Class to store results of clusters function"""

    def __init__(self, labeled_array, num_features, closed_data, peaks):
        self._labeled_array = labeled_array
        self._num_features = num_features
        self._closed_data = closed_data
        self._peaks = peaks

    @property
    def labeled_array(self):
        return self._labeled_array

    @property
    def num_features(self):
        return self._num_features

    @property
    def closed_data(self):
        return self._closed_data

    @property
    def peaks(self):
        return self._peaks


class LoadData(Peaklist):
    """Load peaklist data from peakipy .csv file output from either peakipy read or edit

    read_peaklist is redefined to just read a .csv file

    check_data_frame makes sure data frame is in good shape for setting up fits

    """

    def read_peaklist(self):
        if self.peaklist_path.suffix == ".csv":
            self.df = pd.read_csv(self.peaklist_path)  # , comment="#")

        elif self.peaklist_path.suffix == ".tab":
            self.df = pd.read_csv(self.peaklist_path, sep="\t")  # comment="#")

        else:
            self.df = pd.read_pickle(self.peaklist_path)

        self._thres = threshold_otsu(self.data[0])

        return self.df

    def validate_peaklist(self):
        self.df = pd.DataFrame(
            [
                PeaklistColumnsWithClusters(**i).model_dump()
                for i in self.df.to_dict(orient="records")
            ]
        )
        return self.df

    def check_data_frame(self):
        """
        Ensure the data frame has all required columns and add necessary derived columns for fitting.
        
        Returns
        -------
        pd.DataFrame
            The modified DataFrame after validation.
        """
        # make diameter columns
        if "X_DIAMETER_PPM" not in self.df.columns:
            self.df["X_DIAMETER_PPM"] = self.df["X_RADIUS_PPM"] * 2.0
            self.df["Y_DIAMETER_PPM"] = self.df["Y_RADIUS_PPM"] * 2.0

        #  make a column to track edited peaks
        if "Edited" in self.df.columns:
            pass
        else:
            self.df["Edited"] = np.zeros(len(self.df), dtype=bool)

        # create include column if it doesn't exist
        if "include" in self.df.columns:
            pass
        else:
            self.df["include"] = self.df.apply(lambda _: "yes", axis=1)

        # color clusters
        self.df["color"] = self.df.apply(
            lambda x: Category20[20][int(x.CLUSTID) % 20] if x.MEMCNT > 1 else "black",
            axis=1,
        )

        # get rid of unnamed columns
        unnamed_cols = [i for i in self.df.columns if "Unnamed:" in i]
        self.df = self.df.drop(columns=unnamed_cols)

    def update_df(self):
        """Slightly modified to retain previous configurations"""
        # Perform robust mapping first if columns are missing
        super().update_df()


def get_vclist(vclist, args):
    # read vclist
    if vclist is None:
        vclist = False
    elif vclist.exists():
        vclist_data = np.genfromtxt(vclist)
        args["vclist_data"] = vclist_data
        vclist = True
    else:
        raise Exception("vclist not found...")

    args["vclist"] = vclist
    return args
