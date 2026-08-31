from __future__ import annotations

from typing import Literal

import numpy as np
from numpy.linalg import matrix_power
from pydantic import Field, computed_field

from chemex.configuration.base import ExperimentConfiguration, ToBeFitted
from chemex.configuration.conditions import ConditionsWithValidations
from chemex.configuration.data import RelaxationDataSettings
from chemex.configuration.experiment import CpmgSettingsEvenNcycs
from chemex.configuration.types import ChemicalShift, Delay, PulseWidth
from chemex.containers.data import Data
from chemex.containers.dataset import load_relaxation_dataset
from chemex.experiments.factories import Creators, factories
from chemex.filterers import PlanesFilterer
from chemex.nmr.basis import Basis
from chemex.nmr.spectrometer import Spectrometer
from chemex.parameters.spin_system import SpinSystem
from chemex.plotters.cpmg import CpmgPlotter
from chemex.printers.data import CpmgPrinter
from chemex.typing import Array

EXPERIMENT_NAME = "cpmg_15n_rc"

# Phase indices of the CPMG refocusing pulses, in the order they appear in the
# Bruker pulse program. Index 0/1/2/3 corresponds to x/y/-x/-y, matching the
# Bruker phase programs ph20/ph21/ph22/ph23 used inside the CPMG loops.
_BLOCK1_CYCLE = (1, 1, 0, 2)  # ph21 ph21 ph20 ph22, loop 6
_BLOCK1_REMAINDER = (1, 1)  # ph21 ph21, loop 7
_BLOCK2_CYCLE = (0, 0, 1, 3)  # ph20 ph20 ph21 ph23, loop 8
_BLOCK2_REMAINDER = (0, 0)  # ph20 ph20, loop 9


class Cpmg15NRcSettings(CpmgSettingsEvenNcycs):
    """Settings for the relaxation-compensated 15N CPMG experiment.

    Corresponds to the Bruker 'hsqcrexetf3gpsitc3d' pulse program: two CPMG
    blocks of equal duration separated by a central P-element that
    interconverts anti-phase and in-phase 15N magnetization, so that the
    measured rate is the average of the two irrespective of the CPMG frequency.

    References:
        D. Long, M. Liu & D. Yang. J. Am. Chem. Soc. 130, 2432-2433 (2008).
        T. Yuwen & L. E. Kay. J. Biomol. NMR 73, 641-650 (2019).

    """

    name: Literal["cpmg_15n_rc"]
    time_t2: Delay = Field(
        description="Total CPMG relaxation delay, d20 in the pulse program (s)",
    )
    carrier: ChemicalShift = Field(description="15N carrier position (ppm)")
    pw90: PulseWidth = Field(
        description=(
            "15N 90-degree pulse width at the CPMG power level pl23, i.e. "
            "half of p30 (s)"
        ),
    )
    ncyc_max: int = Field(
        gt=0,
        description=(
            "Largest ncyc of the vdlist, equal to RF_max * time_t2. Sets the "
            "length of the R1 compensation delay"
        ),
    )
    taub: Delay = Field(
        default=2.68e-3,
        description="1/(4 J_NH) delay of the P-element, d25 in the pulse program (s)",
    )

    @property
    def pw180(self) -> float:
        """Width of the CPMG refocusing pulse, p30 in the pulse program."""
        return 2.0 * self.pw90

    @property
    def primary_observed_state(self) -> str:
        """First observed state.

        Written without the `suffix_detect` / `get_detection_expression`
        helpers so that the module works both before and after the multi-state
        detection refactor: `observed_state` is a plain string in older ChemEx
        releases and may be a tuple of states in newer ones.
        """
        state = self.observed_state
        return state if isinstance(state, str) else state[0]

    @computed_field
    @property
    def start_terms(self) -> list[str]:
        """The refocused INEPT delivers anti-phase longitudinal magnetization.

        The 15N magnetization is built from equilibrium 1H polarization and no
        chemical shift evolution precedes the CPMG blocks, so all states start
        at their equilibrium populations.
        """
        return ["2izsz"]

    @computed_field
    @property
    def detection(self) -> str:
        """The final 15N 90-degree pulse stores in-phase magnetization along z."""
        return f"[iz_{self.primary_observed_state}]"


class Cpmg15NRcConfig(
    ExperimentConfiguration[
        Cpmg15NRcSettings,
        ConditionsWithValidations,
        RelaxationDataSettings,
    ],
):
    @property
    def to_be_fitted(self) -> ToBeFitted:
        state = self.experiment.primary_observed_state
        return ToBeFitted(rates=[f"r2_i_{state}"], model_free=[f"tauc_{state}"])


def build_spectrometer(
    config: Cpmg15NRcConfig,
    spin_system: SpinSystem,
) -> Spectrometer:
    settings = config.experiment
    conditions = config.conditions

    # The anti-phase block and the J evolution during the CPMG trains require
    # the two-spin longitudinal basis.
    basis = Basis(type="ixyzsz", spin_system="nh", model=config.model)
    spectrometer = Spectrometer.from_spin_system(spin_system, basis, conditions)

    spectrometer.carrier_i = settings.carrier
    spectrometer.b1_i = 1.0 / (4.0 * settings.pw90)
    spectrometer.detection = settings.detection

    return spectrometer


