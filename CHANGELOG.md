# Changelog

## ChemEx 2026.9.2 Upgrade & Library Integration

resoFlow has migrated to `chemex==2026.9.2` using a dedicated library execution engine (`resoflow.chemex_api` + `resoflow.engine`).

### Important Note on Numerical Differences vs. Older Runs

When re-running analyses originally conducted on ChemEx 2026.6, you may observe slight numerical differences in parameter values and reported uncertainties:

1. **Uncertainties no longer scaled by reduced $\chi^2$ (B6):**
   - In ChemEx 2026.9, deterministic covariance-derived parameter standard errors (`stderr`) are reported directly from the covariance matrix rather than multiplied by $\sqrt{\chi^2_\text{red}}$.
   - When reduced $\chi^2 > 1$, reported standard errors will appear smaller than under 2026.6; when reduced $\chi^2 < 1$, they will appear larger. This follows upstream SciPy/ChemEx statistical conventions.
2. **Standard parameter default bounds (B10):**
   - ChemEx 2026.9 applies standard finite default bounds to physical parameters (e.g. $S^2 \in [0, 1]$, $p_B \in [0, 1]$, rates $> 0$). Fits that previously hit parameter space edges unconstrained are now cleanly bounded.
3. **Model reparameterisations & Kinetic conventions (B9):**
   - 3-state binding models (`3st_binding_cs`, `3st_binding_if`) use canonical $K_\text{eq}$ and $K_\text{ex}$ parameters.
   - Cross-correlated relaxation `.tc` models use `DW0_AX` and `DW1_AX` instead of legacy `DWP`/`DWM`.
   - Apparent dissociation constants are reported as `KD_APP` (formerly `KD_EFF`).
4. **Statistics field nomenclature (B5):**
   - Monte Carlo and bootstrap intervals are now named percentiles (`percentile_68_lower`, `percentile_68_upper`, `half_percentile_68_width`).
   - MCMC reports credible intervals (`credible_interval_68_lower`, `credible_interval_68_upper`, `half_credible_interval_68_width`).
5. **Historical runs preserved:**
   - Previous 2026.6 run directories and result bundles remain fully supported and readable with their original values, labels, and provenance intact.
