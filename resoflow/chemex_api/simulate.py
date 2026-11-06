"""Direct library entry point for running ChemEx simulations."""

from __future__ import annotations

import contextlib
from pathlib import Path

from chemex.configuration.method_plan import ConstrainAction, FitAction, FixAction, MethodPlan
from chemex.configuration.methods import Method
from chemex.optimize.helper import execute_simulation

from .session import build_session
from .spec import FitJobSpec


def _extract_method(plan: MethodPlan | None) -> Method:
    if not plan or not plan.steps:
        return Method()
    step = plan.steps[0]
    constraints: list[str] = []
    fix: list[str] = []
    fit: list[str] = []
    for action in step.role_actions:
        if isinstance(action, ConstrainAction):
            constraints.extend(c.render() for c in action.constraints)
        elif isinstance(action, FixAction):
            fix.extend(s.render() for s in action.selectors)
        elif isinstance(action, FitAction):
            fit.extend(s.render() for s in action.selectors)
    return Method(constraints=constraints, fix=fix, fit=fit)


def run_simulation(spec: FitJobSpec, job_dir: Path | None = None) -> None:
    """Execute a ChemEx simulation matching chemex.chemex.run_sim, respecting method constraints if provided."""
    base_dir = Path(job_dir).resolve() if job_dir is not None else Path.cwd()
    with contextlib.chdir(base_dir):
        session, experiments, plan, args_ns, _, _ = build_session(
            spec, job_dir=base_dir, command="simulate"
        )
        method = _extract_method(plan)
        parameter_model = session.parameter_factory.sealed_parameter_model
        if parameter_model is None:
            raise RuntimeError("Native parameter model is unavailable")
        snapshot = session.analysis_values.snapshot()
        parameterization = session.compile_parameterization(method, experiments.param_ids)
        resolved_values = parameterization.resolve(
            parameterization.frame_from_snapshot(snapshot)
        )
        execute_simulation(
            experiments,
            args_ns.output,
            parameter_values=resolved_values,
            parameter_model=parameter_model,
            parameterization=parameterization,
            plot=(args_ns.plot == "normal"),
        )
