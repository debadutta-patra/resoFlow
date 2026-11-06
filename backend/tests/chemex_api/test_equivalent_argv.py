"""Tests asserting that FitJobSpec.equivalent_argv produces a valid ChemEx CLI Namespace."""

from pathlib import Path
from chemex.cli import build_parser
from resoflow.chemex_api.spec import FitJobSpec, ExecutionSpec


def test_equivalent_argv_parses_to_expected_namespace():
    spec = FitJobSpec(
        experiment_files=["Experiments/800mhz.toml"],
        parameter_files=["Parameters/parameters.toml"],
        method_files=["Methods/method.toml"],
        model="2st",
        include=["2N", "3N"],
        exclude=["4N"],
        output_dir="CustomOutput",
        plot="all",
        execution=ExecutionSpec(workers=4, native_threads=2),
    )

    argv = spec.equivalent_argv(command="fit")
    assert argv[0] == "chemex"
    assert argv[1] == "fit"

    parser = build_parser()
    ns = parser.parse_args(argv[1:])

    assert ns.commands == "fit"
    assert ns.analysis_command is True
    assert ns.experiments == [Path("Experiments/800mhz.toml")]
    assert ns.parameters == [Path("Parameters/parameters.toml")]
    assert ns.method == [Path("Methods/method.toml")]
    assert ns.model == "2st"
    assert ns.output == Path("CustomOutput")
    assert ns.plot == "all"
    assert len(ns.include) == 2
    assert [str(s) for s in ns.include] == ["2N", "3N"]
    assert len(ns.exclude) == 1
    assert [str(s) for s in ns.exclude] == ["4N"]
    assert ns.workers == 4
    assert ns.native_threads == 2
