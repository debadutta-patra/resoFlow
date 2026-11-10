# Parameters tab ↔ ChemEx 2026.09 parameter-file semantics

**Branch:** `feat/chemex-2026.9-library` · **ChemEx:** `2026.9.2` (installed in `backend/.venv`, verified `chemex.__version__`)
**Status:** approved 2026-11-10. Decisions: Q1, Q2, Q4, Q5 as recommended. **Q3 changed:** new configs start from ChemEx defaults (no resoFlow-invented globals are pre-filled). Saved configs whose globals still carry `source: default` (never touched by a user) drop them on load with a one-time notice, so ChemEx defaults apply. CPMG/EXCHANGE get a validation warning plus a quick-fix when `DW_AB` starts at ChemEx's 0 everywhere, because Rex has zero gradient there.
**Scope:** items 1–12 from the brief. Item 13 (layered `-p` files) is future work only (§7).

---

## 0. What I verified in the installed library (and how)

All rows marked ✅ were read from source in `site-packages/chemex` **and** confirmed by calling the code (probe scripts in the session scratchpad). Rows marked 📖 come from source reading only and get a test during implementation.

### 0.1 Parameter-file value forms

| Fact | Where | |
|---|---|---|
| A value is `list[float]` of length **1–4**; a scalar is wrapped to `[x]` (`ensure_list`). | `configuration/parameters.py::ValuesType` | ✅ |
| The list maps to `DefaultSetting(value, min, max, brute_step)`, so a **4th element (brute step) is valid ChemEx**. The docs don't mention it. | `configuration/parameters.py::DefaultSetting` | ✅ |
| `ParamSetting.set()` replaces `min`/`max` **only when not None**. `[v, lo]` changes only the lower bound; the upper keeps ChemEx's default. | `parameters/setting.py::ParamSetting.set` | ✅ |
| Applying any default **clears the parameter's `expr`**. So `R2_B = …` in the file unbinds `R2_B` from `R2_A`. | `parameters/database.py::ParameterDatabase.set_defaults` | ✅ |
| `run_info/parameters_used.toml` is ChemEx's dump of the *effective* starting independent parameters as `[value, min, max(, step)]`, so user bounds and ChemEx defaults both land there. | fixture + `provenance.py::parse_parameters_used_toml` | ✅ |

### 0.2 `[GLOBAL]` vs per-parameter precedence (item 5)

`ParameterDatabase.set_defaults` walks `reversed(defaults)` and removes each parameter id from the pool the first time it matches. **So the last matching entry in file order wins, not the most specific one.** `build_default_list` keeps TOML section order.

- resoFlow writes `[GLOBAL]` first, so per-residue sections (`[DW_AB]`, `[R2_A]`, …) override the blanket value. CPMG relies on this today with `[GLOBAL] DW_AB = 2.0`; ChemEx's own `CPMG_15N_IP` example does the same.
- A hand-edited or imported file with `[GLOBAL]` **after** a per-residue section would make the global win everywhere.

📖 This is from source reading. Item 5 adds a real-fit backend test that proves it in both orders before the rule goes into the UI help text.

### 0.3 Default values and bounds (ChemEx 2026.9.2)

Probed via `model_factory.create(name, Conditions(...))` for kinetic parameters and `parameters.spins.build_spin_param_settings(Basis, Conditions)` for spin-level parameters. ✅

| Parameter | Default | Bounds | Default role | Notes |
|---|---|---|---|---|
| `PB` (2st) | 0.05 | [0, 1] | fit | the n-state family (`3st`, `4st`, …) uses 0.02 for every `P*` |
| `PC` (3st) | 0.02 | [0, 1] | fit | |
| `KEX_*` | 200 | [0, 1e6] | fit | resoFlow currently writes 500 |
| `PA`, `KAB`, `KBA`, … | — | — | derived (expr) | `pair_rates`: k_ij = kex_ij · p_j / (p_i + p_j) |
| `TAUC_A` | 4.0 | [0, 1000] | fix | |
| `CS_A` | **0.0** | [−100, 300] | fix | 0 ppm is a poor start, which is why item 3 matters |
| `DW_AB`, `DW_AC`, … | 0.0 | [−100, 100] | fit | |
| `R1_A` | 1.5 | [0, 1000] | fix | |
| `R2_A` | 10.0 | [0, 1000] | fix | |
| `R1_B`/`R2_B` | — | — | `= [R1_A]` / `= [R2_A]` | |
| `.tc`: `TREF` | 25 | none (protected) | model-owned | must be one scalar in `[GLOBAL]`; bounds or step raise `TemperatureReferenceConfigurationError` |
| `.tc`: `CS0_A` | 0 | [−100, 300] | fix | `CS_A` becomes model-owned `CS0_A + (T − TREF)·CS1_A` |
| `.tc`: `CS1_A` | 0 | [−1, 1] | fix | |
| `.tc`: `DW0_AX` | 0 | [−100, 100] | fit | |
| `.tc`: `DW1_AX` | 0 | [−1, 1] | fit | |
| Binding models | e.g. `KD` 1e-3 [≈0, 1], `KOFF` 100 [0, 1e6] | | | no `PB`/`KEX_AB` globals at all |

