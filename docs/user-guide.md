# resoFlow User Guide

This is a walkthrough of using the resoFlow web app as a researcher — accounts, projects, peak fitting, and the CPMG/CEST/relaxation analysis workflows. For installing or deploying resoFlow, see the main [README](../README.md).

## Contents

- [Accounts & signing in](#accounts--signing-in)
- [Dashboard](#dashboard)
- [Projects](#projects)
- [Peak fitting](#peak-fitting)
- [Relaxation analysis (R1 / R2 / hetNOE)](#relaxation-analysis-r1--r2--hetnoe)
- [Spectral density mapping (RSDM)](#spectral-density-mapping-rsdm)
- [CPMG relaxation dispersion](#cpmg-relaxation-dispersion)
- [CEST](#cest)
- [Statistics, reports & export](#statistics-reports--export)
- [Admin console](#admin-console)

## Accounts & signing in

1. Go to the app and choose **Create an account** on the sign-in page. You'll need a full name, email, and password.
2. New accounts are created **inactive**. You'll see a "pending administrative approval" message after registering, and sign-in is blocked until an administrator activates your account.
3. Once approved, sign in with your email and password from the login page. Use the theme toggle in the top corner to switch between light and dark mode — it's remembered per browser.

## Dashboard

After signing in you land on the **Workspace Dashboard**, which has three parts:

- **Active runs panel** — every fitting job or ChemEx analysis you currently have queued or running, across all your projects, with a **Cancel** action on each.
- **Projects grid** — all your projects as cards. Use **New Project** or **Import Project** in the header to add more.
- **Recent analyses** — a feed of your most recently created/completed analyses, for quick navigation back into results.

The dashboard auto-refreshes; a spinner next to the title shows when it's updating in the background.

## Projects

A project groups a set of spectra, sequence/metadata, and the analyses run against them. Project data (spectra paths, ChemEx output, a `resoFlow.json` index) lives in a directory on the machine resoFlow's backend runs on.

### Creating a project

**New Project** asks for a name and a **local directory path** — an existing directory the server can read, where resoFlow will create a subfolder for the project's files. Use the folder-search button to browse the host filesystem instead of typing the path by hand.

### Importing a project

If a project directory already has a `resoFlow.json`/`project.json` index in it (e.g. moved from another install, or created outside the app), use **Import Project** and point it at that directory instead of creating a new one — it reads the existing metadata and spectra list back into the database.

### Project details

Opening a project shows three tabs:

- **General Information** — project name, protein sequence (for reference/reports), and molecular weight (kDa). Remember to hit **Save Changes**.
- **Spectra** — the spectra attached to this project. **Add Spectrum** browses the host filesystem for a processed pseudo-3D `.ft2` file (or a Bruker `pdata` directory); resoFlow attempts to auto-detect the spectrometer field (B0) from the file. A spectrum shows a **Fitted** badge once peak fitting has been run on it. Click a spectrum card to open the peak fitting workspace; the **X** removes it from the project (and its associated fit-result files, after confirmation).
- **Analysis** — the relaxation/exchange analyses run against this project's spectra. **Add New Analysis** lets you name it and pick a type: **R1** (T1 relaxation), **R2** (T2 relaxation), **hetNOE** (heteronuclear NOE ratio), **CEST** (¹⁵N-CEST), or **CPMG** (relaxation dispersion). Click an analysis card to open it; the trash icon deletes it (irreversible).

## Peak fitting

Clicking a spectrum in a project opens the peak fitting workspace — this is where you pick peaks on the 2D contour plot and fit lineshapes to get intensities/positions per residue, per plane.

**Plot controls** (left sidebar):
- **Base Level Threshold** — the minimum contour intensity; use **Auto (6σ)** to set it from the spectrum's estimated noise.
- **Multiplier** / **Contours** — geometric spacing and count of the drawn contour levels.
- **Update Plot** redraws with the current settings.

**Peak fitting controls**:
- **Load Peaks** reads an existing peak list (or the persistent JSON sidecar, if you've enabled **Use persistent peaktable**) and displays them as markers on the plot. Click a peak marker to select it (shift-click for multiple); dragging repositions it.
- **X Radius** / **Y Radius** sliders set the fitting window around a peak, in ppm — per-selected-peak, or globally if nothing is selected. **Apply to All Peaks** copies the current radius to every peak.
- **Peaklist Format** — the format of the source peak list: NMRPipe, Sparky, Analysis v2/v3, or CSV.
- **Lineshape** — Pseudo-Voigt, Gaussian, Lorentzian, Voigt, or PV×PV (independent pseudo-Voigt per axis).
- **Algorithm** — the least-squares fitting method: Levenberg–Marquardt, Trust Region Reflective, Nelder–Mead, or Powell.
- **Clustering** — **Auto** (structuring element: Disk/Square/Rectangle) groups overlapping peaks automatically for joint fitting; **Mask** clusters strictly from contour connectivity.
- **Advanced** (collapsible) — manual noise level override, a max cluster size cap, parameters to hold fixed during fitting (fraction/sigma/center), and how many Celery worker processes to use.

**Running a fit**:
- **Re-cluster** recomputes clusters from the current peak positions without fitting.
- **Save Peaks to JSON Sidecar** persists your current peak positions/radii to a JSON file next to the spectrum, independent of the original peak list — recommended once you've adjusted peaks, so re-opening the workspace doesn't lose your edits.
- **Fit All Clusters** (or **Rerun Fitting**, if the spectrum was already fitted) runs the full fit across every cluster and plane, in the background via Celery.
- Selecting a single peak surfaces a **Fit Cluster `<id>`** button to re-fit just that cluster's peaks — much faster for iterating on one region.
- If a previous fit exists, **Restore Backup Fitting** reverts to it.

**Results**: once fitting completes, a summary strip (peaks, clusters, planes, average χ²/reduced χ², lineshape, method used) appears above a sortable results table (per-residue amplitude, position, FWHM, height, and fit statistics, one row per plane/cluster). Use **Export CSV** for the raw table or **Export PDF Report** for a formatted report.

## Relaxation analysis (R1 / R2 / hetNOE)

These analyses fit an exponential decay (R1/R2) or compute a peak-intensity ratio (hetNOE) across a project's already-fitted spectra. Opening one of these analyses shows:

- **General Information** — the analysis metadata and which spectra it draws from.
- **Fit Parameters** — pick the source spectra and confirm/edit their relaxation delay values before running.
- **Results** — fitted rates/ratios per residue, with model-fit and observed-intensity plots.
- **Analysis Log** — the backend log for the run.

Use **Run Analysis** to start it (or **Rerun Analysis** once it has already completed/failed — this overwrites existing results). **Restore Backup** brings back the previous run's results if one exists.

## Spectral density mapping (RSDM)

Reduced spectral density mapping converts per-residue R₁, R₂ and heteronuclear NOE measured **at a single field** into the spectral density values J(0), J(ω_N) and J(0.87ω_H). It is a post-processing step on results resoFlow already produces — no ChemEx, no container, and no fitting.

Create it like any other analysis: **New Analysis** in the project view, pick **SDM**, then open it from the analysis list. It follows the same create → configure → run lifecycle as R₁/R₂/hetNOE and CPMG, and appears alongside them everywhere analyses are listed.

### What it needs

Three **completed** relaxation analyses in the same project — one R₁, one R₂, one hetNOE — that share a static field. The mapping runs in the request and returns immediately; there is no queue to wait on.

The setup panel asks for:

- **Sources** — the three analyses. Each option shows its ¹H frequency so a mismatch is visible before you run.
- **R₂ source type** — see below. Defaults to the direct R₂ experiment.
- **Constants** — `r_NH` (1.02 or 1.015 Å) and `Δσ` (−160, −170 or −172 ppm), or your own values. The choice is snapshotted with the analysis, so a run from two months ago is self-describing.
- **Variant** — which published convention fixes the 0.87 factor. Currently `farrow1995`.
- **Error method** — analytic (the default) or Monte Carlo. The analytic propagation is *exact* for Gaussian input errors, not a first-order approximation, because the rate → density map is linear. Monte Carlo exists as a cross-check and agrees with it to within sampling error.

**Fields must match.** Mapping a 600 MHz R₁ against an 800 MHz R₂ produces J values that look entirely reasonable and are entirely wrong, so a mismatch is refused outright rather than warned about. Sources without a recorded B₀ are refused too — the analysis will not silently assume 600 MHz.

### Where R₂ comes from

The **R₂ experiment (echo decay)** is the default and is what you want unless you have a specific reason otherwise.

resoFlow can also take R₂ from a completed **CPMG fit**, using ChemEx's fitted **R₂,₀** — the transverse rate with exchange already removed by the fitted model. That needs no R_ex subtraction and no covariance bookkeeping, so it is a production option and is *not* gated by the experimental flag.

The trade is worth understanding rather than assuming R₂,₀ is simply better:

| | Direct R₂ experiment | R₂,₀ from a CPMG fit |
|---|---|---|
| Exchange | included, and lands on J(0) | removed by construction |
| Depends on | the measurement only | the exchange model that CPMG fit assumed |
| Use when | you want the measurement as made, or have no CPMG data | you have a trusted CPMG fit and want J(0) free of exchange |

If the CPMG fit is wrong about the exchange model, R₂,₀ is wrong in a way that is much harder to notice than exchange showing up in J(0) — where at least the correlation plot displays it.

**A multi-field CPMG fit stores one R₂,₀ per field**, and they differ substantially — in resoFlow's own test fixture the same residue is 4.01 s⁻¹ at 500 MHz and 6.67 s⁻¹ at 800 MHz. resoFlow selects the block matching the field of your R₁ and hetNOE sources, and refuses with a 422 naming the available fields if there is no block at that field. It will not silently substitute a different one.

### Reading the correlation plot

The J(ω_N) vs J(0) plot is the main interpretive tool. **J(0) is on the abscissa**, the conventional orientation: chemical exchange contaminates J(0) alone, so it displaces a residue horizontally.

Two dashed references are drawn, and they answer different questions:

| Reference | What it is |
|---|---|
| **τ_c sweep** | Parametric in τ: J(0) = (2/5)τ and J(ω_N) = (2/5)τ/(1+(ω_Nτ)²). Rises to a maximum at ω_Nτ = 1 and decays after it. It traces where a rigid isotropic rotor of *any* size would sit — residues of one protein do not move along it, since they share a τ_c, but it locates the family in the plane. |
| **Fixed-τ_c line** | J(ω_N) = J(0)/(1+(ω_Nτ_c)²) for this dataset's τ_c, a straight line through the origin. S² is what genuinely differs between residues of one protein, and both spectral densities scale with it, so this is the line residues actually scatter along. |

Residues leave the fixed-τ_c line in two characteristic directions:

- **Displaced along J(0)**, to the right → chemical exchange.
- **Below the line** → fast internal motion on the ps–ns timescale.

### The overall tumbling time

τ_m is determined by the method of Lefèvre, Dayie, Peng & Wagner (1996): fit a least-squares line to the mapped residues,

```
J(ω_N) = α·J(0) + β
```

then substitute the rigid-rotor forms J(0) = (2/5)τ_m and J(ω_N) = (2/5)τ_m/(1+(ω_Nτ_m)²) into it. Clearing denominators gives a cubic,

```
2αω_N²τ_m³ + 5βω_N²τ_m² + 2(α−1)τ_m + 5β = 0
```

whose roots are all reported. The fitted line is drawn on the correlation plot, so the quality of the fit it came from can be judged by eye.

**Which root.** The cubic has up to three real roots and the choice is not automatic. resoFlow takes the root whose implied J(0) = (2/5)τ_m is closest to the dataset's own trimmed-mean J(0) — the answer has to describe the data it was fitted to. That reproduces the published worked example (α = 0.0772, β = 0.2182 ns/rad at 600 MHz → roots −14.4, 0.6, 5.7 ns → τ_m = 5.7 ns), and it also rejects a spurious root that a "take the largest" rule would fall for: a slightly negative α produces a third positive root far outside the data, which on real datasets can be an order of magnitude too long. The reason for the choice is printed alongside the roots.

**On the correlation coefficient.** It is routinely poor — the source paper reports 21.8% for its own data — because the residues crowd into a narrow range of J(0). A weak r does not by itself invalidate τ_m, but resoFlow reports it rather than hiding it, since τ_m is derived from that line alone. A **negative α** is called out explicitly: no rigid rotor can produce a falling J(ω_N) against J(0), so τ_m from such a fit is not well founded.

When the fit cannot be made — fewer than three residues, or no spread in J(0) — resoFlow falls back to the trimmed-mean J(0)/J(ω_N) ratio, and says which method was used.

Points carry **error ellipses**, not crossed error bars. J(0) and J(ω_N) are correlated by construction — they come from the same three measurements through a shared matrix — so independent bars would overstate the plausible region along one diagonal and understate it along the other. The ellipses come from the full 3×3 covariance, which is stored per residue and included in the CSV export.

> **Interpreting J(0).** Base RSDM assumes no chemical exchange. R₁ and the NOE carry no R_ex, so any exchange contribution lands *entirely* on J(0). An elevated J(0) is as consistent with microsecond–millisecond exchange as with slow overall tumbling, and the mapping alone cannot tell you which. This is the single easiest thing to over-interpret in an RSDM result.

### The PDF report

**Report** on the analysis produces a PDF containing, each on its own page:

| Section | Contents |
|---|---|
| Spectral densities | J(0), J(ω_N) and J(0.87ω_H) vs residue, stacked on a shared axis |
| Measured relaxation rates | R₁, R₂ and hetNOE vs residue, stacked the same way |
| R₂/R₁ | the ratio, with its trimmed mean |
| R₁·R₂ | the product, with a trimmed mean and ±2σ band |
| J(0) vs J(ω_N) | the correlation plot with the rigid-rotor line and error ellipses |
| Per-residue table | every mapped residue, plus flag meanings and exclusions |

The two derived plots are there to be read together. **R₂/R₁** is the classic route to an overall correlation time without needing the NOE, but it is *not* exchange-free: R_ex inflates R₂ and so inflates the ratio, leaving an elevated point ambiguous between slow tumbling, diffusion anisotropy and exchange. **R₁·R₂** resolves part of that ambiguity, because the anisotropy dependences of R₁ and R₂ largely cancel in the product — so a residue standing above the trimmed mean points at chemical exchange rather than at an orientation effect (Kneller, Lu & Bracken, *JACS* 2002).

The trimmed mean and ±2σ band on the product plot are an orientation aid, not a hypothesis test. The multi-field χ² is the test this module offers.

Excluded residues are omitted from every plot and from the results table, and listed separately with their reason.

### Excluding residues

Each row in the results table has an eye toggle, the same as the relaxation analyses. Excluding a residue **omits it from the summary** — the trimmed means, the τ_c estimate and the flag counts all recompute — and marks it in the CSV export and the PDF report.

Two things worth knowing:

- **Per-residue J values never change.** Each residue is an independent 3×3 solve, so excluding one cannot alter another's spectral densities. Excluded residues keep their values and stay in the table, greyed out, rather than disappearing.
- **The J(0) outlier flags do change**, because `elevated_j0` and `reduced_j0` are defined relative to the other residues. Exclude an outlier and the remaining residues are re-judged against the narrower spread. Flags derived from a residue's own inputs — `negative_noe`, `low_noe_precision`, `negative_j` — are unaffected.

Exclusions apply on read, so toggling updates the numbers immediately without a re-run, and they survive a re-run.

### Exclusion flags

A residue is **automatically excluded** when it is not present in all three sources. The reason is specific (`missing hetNOE`, `missing R2`, …) and appears in the results table, the CSV export and the PDF report, so the dataset never shrinks silently.

A residue that *is* mapped may still be **flagged**. Flags are advisory — nothing is dropped on their account:

| Flag | Meaning |
|---|---|
| `negative_noe` | The heteronuclear NOE is negative. Physically valid for tails and flexible loops, so it is mapped rather than filtered — but J(0.87ω_H) then carries very large relative error. |
| `low_noe_precision` | The NOE uncertainty dominates J(0.87ω_H). Treat J_h for that residue as indicative. |
| `negative_j` | A spectral density came out negative, which is unphysical — usually inconsistent input rates, a field mismatch, or an over-subtracted R_ex. |
| `elevated_j0` | J(0) sits well above the trimmed mean: the expected signature of exchange. |
| `reduced_j0` | J(0) sits well below the trimmed mean: the expected signature of fast internal motion. |

### Statistical vs systematic error

Per-residue error bars carry **statistical** uncertainty only, propagated from the R₁, R₂ and NOE errors.

The `r_NH` and `Δσ` choice is **systematic**: it shifts every residue coherently in the same direction. Folding it into per-residue bars would make it look like independent scatter and let it be wrongly averaged down, so it is reported separately as a band on the summary card and in the report.

### What the approximation costs

The reduced approximation collapses J(ω_H−ω_N), J(ω_H) and J(ω_H+ω_N) onto a single J(0.87ω_H). Round-tripping a Lipari–Szabo model through the *full* master equations and back out through RSDM measures the resulting bias. At 600 MHz, over S² ∈ {0.70, 0.85, 0.95}, τ_c ∈ {5, 10, 15} ns and τ_e ∈ {20, 100, 500} ps:

| τ_e | J(0) bias | J(ω_N) bias | J(0.87ω_H) bias |
|---|---|---|---|
| 20 ps | −0.10% to −0.01% | −0.33% to −0.26% | +0.01% |
| 100 ps | −0.13% to −0.01% | −0.47% to −0.29% | +0.07% to +0.28% |
| 500 ps | −0.35% to −0.02% | −1.60% to −0.42% | +0.18% to +0.50% |

The bias is worst for low order parameters and long internal correlation times — where the approximation's assumption that J falls as ω⁻² at high frequency is least true. It is under 2% everywhere in this range, and well below typical experimental error. The table is generated by `test_round_trip_bias_table` in `backend/tests/test_sdm_mapping.py`, which also pins these bounds so the documentation cannot drift from the code.

### Exchange correction (experimental)

> **Experimental, off by default.** Enabled only by setting `RESOFLOW_ENABLE_EXPERIMENTAL_SDM_REX=true` on the server. When it is off, the R_ex controls are hidden entirely and the API refuses any request that asks for a correction. When it is on, every plot, table, CSV export and report derived from a corrected analysis carries an **Experimental** marker — such results must not circulate looking validated.

Two corrections are offered:

1. **R_ex subtraction from a CPMG run** — the fitted per-residue R_ex is subtracted from R₂ before mapping (`y₂ → R₂ − R_ex`), leaving the coefficient matrix untouched. Var(R_ex) is added to the input covariance.
2. **Multi-field consistency** — implemented. With R₁, R₂ and hetNOE at two or more fields the per-field blocks stack into one overdetermined system: **3n rows** against **1 + 2n unknowns** — a single shared, field-independent J(0), plus J(ω_N) and J(0.87ω_H) at each field. It is solved by generalised least squares, `x̂ = (MᵀWM)⁻¹MᵀWy` with `W = Cov_y⁻¹`.

   The residual χ² **is** the exchange test. The n − 1 surplus degrees of freedom are exactly the "J(0) is the same at every field" assumption, and because R₁ and the NOE carry no R_ex, a bad χ² implicates exchange rather than the rest of the model. resoFlow reports a **p-value per residue**; small values implicate exchange.

   Add the extra fields in the R_ex panel: the three primary sources are the first field, and each additional entry adds another at a *different* static field. Repeating a field is refused — each field gets its own J(ω_N) and J(0.87ω_H) columns, so a repeat would still solve, but the χ² would then be a replicate consistency check rather than a test of exchange.

**What the multi-field test cannot see.** n fields leave n − 1 residual degrees of freedom, while n R_ex values would be needed to describe the exchange fully. The shortfall is exactly the **field-independent** component of R_ex — and that component is perfectly degenerate with J(0), so it is absorbed into J(0) rather than reported. A constant exchange contribution present at every field biases J(0) with no warning sign at all. The per-field R₂ residuals resoFlow shows are therefore determined only up to an additive constant: differences between fields are meaningful, absolute values are not.

**On the field dependence of R_ex.** R_ex ∝ B₀² holds only in the fast-exchange limit. resoFlow does not fit R₂ against B₀² with a fixed exponent. The exponent α = ∂ln R_ex/∂ln B₀ is fitted as a free parameter in [0, 2] and reported, because α is itself the diagnostic of the exchange timescale (Millet et al. 2000). Assuming α = 2 when exchange is not fast will misattribute the result.

**α needs three fields, not two.** The power law costs two parameters against n − 1 residual degrees of freedom, so two fields leave the exponent unidentifiable and resoFlow reports none — a number there would be an artefact of the parametrisation. Three fields determine α exactly; four or more overdetermine it and give it an uncertainty. Where α lands on a bound (0 or 2), the value should be read as "at most" or "at least" and no error is quoted.

*Not in scope, noted as future work:* η_xy cross-correlation as an exchange-free R₂ surrogate. It would enter as an additional matrix row with nonzero entries only on J(0) and J(ω_N), but its geometric prefactor carries a P₂(cos θ) convention that must be taken carefully from the literature rather than derived.

### References

- Peng & Wagner (1992) *J Magn Reson* **98**, 308–332; *Biochemistry* **31**, 8571–8586
- Farrow, Zhang, Szabo, Torchia & Kay (1995) *J Biomol NMR* **6**, 153–162
- Lefèvre, Dayie, Peng & Wagner (1996) *Biochemistry* **35**, 2674–2686, [doi:10.1021/bi9526802](https://doi.org/10.1021/bi9526802)
- Kroenke, Loria, Lee, Rance & Palmer (1998) *JACS* **120**, 7905–7915, [doi:10.1021/ja980832l](https://doi.org/10.1021/ja980832l)
- Millet, Loria, Kroenke, Pons & Palmer (2000) *JACS* **122**, 2867–2877, [doi:10.1021/ja993511y](https://doi.org/10.1021/ja993511y)
- Kadeřávek, Zapletal, Rabatinová, Krásný, Sklenář & Žídek (2014) *J Biomol NMR* **58**, 193–207, [doi:10.1007/s10858-014-9816-4](https://doi.org/10.1007/s10858-014-9816-4)

## CPMG relaxation dispersion

CPMG analyses drive [ChemEx](https://github.com/gbouvignies/chemex) fits inside an isolated container. Opening a CPMG analysis shows a sidebar with:

- **Experiments** — select which spectra (CPMG vclist series) feed the fit, and generate/preview the ChemEx experiment TOML files from them.
- **Inspect Dispersion** — view raw dispersion curves (R2,eff vs. νCPMG) per residue before fitting.
- **Parameters** — starting values and bounds for the exchange parameters (kex, pB, Δω, R2,0, ...), per-residue or global.
- **Methods** — build the multi-step ChemEx fitting method (e.g. a grid search followed by a full fit, then uncertainty analysis). Use **Method Strategy Templates** for a predefined multi-step strategy rather than building one from scratch.
- **Logs** — a live-streamed log of the running (or most recent) ChemEx execution, with buttons to download the full log file or the generated method TOML.
- **Results** — appears once the run completes or fails.

Above the tabs:
- **Global / Individual** toggles whether the fit shares exchange parameters across all selected residues (global) or fits each independently.
- **Save Config** persists your current experiment/parameter/method setup without running anything.
- **Run ChemEx** starts the fit; **Stop Run** cancels a running or queued fit.
- Once completed, **Use fitted as starting** copies the fitted parameter values back into the Parameters tab (handy for a refinement pass), and — if the method included a grid search — **Use grid minimum as starting** does the same from the grid's χ² minimum.
- **Restore Last fit** brings back a previous run's results if one was overwritten.

### Results & statistics

The Results tab shows the fitted global/per-residue parameter table (with sparkline previews), goodness-of-fit statistics per method step, and — depending on what the method requested — grid search plots, and Monte Carlo / Bootstrap / MCMC uncertainty distributions with diagnostics (acceptance rates, convergence status, etc.). Joint- and marginal-distribution plots between parameter pairs are available from the parameter table. If the method had multiple steps, a step selector lets you compare results across steps.

## CEST

CEST analyses follow the same shape as CPMG (ChemEx-driven, same container execution model), with a sidebar of **Experiments**, **Pick CEST**, **Parameters**, **Methods**, **Logs**, and **Results**.

- **Pick CEST** is where you select and inspect the CEST saturation profile for each residue before fitting.
- **Parameters** additionally supports **inheriting parameters from another completed run** (via the source-run picker) — useful for chaining a refit off a prior analysis's fitted values. A run started this way is marked "Seeded from `<source run>`" in its header, with a link back to that run.
- If you edit peak picks after parameters were last synced, a **"N Pick(s) moved"** badge appears — click it to review and resync the affected parameters. Similarly, a **"Config changed since last run"** badge warns when the on-screen configuration no longer matches what produced the currently-displayed results.
- The same **Global/Individual** fit-mode toggle, **Run ChemEx** / **Stop Run**, **Use fitted as starting**, **Use grid minimum as starting**, and **Restore Last fit** controls apply as in CPMG.

CEST's Results tab additionally offers a dedicated **PDF report** generation and a **download reproducible archive** option (a ZIP of the full ChemEx output tree — inputs, parameters, plots, statistics — for archiving or sharing).

## Statistics, reports & export

Across CPMG and CEST results:

- **Grid Search** — 1D/2D χ² surfaces when the method included a grid search step.
- **Monte Carlo / Bootstrap / MCMC** — resampled or posterior parameter distributions with per-parameter summary statistics and convergence diagnostics.
- **Joint & marginal distribution plots** — pairwise and single-parameter distribution views, opened from the parameter table.
- **PDF reports** — a formatted report of an analysis's fitted parameters, plots, and provenance, generated per-analysis.
- **ZIP export** — the complete underlying ChemEx output tree for a completed analysis, via a signed, time-limited download link.
- **CSV export** — raw peak-fitting result tables, from the peak fitting workspace.

## Admin console

Superusers see an **Admin Console** link (a shield icon) from the dashboard, which lists every registered user with:

- **Activate / Deactivate** — approve a pending registration, or immediately revoke an existing user's access (deactivation takes effect on their very next request, not just their next login).
- **Make Admin / Revoke Admin** — grant or remove superuser privileges. You cannot change your own superuser status or deactivate your own account (to avoid locking yourself out).
- **Password** — set a new password for a user directly.
- **Delete** — permanently remove a user account (cannot be undone; you cannot delete your own account).
