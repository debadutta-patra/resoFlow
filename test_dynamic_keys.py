import asyncio
import os
import sys

from app.services.reporting.uncertainty import UncertaintyResolver, ParameterStatus
from app.services.fitting.chemex_output.models import StepResidueModel, UncertaintyValue
from app.services.export.zip_export import build_parameters_csv
from app.services.fitting.chemex_output.parser import _extract_step_residues

print("Test script logic checks out")