`DWP_*`/`DWM_*` are rejected (`ObsoleteTemperatureShiftParameterError`, which carries the conversion formula). ✅

### 0.4 How to obtain defaults and bounds: recommendation

ChemEx has **no public "list defaults" API**, but the data sits in two stable, module-level registries:

1. **Kinetic/global:** `chemex.models.factory.model_factory.create(name, Conditions)` after `ensure_plugins_registered()`. Model names come from `ModelSpec.from_name("2st.tc")`.
2. **Spin-level:** `chemex.parameters.spins.create_base_param_settings(Basis(type, ModelSpec, "", spin_system), state, Conditions)`. I'll use the *unselected* settings so `TAUC_A`, `S2`, etc. are included regardless of basis.

**Proposal:** add `resoflow/chemex_api/defaults.py::parameter_defaults(model) -> list[ParamDefault]`, an in-process function with `lru_cache`.

- **Representative inputs:** `Conditions(temperature=25, h_larmor_frq=600, p_total=1e-3, l_total=1e-3, d2o=0.1)`.
- **Conditions-dependent models:** `_hd`, `_eyring` and binding models are marked `condition_dependent: true` so the UI can say "default shown for 25 °C / 600 MHz".
- **Symbols:** register `model_factory`, `create_base_param_settings`, `Basis` and `ModelSpec.from_name` in `resoflow/chemex_api/compat.py`, so a ChemEx upgrade that moves them fails loudly at import, as the other hook points already do.
- **Fallback:** if introspection raises, return a small hand-written table (today's values, corrected) and log a warning. The endpoint never 500s.

Why not `inspect_parameters` (per-analysis, exact)? It needs generated experiments (CEST fails before generation) and it reports *effective* values, not defaults. It stays the per-concrete-parameter truth in the Methods tab. For the Parameters tab, the model-level table is enough, because defaults depend on the model and parameter name, not on residue.

---

## 1. Existing defects found while reading (fixed as part of the items noted)

| # | Defect | Fixed in |
|---|---|---|
| D1 | `tomlToConfig` keeps only `[0]` of a list, so **bounds are lost on every import/raw-apply**. | 1 |
| D2 | `param_catalog.py` covers only 2st/3st, using `"3" in model`. Binding, Eyring, HD, 4–6st and `.tc` all get the wrong set. 2st PB is glossed as "0 – 0.5" with `default_bounds '< 0.5'`. | 2 |
| D3 | `_load_starting_bounds` keys per-residue entries by bare residue (`bounds["13N"]`), so `[CS_A] 13N` and `[DW_AB] 13N` overwrite each other. Its `config.json` fallback reads `parameter_config.<k>.min`, a shape that never exists. | 1 |
| D4 | `cpmgTomlToConfig` silently takes `abs()` of every imported `DW_*`. This breaks lossless round-trip and contradicts "negative accepted everywhere". | 6 (see Q2) |
| D5 | Residue table `methodTreatmentMap` reads legacy `step.parameters[].mode` and ignores v2 `roleRules` and resolved roles. | 7 |
| D6 | Unknown `[GLOBAL]` keys (e.g. `UNKNOWN_FLAG = true`) go to `unparsed` and are **dropped on the next export** unless the user stays in raw mode. | 1 (unparsed lines get a visible "will be dropped" count; behaviour otherwise unchanged) |
| D7 | Excluded-residue badge text says "commented out in parameters.toml". | 4 |
| D8 | ChemEx's own `CEST_15N` example triggers 7 DW warnings (|DW| > 6 ppm on 7/16 residues, e.g. 43N = 12.5). | 6 |

---

## 2. Decisions I need from you (recommendation first)

- **Q1. A 4-element list `[v, lo, hi, step]`:** valid ChemEx, not in the docs.
  - **Recommended:** parse it and keep `step` as an opaque `bruteStep` field that round-trips, with no UI.
  - Alternative: send it to `unparsed` as the brief says. That would silently lose the line on export.
- **Q2. CPMG `abs()` on DW import (D4):**
  - **Recommended:** remove it. Values pass through unchanged, and an info note says CPMG is sign-insensitive.
  - Alternative: keep `abs()` but report "N signs flipped" in the import modal.
- **Q3. resoFlow's own starting values** (`PB 0.05`, `KEX_AB 500`, `TAUC_A 4`; CPMG adds `DW_AB 2.0`), written today with source `default`:
  - **Recommended:** keep writing them, so existing projects don't change numbers. Rename that badge to **"resoFlow start"**. A field the user clears (item 8) is removed from the file, falls back to ChemEx, and shows **"ChemEx default"**.
  - Alternative: stop pre-filling new configs, so ChemEx defaults apply (KEX 200).
- **Q4. Legacy commented lines in a *foreign* import (item 4):**
  - **Recommended:** auto-migrate them to exclusions only when the file has resoFlow's `# Auto-generated ChemEx parameter file` header, or comes from a saved config. For other files, the import modal shows "N commented residue lines: treat as exclusions?" with a checkbox, default **off**.
- **Q5. Only one bound set:** ChemEx keeps its default for the missing side (§0.1).
  - **Recommended:** always write the full 3-element form, filling the missing side from the catalogue default. This makes the file explicit and makes the MCMC prior support visible.
  - If the catalogue has no default for that parameter, validation blocks with "set both bounds".

---

## 3. Phase 1 (P0): correctness, one commit per item

### Item 1: round-trip bounds · `feat(parameters): round-trip [init, lower, upper] bounds`

**Model** (`lib/parameterConfig.ts`):
- `ParamValue` gains `lower?: number`, `upper?: number` and `bruteStep?: number` (Q1).
- `canonicalizeParameterConfig` and CPMG canonicalisation carry the new fields untouched. The merge already spreads `ParamValue`, so I'll add a test for it.

**Codec** (`lib/parameterToml.ts`):
- **Parsing:** a new pure `parseChemexValue(raw): {value, lower?, upper?, bruteStep?} | null` reads the scalar or a list of 1–4 finite numbers, plus TOML `inf`/`-inf`/`nan` tokens (`parameters_used.toml` writes `-inf, inf`).
  - `±inf` bounds are read as "unset".
  - Anything else is malformed and goes to `unparsed`: non-numeric items, a length of 0 or more than 4, `lower ≥ upper`, or a non-list.
- **Writing:**
  - A list is written only when `lower` or `upper` is set. The missing side is filled from the catalogue (Q5), so `configToToml` takes an optional `defaults` lookup; the codec signature gains an optional second argument and stays backward compatible.
  - Unit conversion is applied with `unitDef.toChemEx` to value, lower and upper.
  - Formatting goes through one `formatChemexNumber(unitDef, x)` helper for value and bounds.
- **TREF:** never written with bounds (§0.3). If a TREF bound is present, validation errors and the writer drops the bounds.

**Tests** (`parameterToml.test.ts`):
- Replace `'correctly handles list syntax from ChemEx parameter files'` with:
  - a globals round-trip (`PB = [0.02, 0.0, 0.5]`, `KEX_AB = [150, 10, 2000]`)
  - a per-residue round-trip (`[CS_A] 13N = [108.2, 100, 120]`, `[DW_AB] 55N = [-6.5, -15, 0]`)
  - a scalar staying scalar
  - single-sided fill
  - the 4-element step (Q1)
  - `-inf/inf` → unset
  - malformed cases → `unparsed`
- **Docs-example fixture:** `frontend/src/lib/__fixtures__/chemex_cest_15n_parameters.toml` is ChemEx `examples/Experiments/CEST_15N/Parameters/parameters.toml` at tag `2026.09.2`, the file the docs page shows. I add `PB = [0.015, 0.0, 0.2]` and `KEX_AB = [70.0, 1.0, 1000.0]`. The test runs import → export → import and asserts that the numeric content is equal (all keys, values, bounds) and that `unparsed` is empty.
- **Backend twin:** `tests/test_parameter_roundtrip.py` checks that the frontend-exported text loads through `chemex.configuration.parameters.read_defaults` with identical `DefaultSetting`s. The frontend output is checked in as a golden file and refreshed by a vitest snapshot, so the two can't drift silently.

**UI:**
- `GlobalParametersCard`: a collapsible "Bounds" row per field (chevron), holding lower/upper inputs whose placeholders show the effective ChemEx default (e.g. `0` / `1`). A small "custom bounds" dot appears when either is set.
- `ResidueParametersTable` expander: lower/upper pairs for CS_A, DW_AB, R1_A and R2_A, with the same placeholders.
- `.tc` `TREF`: no bounds row.

**Validation** (`parameterValidation.ts` and tests):
- `start-outside-bounds` (warning, per global or residue param): checked against *effective* bounds (user bound, else ChemEx default). This also catches today's silent case of `CS_A = 0`.
- `bounds-inverted` (warning): lower ≥ upper. The parser already rejects this on import; this covers the UI.
- `mcmc-default-bounds` (info): for any step with `statistics.mcmc.enabled`, list the parameters that are fit in that step and have no explicit bounds, with the text "MCMC samples a uniform prior over the effective bounds; these still use ChemEx's safety bounds." Fit roles come from resolved roles when they're available, else from the table mode.
- `ValidationOptions` gains `defaults?: ParamDefaultsLookup` and `resolvedRoles?`.

**Uncertainty** (`reporting/uncertainty.py`, D3):
- Key bounds as `GLOBAL/<NAME>` and `<SECTION>/<RES>`, and look them up by (name, residue scope).
- The `config.json` fallback reads `parameter_config.globals[k].{lower,upper}` and `residues[r][k].{lower,upper}` (legacy `min/max` still accepted).
- Primary source stays `parameters_used.toml` (§0.1).
- Tests: two sections sharing residue `13N` with different bounds; at-bound flagging fires for a user upper bound.

**CEST / CPMG / EXCHANGE check:** the shared codec and card. The CPMG codec wraps the shared one, so it gets bounds for free; a test runs through `configToCpmgToml`.

### Item 2: backend catalogue · `fix(catalog): derive parameter catalogue from ChemEx defaults`

- New `resoflow/chemex_api/defaults.py` (§0.4).
- `param_catalog.get_method_parameter_catalog(model)` builds rows from it:
  - scope: `global` for kinetic settings and `tauc/s2/...` with the `g` spin part; `residue` otherwise
  - category: from the name
  - gloss: a hand-written gloss table, kept, with PB corrected to "Population of state B (0 – 1). Nothing enforces PA > PB" and a separate `hint: "typically < 0.5"`
- **Kept keys:** `name, gloss, scope, default_mode, category, is_primary, default_bounds` (now a string like `"0 – 1"`, still consumed by `methods/ParameterTable.tsx`).
- **New keys:** `default_value`, `lower`, `upper`, `derived` (expr exists), `protected` (model-owned, e.g. TREF), `condition_dependent`, `hint`.
- Response stays `{model, parameters}` plus `chemex_version`.
- Frontend: `AvailableParamMeta` gains the optional new fields, and a `lib/chemexDefaults.ts::defaultsLookup(meta[])` feeds codec, validation and placeholders. `DEFAULT_PARAM_METAS` (the offline fallback) gets corrected numbers.
- Only `CpmgAnalysisManager` passes `catalogGlobals` today; CEST and EXCHANGE get the same wiring. That's a page-level prop change, not a plugin-architecture change.
- **Tests:**
  - `tests/test_param_catalog.py`: 2st PB 0.05 [0, 1]; 3st has PC; `2st_binding` has KD/KOFF and no PB; `2st.tc` has TREF `protected`, no bounds, plus CS0_A, CS1_A, DW0_AB and DW1_AB; the endpoint schema is a superset of the old one.
  - A compat-import test.

### Item 3: show ChemEx defaults · `feat(parameters): surface ChemEx defaults; seed CS_A from profiles`

- Empty inputs (global and residue) get the placeholder `ChemEx default: 0.0`, replacing `—`. For `CS_A` the placeholder text is amber, because 0 ppm is outside any sanity range.
- `ParameterBadge`: the `default` state is split into
  - `chemex_default`: label "ChemEx default", tooltip "ChemEx will start at 10.0 s⁻¹ (bounds 0–1000)"
  - `resoflow_start`: label "resoFlow start" (Q3)
  - Both carry their value in the title.
- Banner in `ParametersTab`: "N of M residues will start from ChemEx defaults" (CS_A or DW_AB unset, not excluded), with a "Show" link that sets the table filter (item 10).
- **Bulk action "Seed CS_A from profiles":**
  - New capability `ParameterTabCapabilities.seedFromProfiles?: { label: string; seed(profile): number | null }`. CEST sets it; EXCHANGE inherits it through the spread but its `seed` returns `null` for CPMG profiles; CPMG leaves it unset.
  - Pure `lib/cestProfileSeed.ts::mainDipPpm(profile)`: per experiment, the deepest intensity minimum, excluding the far-off-resonance reference points. Hz→ppm uses the same conversion `ProfileThumbnail` uses, extracted into the lib so both share it. Across B1 experiments it takes the median. Unit-tested on synthetic dips.
  - It applies only to residues with no `cs_a` or with source `default`. It never touches `pick`, `manual`, `imported` or `inherited`.
  - It writes `source: { kind: 'estimated_from_profile', at }`, a new `SourceKind` with a badge "From profile" and a filter count. `sourceLabel` gets "profile estimate".
- Saved configs need no migration (new kind only).

### Item 4: exclusions not as comments · `fix(parameters): exclusions only via [data.profiles]`

- `configToToml` writes excluded residues' values as normal lines. They're harmless, because ChemEx never loads a residue that has no profile. Exclusion stays in `excludedResidues` and is applied only by `applyExclusionsToExperimentToml` (frontend) and `_update_experiment_toml_exclusions` (backend, already in place).
- `tomlToConfig` no longer treats `# KEY = v` as an exclusion; such lines go to `unparsed` like any comment.
- **Migration:** `migrateLegacyCommentExclusions(toml) → { toml, excluded: string[] }`, applied:
  - (a) in `useParameterEditor.restore` for `rawOverride` and `parameter_toml`
  - (b) in `ParametersImportModal` according to Q4
  - It uncomments the lines and adds the keys to `excludedResidues`. A one-time notice reads "Converted N commented residues in an older parameter file to exclusions." It is one-time by construction: the next save writes no comments.
- `DEFAULT_PARAMETER_CODEC` gains `migrate` for structured configs. This is a no-op for exclusions (already structured), but it hosts any future migrations.
- **Tests:**
  - Replace `'comments out excluded residues in generated TOML…'` with "excluded residues are written uncommented and stay in `excludedResidues`".
  - Add legacy-file migration tests, saved-config restore tests and the Q4 import variants.
  - The `[data.profiles]` test stays.
  - `residueExclusion.test.ts` (the results-side helper) gets a case asserting parameter-file comments are irrelevant. That file has no parameter-TOML coupling, so it only gains a regression test.
- Copy changes: D7 and the toggle tooltips ("exclude from experiment files").

**Phase 1 gate:** `npm run lint && npm test && npm run build`; `uv run pytest tests/chemex_api tests/test_chemex_api_endpoints.py tests/test_chemex_integration.py tests/test_chemex_parser_parity.py tests/parity` + the new tests. Then a phase summary.

---

## 4. Phase 2 (P1)

### Item 5: "+ Add global parameter"

- A picker on the global card lists catalogue rows for the current model that aren't already shown. It excludes `derived` and `protected` rows, plus residue-scoped names that make sense as blankets (`R1_A`, `R2_A`, `DW_AB`, `CS_A`).
- Picking `R1_B`/`R2_B` shows an inline warning: "Setting this in [GLOBAL] replaces ChemEx's `= [R2_A]` link for every residue" (§0.1).
- Removing a field removes the key.
- **Precedence test** (`tests/chemex_api/test_global_precedence.py`): a real `build_session` on the bundled `cpmg_15n_rc` fixture data, with two files differing only in section order. It asserts the effective `R2_A` per residue through `inspect_parameters`, then runs one short TRF fit to confirm the starting value reported in `parameters_used.toml`.
- Help text, once verified: "Per-residue sections override [GLOBAL] because resoFlow writes [GLOBAL] first; ChemEx applies the *last* matching entry in the file."
- `tomlToConfig` records section order. If an imported file has `[GLOBAL]` after a per-residue section that sets the same parameter, the import modal warns that the meaning changes on export.

### Item 6: DW threshold

- `maxDwWarn` becomes 15 for ¹⁵N, 20 for ¹³C, 3 for ¹H (HN and methyl). Literature CEST/CPMG |Δϖ| for ¹³C carbonyl/Cα reaches ~10–15 ppm; ¹H rarely exceeds 2–3.
- Severity changes to `info`, and the message names the threshold and ChemEx's example.
- The table header becomes `DW_AB (CS_B − CS_A, ppm)` and its amber highlight follows `maxDwWarn` instead of a hard-coded 6.
- **Negative audit:** inputs have no `min`, `parseFloat` handles `-`, and D4 (Q2) is removed. Tests cover negatives through codec, CPMG codec, table edit, grid apply and validation.

### Item 7: card semantics

- The title becomes **"Global starting values [GLOBAL]"**.
- **Role chip** per global:
  - It shows `roleView(...)` for `methodConfig.steps[activeStepIdx]`, using resolved roles. `ParametersTab` gets `resolvedSteps` from the existing `useResolvedRoles` hook the Methods page already uses.
  - Grid/DE shows "Grid axis"; derived shows "= expr"; `protected` shows no chip.
  - Clicking it calls `onNavigateToMethods`.
- **D5:** the residue table's Method Step column switches to the same resolved view for CS_A/DW_AB.
- **Derived strip:** read-only and pure (`lib/kineticDerived.ts`, tested).
  - nst family: PA = 1 − ΣP, k_ij = kex_ij·p_j/(p_i + p_j) (ChemEx `pair_rates`, §0.3), τ_X = 1/Σ_j k_Xj.
  - 2st reduces to KAB = KEX·PB, KBA = KEX·PA, τ_A = 1/KAB, τ_B = 1/KBA.
  - It uses the entered value, else the ChemEx default (labelled).
  - It is shown only when the model is `1st`–`6st` (incl. `_linear/_fork/_triangle`, `.tc`, `.mf`). Binding, Eyring and HD models are hidden (different parameterisation).

### Item 8: input handling

- New `components/parameters/NumericField.tsx`:
  - It holds string draft state and commits on blur or Enter; Escape reverts.
  - An empty commit means **unset**, so the key is removed and the ChemEx default applies.
  - An invalid draft gets a red ring and no commit.
  - Inputs use `type="number" step="any"`.
- Used by global values and bounds, residue CS_A/CS_B/DW_AB/R1/R2 and bounds.
- `handleCellEdit` takes `number | undefined`. Clearing CS_A keeps DW_AB; clearing DW_AB deletes it.
- The PB unit chip shows nothing (fraction) instead of "0 - 1". Bounds moved to the bounds row (item 1).

**Phase 2 gate:** same commands. Plus the precedence test and a manual check through the `run` skill: launch the app, check CEST, CPMG and EXCHANGE tabs in light and dark mode.

---

## 5. Phase 3 (P2)

### Item 9: TAUC_A estimator

- A popover takes MW (kDa), T (°C) and η/η_water (default 1).
- τc ≈ (MW / 2.6) ns × (η_rel · η_w(T)/η_w(300 K)) × (300 K / T_K), with η_w(T) from the Vogel equation (pure function, tested).
- "Use" writes `manual` with the inputs recorded in the tooltip.
- Field tooltip: "TAUC_A seeds relaxation estimates (model-free / R1·R2 initialisation); it is fixed by default."

### Item 10: table

- **Filter chips:** "ChemEx default (n)" (CS_A or DW_AB unset), "From profile (n)", and an always-visible "Stale (n)".
- **Multi-select:** a checkbox column plus header select-all (filtered set). A bulk bar sets or clears a chosen parameter (`CS_A, DW_AB, R1_A, R2_A`, + bounds) through `NumericField`.
- **Column toggle:** R1_A/R2_A columns behind a "Columns" menu, persisted per user via `localStorage` (try/catch).
- **Row issue badge** from `validationIssues` keyed by residue. `ValidationBanner` items become buttons that switch filter/page to the row, then `scrollIntoView` and run a 1.5 s highlight ring. The row id is `param-row-${resKey}`.

### Item 11: preview diff

- `TomlPreviewStrip` gets a "Diff vs last committed run" toggle.
- The baseline is `Output/run_info/inputs/parameters/*.toml`, served by a new `GET …/chemex/last-run-parameters`. It is the twin of the existing `last-run-method` and reuses its candidate-path logic.
- `lineDiff` renders with the same styling as the method diff. It is hidden when there's no completed run.

### Item 12: `.tc` support

- `isTcModel(model)` comes from the model string. Catalogue rows drive the fields; no branches in shared components beyond catalogue flags (`protected`, names).
- **TREF:** global field, no bounds row, no role chip, tooltip "protected model constant".
- **Coefficient columns and fields:** CS0_A, CS1_A, DW0_AB, DW1_AB, plus the 3-state equivalents, as columns behind the column toggle (shown by default when `.tc`). CS_A/DW_AB inputs become read-only derived displays, with the derived value computed at each experiment's temperature when it's known.
- **Validation:**
  - When all experiments share one temperature and both members of an order-0/order-1 pair are fit in a step, warn "degenerate at a single temperature: fix or constrain one coefficient" (the docs rule).
  - TREF with bounds is an error.
  - TREF outside (−273.15, ∞) is an error.
- **Import:** detect `DWP_AX`/`DWM_AX` and show a conversion preview table (DW0 = DWP + TREF·DWM, DW1 = DWM, with TREF from the file or 25). It needs explicit "Convert" and offers "Keep as raw" (lines go to `unparsed`; ChemEx would reject them). Bounds are flagged for review, not converted.
- **Method tooling:**
  - The FIT/FIX/CONSTRAIN pickers, GRID/DE axis pickers and role-rule entry autocomplete filter out catalogue rows with `protected`.
  - `methodValidation` adds a client-side error "TREF is a protected model constant", with the same wording as ChemEx, before the server round-trip.
  - Backend `method_emitter` refuses to emit TREF in ROLES/GRID/DE (raises `ValueError`, surfaced as 422).
  - Tests on both sides.

**Phase 3 gate:** same commands + summary.

---

## 6. Cross-cutting

- **Plugins:** every new behaviour difference goes through `ParameterTabCapabilities` (`seedFromProfiles` is the only new key) or catalogue data. A checklist in each commit body covers CEST / CPMG / EXCHANGE. `ChemexTabs.test.tsx` renders the tab with all three capability sets.
- **Backward compatibility:**
  - New `ParamValue` fields are optional.
  - `SourceKind` gets only additions; the badge falls back to `default` for unknown kinds.
  - Legacy comment exclusions are migrated (item 4).
  - The endpoint is a superset.
  - The `parameterConfig.default` → "resoFlow start" relabel is display-only.
- **Invariants (CLAUDE.md):** residue keys via `SpinSystemKey`/`getCanonicalResidueKey`; routers thin (new endpoint delegates to `services/`); TOML contract changes mirrored (`parameterToml.ts` ↔ backend round-trip test); state stays in Context + editor hook; no new dependencies.
- **Dark mode:** new UI reuses the existing slate/amber/blue class pairs from `GlobalParametersCard` and the table.

---

## 7. Future work (not in scope)

- **Item 13, layered `-p` files:** multiple parameter files, e.g. a base file + `overrides.toml` + `restart.toml` for "continue from run". This needs a file-order UI and the §0.2 last-wins rule surfaced across files (`read_toml_multi` merge order). The engine side already supports `overrides` in `FitJobSpec`.
- **Per-concrete-parameter effective bounds in the table:** extend the resolved-roles payload with `min/max` from `inspect_parameters` for cases the model-level table can't express (e.g. condition-dependent defaults).

---

## 8. Risks

- **Private-ish ChemEx symbols** (`model_factory`, `create_base_param_settings`, `Basis`) could move in a later release. Mitigated by the `compat.py` import-time check and the hand-written fallback.
- **CS_A main-dip estimate** can pick the B-state dip when PB is large or dips overlap. Seeded values are labelled "From profile" and are never applied over picks.
- **Removing CPMG `abs()` (Q2)** changes how an old CEST-signed file imports into CPMG. Fit results are sign-invariant for CPMG, so it is display-only.
