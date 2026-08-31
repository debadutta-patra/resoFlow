import pytest
from app.services.fitting.spin_system import (
    SpinSystemKey,
    sort_spin_keys,
    resolve_numeric_range,
    match_spin_key_sets,
)

def test_parse_single_spin_keys():
    k1 = SpinSystemKey.parse("G2N")
    assert k1.res_num == 2
    assert k1.symbol == "G"
    assert k1.spins == ("N",)
    assert k1.canonical == "G2N"
    assert k1.short == "2N"

    k2 = SpinSystemKey.parse("14N")
    assert k2.res_num == 14
    assert k2.symbol == ""
    assert k2.spins == ("N",)
    assert k2.canonical == "14N"
    assert k2.short == "14N"

    k3 = SpinSystemKey.parse("GLY14N")
    assert k3.res_num == 14
    assert k3.symbol == "G"
    assert k3.spins == ("N",)
    assert k3.canonical == "G14N"

    k4 = SpinSystemKey.parse("40ASN")
    assert k4.res_num == 40
    assert k4.symbol == "N"
    assert k4.spins == ("N",)
    assert k4.short == "40N"
    assert k4.canonical == "N40N"

    k5 = SpinSystemKey.parse("71LYS")
    assert k5.res_num == 71
    assert k5.symbol == "K"
    assert k5.spins == ("N",)
    assert k5.short == "71N"
    assert k5.canonical == "K71N"

def test_parse_two_spin_keys():
    # 15N-1H TROSY
    k1 = SpinSystemKey.parse("G2N-HN")
    assert k1.res_num == 2
    assert k1.symbol == "G"
    assert k1.spins == ("N", "HN")
    assert k1.canonical == "G2N-HN"
    assert k1.short == "2N-HN"

    # 1H-15N IP/AP
    k2 = SpinSystemKey.parse("G2HN-N")
    assert k2.res_num == 2
    assert k2.symbol == "G"
    assert k2.spins == ("HN", "N")
    assert k2.canonical == "G2HN-N"
    assert k2.short == "2HN-N"

def test_parse_methyl_keys():
    k1 = SpinSystemKey.parse("L3CD1-HD1")
    assert k1.res_num == 3
    assert k1.symbol == "L"
    assert k1.spins == ("CD1", "HD1")
    assert k1.canonical == "L3CD1-HD1"
    assert k1.short == "3CD1-HD1"

    k2 = SpinSystemKey.parse("LEU3CD1-HD1")
    assert k2.res_num == 3
    assert k2.symbol == "L"
    assert k2.spins == ("CD1", "HD1")
    assert k2.canonical == "L3CD1-HD1"

def test_sort_spin_keys():
    raw_keys = ["G14N", "G2N", "L3CD1-HD1", "102N", "25N-HN"]
    sorted_keys = sort_spin_keys(raw_keys)
    assert sorted_keys == ["G2N", "L3CD1-HD1", "G14N", "25N-HN", "102N"]

def test_resolve_numeric_range():
    available = ["G2N", "L3CD1-HD1", "G14N", "15N", "25N-HN", "40N", "42N", "44N", "50N"]
    matched, unrecognized = resolve_numeric_range("2, 14-15, 40-44", available)
    assert matched == ["G2N", "G14N", "15N", "40N", "42N", "44N"]
    assert unrecognized == []

def test_match_spin_key_sets():
    source = ["G2N", "L3N", "14N", "G25N"]
    target = ["2N-HN", "L3CD1-HD1", "GLY14N-HN", "99N"]
    res = match_spin_key_sets(source, target)
    assert len(res["matched"]) == 3
    assert res["unmatched_source"] == ["G25N"]
    assert res["unmatched_target"] == ["99N"]