class Cpmg15NRcSequence:
    """Sequence for the relaxation-compensated 15N CPMG experiment."""

    def __init__(self, settings: Cpmg15NRcSettings) -> None:
        self.settings = settings

    @staticmethod
    def effective_ncyc(ncyc: float) -> int:
        """Round ncyc down to the even value the spectrometer actually used.

        The pulse program computes COUNTER0 = trunc(d20 * nu_cpmg / 2) and then
        recomputes the CPMG frequency from it as d31 = 2 * COUNTER0 / d20. Both
        the inter-pulse delay DELTA3 and the pulse count therefore derive from
        the rounded frequency, and an odd ncyc loses one pulse pair. Valid
        vdlist entries are multiples of 2/d20, so this rounding is a no-op for
        a correctly acquired series.
        """
        return 2 * (int(ncyc) // 2)

    def _get_delays(
        self,
        ncycs: Array,
    ) -> tuple[dict[float, float], dict[float, float], list[float]]:
        settings = self.settings

        # DELTA3 = 1 / (4 nu_cpmg) - 3 p30 / 8, with nu_cpmg = ncyc / time_t2
        # evaluated at the rounded frequency the pulse program derives.
        tau_cps = {
            ncyc: settings.time_t2 / (4.0 * self.effective_ncyc(ncyc))
            - 0.375 * settings.pw180
            for ncyc in ncycs
            if self.effective_ncyc(ncyc) > 0
        }

        # DELTA9 = (RF_max - nu_cpmg) * time_t2 * p30 / 4, applied once before
        # the first block and once after the second one. Half of the refocusing
        # pulses are perpendicular to the magnetization, so this equalizes the
        # time spent along z across the whole vdlist (Yuwen & Kay, Fig. 3).
        deltas = {
            ncyc: 0.25
            * (settings.ncyc_max - self.effective_ncyc(ncyc))
            * settings.pw180
            for ncyc in ncycs
        }

        delays = [settings.taub, *tau_cps.values(), *deltas.values()]

        return tau_cps, deltas, delays

    def calculate(self, spectrometer: Spectrometer, data: Data) -> Array:
        ncycs = data.metadata
        settings = self.settings

        # Calculation of the propagators corresponding to all the delays
        tau_cps, deltas, all_delays = self._get_delays(ncycs)
        delays = dict(zip(all_delays, spectrometer.delays(all_delays), strict=True))
        d_taub = delays[settings.taub]
        d_cp = {ncyc: delays[delay] for ncyc, delay in tau_cps.items()}
        d_delta9 = {ncyc: delays[delay] for ncyc, delay in deltas.items()}

        # Calculation of the propagators corresponding to all the pulses
        p90 = spectrometer.p90_i
        p180 = spectrometer.p180_i
        perfect180_i = spectrometer.perfect180_i[0]
        perfect180_s = spectrometer.perfect180_s[0]

        # P-element: 1/(4J) - (1H, 15N) 180 - 1/(4J), which converts the
        # anti-phase magnetization of the first block into in-phase
        # magnetization for the second one.
        p_element = d_taub @ perfect180_s @ perfect180_i @ d_taub

        # Getting the starting magnetization
        start = spectrometer.get_start_magnetization(settings.start_terms)

        # Calculating the intensities as a function of ncyc
        intensities: dict[float, float] = {}

        for ncyc in set(ncycs):
            d9 = d_delta9[ncyc]
            magnetization = p90[0] @ d9 @ start

            if self.effective_ncyc(ncyc) > 0:
                echoes = [d_cp[ncyc] @ p180[phase] @ d_cp[ncyc] for phase in range(4)]
                counter0 = self.effective_ncyc(ncyc) // 2
                counter1, counter2 = divmod(counter0, 2)
                block1 = matrix_power(
                    _element(echoes, _BLOCK1_REMAINDER),
                    counter2,
                ) @ matrix_power(_element(echoes, _BLOCK1_CYCLE), counter1)
                block2 = matrix_power(
                    _element(echoes, _BLOCK2_REMAINDER),
                    counter2,
                ) @ matrix_power(_element(echoes, _BLOCK2_CYCLE), counter1)
                magnetization = block2 @ p_element @ block1 @ magnetization
            else:
                magnetization = p_element @ magnetization

            intensities[ncyc] = spectrometer.detect(d9 @ p90[1] @ magnetization)

        # Return profile
        return np.array([intensities[ncyc] for ncyc in ncycs])

    @staticmethod
    def is_reference(metadata: Array) -> Array:
        return metadata == 0


def _element(echoes: list[Array], phases: tuple[int, ...]) -> Array:
    """Chain spin echoes applied in the given order of Bruker phases."""
    propagator = echoes[phases[0]]
    for phase in phases[1:]:
        propagator = echoes[phase] @ propagator
    return propagator


def register() -> None:
    creators = Creators(
        config_creator=Cpmg15NRcConfig,
        spectrometer_creator=build_spectrometer,
        sequence_creator=Cpmg15NRcSequence,
        dataset_creator=load_relaxation_dataset,
        filterer_creator=PlanesFilterer,
        printer_creator=CpmgPrinter,
        plotter_creator=CpmgPlotter,
    )
    factories.register(name=EXPERIMENT_NAME, creators=creators)
