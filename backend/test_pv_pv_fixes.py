import pandas as pd
import numpy as np
from app.services.fitting.io import Peaklist, PeaklistFormat, PeaklistColumns

# Mock udic for testing
mock_udic = {
    0: {"size": 256, "sw": 5000.0, "obs": 150.0}, # Planes
    1: {"size": 256, "sw": 5000.0, "obs": 150.0}, # F1 (Indirect)
    2: {"size": 1024, "sw": 10000.0, "obs": 600.0}, # F2 (Direct)
}

def test_radius_fallback():
    # Create a dummy dataframe with missing linewidths but present radii
    df = pd.DataFrame({
        "INDEX": [1, 2],
        "X_PPM": [1.0, 2.0],
        "Y_PPM": [120.0, 122.0],
        "X_RADIUS_PPM": [0.04, 0.08],
        "Y_RADIUS_PPM": [0.25, 0.5],
        "ASS": ["11GLN", "25TYR"],
        "include": ["yes", "yes"]
    })
    
    class MockPeaklist(Peaklist):
        def __init__(self, df):
            self._df = df
            self.fmt = PeaklistFormat.pipe
            self._dims = [0, 1, 2]
            self._planes_dim = 0
            self._f1_dim = 1
            self._f2_dim = 2
            self._udic = mock_udic
            self._radii = [0.1, 0.1]
            self.excluded = pd.DataFrame()

    peaklist = MockPeaklist(df)
    peaklist.update_df()
    
    # Check XW_HZ and YW_HZ
    # XW_HZ = radius * obs = 0.04 * 600 = 24.0
    # YW_HZ = radius * obs = 0.25 * 150 = 37.5
    
    print(f"Row 1 XW_HZ: {peaklist.df.iloc[0].XW_HZ} (Expected 24.0)")
    print(f"Row 1 YW_HZ: {peaklist.df.iloc[0].YW_HZ} (Expected 37.5)")
    
    assert np.isclose(peaklist.df.iloc[0].XW_HZ, 24.0)
    assert np.isclose(peaklist.df.iloc[0].YW_HZ, 37.5)
    assert np.isclose(peaklist.df.iloc[1].XW_HZ, 48.0)
    assert np.isclose(peaklist.df.iloc[1].YW_HZ, 75.0)
    
    print("Radius fallback verification passed!")

def test_parameter_persistence():
    # Verify that PeaklistColumns accepts and preserves the new fields
    data = {
        "INDEX": 1,
        "X_AXIS": 10, "Y_AXIS": 20, "X_AXISf": 10.5, "Y_AXISf": 20.5,
        "X_PPM": 1.0, "Y_PPM": 120.0, "XW": 2.0, "YW": 3.0, "XW_HZ": 20.0, "YW_HZ": 30.0,
        "HEIGHT": 1000.0, "VOL": 5000.0, "ASS": "11GLN",
        "X_RADIUS": 5.0, "Y_RADIUS": 10.0, "X_RADIUS_PPM": 0.04, "Y_RADIUS_PPM": 0.25,
        "include": "yes",
        "lineshape": "PV_PV",
        "fraction_x": 0.7,
        "fraction_y": 0.3
    }
    col = PeaklistColumns(**data)
    dumped = col.model_dump()
    assert dumped["lineshape"] == "PV_PV"
    assert dumped["fraction_x"] == 0.7
    assert dumped["fraction_y"] == 0.3
    print("Parameter persistence verification passed!")

if __name__ == "__main__":
    test_radius_fallback()
    test_parameter_persistence()
