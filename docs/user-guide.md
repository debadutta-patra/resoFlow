# resoFlow User Guide

This is a walkthrough of using the resoFlow web app as a researcher — accounts, projects, peak fitting, and the CPMG/CEST/relaxation analysis workflows. For installing or deploying resoFlow, see the main [README](../README.md).

## Contents

- [Accounts & signing in](#accounts--signing-in)
- [Dashboard](#dashboard)
- [Projects](#projects)
- [Peak fitting](#peak-fitting)
- [Relaxation analysis (R1 / R2 / hetNOE)](#relaxation-analysis-r1--r2--hetnoe)
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
