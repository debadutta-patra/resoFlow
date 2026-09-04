# resoFlow — WeasyPrint reporting design

Target: replace the matplotlib `PdfPages` page-assembly layer in
`backend/app/services/reporting/` with an HTML/CSS Paged Media pipeline, without
touching the uncertainty / kinetics / provenance / formatting layers and without
changing the public entry point.

Verified against WeasyPrint 69.0 with a 60-residue synthetic report.

---

## 0. Correction on dependencies

WeasyPrint is not pure Python. It links Pango via cffi.

```
pip:  weasyprint -> cffi, cssselect2, fonttools, Pillow, pydyf, Pyphen, tinycss2, tinyhtml5
apt:  libpango-1.0-0 libpangoft2-1.0-0 fontconfig   (glib + harfbuzz arrive as deps)
```

On `python:3.13-slim-trixie` that is roughly **35–45 MB** of added image layers,
against the ~500 MB–1 GB a usable TeX Live set would cost.

Offline-bundle impact is **nil**: `containers/build.sh` bakes the apt install into
`Containerfile.base`, and `deploy/bundle.sh` ships `podman save`d tarballs. No
runtime package fetching, unlike Tectonic.

Add a font package too — `fonts-dejavu-core` — so `font-family: "DejaVu Sans"`
resolves for the HTML text. Matplotlib bundles DejaVu inside its wheel, but
fontconfig won't see it.

---

## 1. Current shape and what moves

`report_generator.py` (1278 lines) currently does three jobs in one class:

| Concern | Where it lives now | Where it goes |
|---|---|---|
| Data assembly | `ReportBuilder.__init__`, `_index_residues_and_flags` | `model.py` |
| Page layout / pagination | `render_pdf` page_generators list | `templates/*.html` + `print.css` |
| Table drawing | `ax.table(...)` × 8 call sites | `<table>` |
| Header/footer | `_draw_header_footer` | `@page` margin boxes |
| Plot drawing | `_plot_dispersion_curve`, heatmaps, KDE, histograms | `figures.py` (kept, retargeted) |

`uncertainty.py` (730), `kinetics.py` (249), `provenance.py` (289),
`formatting.py` (296) are already renderer-agnostic. They do not move.

---

## 2. Module layout

```
backend/app/services/reporting/
    __init__.py          # unchanged public API
    model.py             # NEW  ReportModel — pure data, JSON-serializable
    figures.py           # NEW  each fn returns an SVG string
    render.py            # NEW  render_html() / render_pdf()
    templates/
        base.html
        report.html
        _summary.html
        _index.html
        _profiles.html
        _residue_detail.html
        _statistics.html
        _provenance.html
    static/
        print.css
        screen.css
    formatting.py        # + "html" style
    uncertainty.py       # unchanged
    kinetics.py          # unchanged
    provenance.py        # unchanged
    plot_styles.py       # unchanged
    report_generator.py  # shrinks to a thin compat shim
```

Keep the existing signature so `zip_export.py:282`, `cest_report.py:39` and both
router endpoints need zero changes:

```python
def generate_modern_pdf_report(analysis_dir, analysis_name, analysis_type="CEST",
                               style="publication", chemex_image_digest=None,
                               fixed_timestamp=None) -> io.BytesIO:
    model = build_report_model(analysis_dir, analysis_name, analysis_type,
                               chemex_image_digest, fixed_timestamp)
    return render_pdf(model, style=style)
```

---

## 3. `model.py` — split data from rendering

This is the highest-value refactor and it is worth doing **even if you never ship
WeasyPrint**. Lift `ReportBuilder.__init__` verbatim; it already does the right
things (resolver init, provenance extraction, derived-kinetics propagation,
residue indexing with flags).

```python
@dataclass
class ResidueRecord:
    raw_key: str
    display_name: str
    chi2_red: float | None
    dw: ResolvedParameter
    r1a: ResolvedParameter
    r2a: ResolvedParameter
    r2b: ResolvedParameter
    csa: ResolvedParameter
    csb: ResolvedParameter
    flags: list[str]
    experiments: list[dict]

    @property
    def has_flags(self) -> bool:
        return bool(self.flags)

    @property
    def anchor(self) -> str:
        return "res-" + re.sub(r"[^A-Za-z0-9]", "-", self.raw_key)


@dataclass
class ReportModel:
    analysis_name: str
    analysis_type: str
    analysis_dir: Path
    results: dict
    provenance: ReportProvenance
    derived_kinetics: DerivedKineticResult
    residues: list[ResidueRecord]
    global_params: list[tuple[str, ResolvedParameter]]
    resampled: dict[str, dict]      # resolver._resampled_cache
    grid_1d: dict                   # resolver._1d_grid_cache
    ledger: dict[str, int]

    def to_dict(self) -> dict: ...  # for golden tests + the HTML/JSON endpoints
```

Two things fall out of this for free:

- The `RuntimeError("Resampling statistics artifacts were found on disk, but zero
  parameters resolved…")` guard moves into `build_report_model`, so it fails
  before any rendering work, not partway through `render_pdf`.
- `to_dict()` gives you a golden-file test that pins report *content* independent
  of report *appearance*. You currently have no report test at all — `backend/tests/`
  contains only `test_zip_export.py`.

Note `resolver._resampled_cache` and `_1d_grid_cache` are private. Promote them to
public accessors on `UncertaintyResolver` while you're in there; `render_pdf`
already reaches into both.

---

## 4. `figures.py` — matplotlib returns SVG

Every plot method keeps its body. The change is the boundary: instead of drawing
into a page-level `fig` at a `GridSpec` slot, each returns a standalone SVG string.

```python
plt.rcParams["svg.fonttype"] = "path"   # glyphs -> outlines

def _svg(fig) -> str:
    buf = io.StringIO()
    fig.savefig(buf, format="svg", bbox_inches="tight")
    plt.close(fig)
    s = buf.getvalue()
    return s[s.index("<svg"):]           # strip XML decl + DOCTYPE

def dispersion_curve(model, rec, compact=False, show_anchors=True) -> str:
    fig, ax = plt.subplots(figsize=(3.2, 2.2) if compact else (6.4, 3.4))
    _draw_dispersion(ax, model, rec, compact, show_anchors)   # existing body
    return _svg(fig)
```

**Why SVG, and why `fonttype="path"`.** WeasyPrint embeds SVG as vector content, so
figures stay resolution-independent and the PDF stays small — my POC produced 8
figures across 7 pages in 91 KB. `"path"` converts figure text to outlines, which
removes any dependency on WeasyPrint resolving matplotlib's fonts. Figure text
stops being selectable, but *report* text stays real HTML text, which is where
searchability actually matters.

**Exception — rasterize dense artists.** `pcolormesh` correlation heatmaps and 2D
grid contours emit one path per cell and will blow up. Either pass
`rasterized=True` on those artists, or give `figures.py` a per-figure format
switch returning a `data:image/png;base64,` URI at 300 dpi. The histogram, KDE
joint, dispersion, CEST profile and residuals plots are all fine as SVG.

Set the style context once at the `render_*` boundary rather than per figure —
`apply_report_style` is already a context manager, so wrap the whole figure-
generation pass in it.

---

## 5. Templates and `print.css`

### 5.1 Running headers and footers

Replaces `_draw_header_footer` entirely, including the `Page N of M` logic that
currently requires pre-counting `total_pages = len(page_generators)` before any
rendering happens.

```css
@page {
  size: Letter;
  margin: 18mm 16mm 16mm 16mm;
  @top-left     { content: "resoFlow — " string(analysis-title); font-size: 7.5pt; color: #6B7280; }
  @top-right    { content: string(section-title); font-size: 7.5pt; color: #6B7280; }
  @bottom-left  { content: "generated " string(gen-timestamp); font-size: 7.5pt; }
  @bottom-right { content: "Page " counter(page) " of " counter(pages); font-size: 7.5pt; }
}
h2 { string-set: section-title content(text); }
```

`counter(pages)` is resolved by WeasyPrint after layout. The `page_generators`
two-pass dance disappears.

### 5.2 Tables that paginate themselves

```css
thead { display: table-header-group; }   /* repeats on every page */
tr    { break-inside: avoid; }
```

Deletes `res_per_idx_page = 28`, `grid_per_page = 4`,
`params_per_dist_page = 4`, and all the `math.ceil` page arithmetic in
`render_pdf`. **Verified**: a 60-row index table split across two pages with the
header row repeated automatically.

### 5.3 Bookmarks and cross-references

```css
h1 { bookmark-level: 1; bookmark-label: content(text); }
h2 { bookmark-level: 2; bookmark-label: content(text); }
h3 { bookmark-level: 3; bookmark-label: content(text); }

a.xref::after { content: leader('.') " p. " target-counter(attr(href), page); }
```

```html
<td><a class="xref" href="#{{ r.anchor }}">{{ r.display_name }}</a></td>
```

Renders as `14N .......... p. 23`, clickable, page number computed at layout time.
This is the `\pageref` equivalent and it is the single biggest usability gain over
the current output, which has no PDF outline and no internal links at all.
**Verified**: 3-level nested outline extracted cleanly with pypdf.

### 5.4 Profile grid

```css
.profile-grid { display: flex; flex-wrap: wrap; gap: 6pt; }
.profile-card { width: 48%; break-inside: avoid; }
.profile-card svg { width: 100%; height: auto; }
```

Cards flow and break naturally. If you want to preserve exactly 4-per-page, set a
fixed card height instead of forcing breaks — but letting it flow is better, since
a 6-panel page is fine when the panels are small.

### 5.5 Keep-together rules

```css
h2, h3            { break-after: avoid; }
.residue-detail   { break-inside: avoid; }
.provenance-block { break-inside: avoid; }
```

---

## 6. Number formatting

`formatting.py` already has `style: str = "unicode" | "latex" | "ascii"` and an
unused `format_value_with_error_latex`. Add `"html"`:

```python
if style == "html":
    if is_asymmetric:
        return (f'<span class="v">{val_s}</span>'
                f'<sup>+{hi_s}</sup><sub>&minus;{lo_s}</sub>')
    return f'<span class="v">{val_s}</span><span class="pm">&plusmn;{sig_s}</span>'
```

Register as Jinja filters so templates stay clean:

```python
env.filters["val"]   = lambda p: Markup(format_with_error(p, style="html"))
env.filters["srcmk"] = lambda p: Markup(SOURCE_SUPERSCRIPTS_HTML[p.source.value])
```

### Column alignment without siunitx

Split value and error into adjacent cells and let CSS do the work:

```css
td.n { text-align: right; font-variant-numeric: tabular-nums; padding-right: 0; }
td.e { text-align: left;  font-variant-numeric: tabular-nums; padding-left: 2pt; }
```

```html
<td class="n">{{ "%.2f"|format(r.dw.value) }}</td>
<td class="e">± {{ "%.2f"|format(r.dw.sigma) }}</td>
```

Values right-align against the ± boundary, errors left-align away from it — the
columns line up on the separator. `tabular-nums` fixes digit widths. This is the
alignment that is structurally impossible inside a `matplotlib.table` cell.

### Uncertainty-source markers

CSS footnotes (`float: footnote`) do work in WeasyPrint — I confirmed it — but do
**not** use them per-cell. With 60 residues × 4 parameters you get 240 footnote
calls and the footnote area eats the page. Keep the existing
`SOURCE_SUPERSCRIPTS` approach (ᵍ ᵐ ᵇ ᶜ *) as inline `<sup>` markers plus one key
block at the end of each table. Reserve real footnotes for the handful of
page-level caveats on the provenance page.

---

## 7. Escaping

```python
env = Environment(loader=FileSystemLoader(TPL_DIR),
                  autoescape=select_autoescape(["html"]),
                  undefined=StrictUndefined)
```

That is the whole story, and it is the main reason this path is cheaper than
LaTeX. You interpolate analysis names, host filesystem paths, SHA-256 hashes and
ChemEx parameter keys like `[R2_A, NUC->15N, B0->800]` — under LaTeX every one of
those is an escaping obligation and a `\write18` consideration. Here `>` becomes
`&gt;` and you move on.

`StrictUndefined` matters: it turns a typo'd field into a loud template error
instead of a silently blank table cell.

---

## 8. Execution and delivery

Both endpoints currently generate synchronously inside the request handler:

```python
# analysis.py:1086, 1120 — sync def, runs in the threadpool, in the API container
pdf_buffer = generate_cest_pdf_report(run_dir, analysis.name, ...)
return StreamingResponse(pdf_buffer, ...)
```

Three fixes, independent of the rendering change but worth doing in the same pass:

1. **Move to Celery**, `stats` queue. You already have the job/progress/log
   machinery and the frontend already polls it for fits.
2. **Deliver via the signed expiring download token** you built for
   `zip_export.py`, instead of streaming from the request.
3. **Stop leaking tracebacks.** Both handlers do
   `detail=f"Failed to generate report: {str(e)}\n{tb}"` — that ships host
   filesystem paths to the browser. Log the traceback, return an opaque message
   plus a job id.

Rendering cost is dominated by matplotlib figure generation, not by WeasyPrint.
Budget on the order of a second of layout for a 60-page document; a 200-residue
analysis will spend its time in `savefig`.

---

## 9. HTML report in the UI

The payoff that LaTeX cannot give you at all. Same model, same templates, second
stylesheet:

```
GET /analysis/{uuid}/report.html   ->  render_html(model, style="screen")
GET /analysis/{uuid}/report.pdf    ->  render_pdf(model, style="publication")
GET /analysis/{uuid}/report.json   ->  model.to_dict()
```

Serve the HTML in a route inside the React SPA. A user checking whether a fit
converged gets an answer without a download round-trip. `screen.css` can drop the
`@page` rules, widen tables, and add sticky table headers. Later, `report.json`
lets you swap the static SVGs for Plotly components in the web view while the PDF
keeps the matplotlib figures — one model, two renderers.

---

## 10. Migration phases

Each phase ships independently and leaves `main` working.

**A — Extract the model.** Create `model.py`, have `ReportBuilder` consume it.
Zero output change. Add a golden test on `to_dict()`. This is the phase that pays
off regardless of what you decide about the rest.

**B — Extract figures.** `figures.py` returning SVG. The existing matplotlib page
builders keep working by drawing into axes via a shared `_draw_*` helper; the
figure wrapper is a thin new layer over the same body.

**C — Text and table pages via WeasyPrint.** Summary, residue index, provenance,
correlation tables. Render those with WeasyPrint, keep the matplotlib pages, merge
with pypdf:

```python
writer = PdfWriter()
for chunk in (weasy_front, mpl_plots, weasy_back):
    for page in PdfReader(chunk).pages:
        writer.add_page(page)
```

Ship it. This is where you get pagination and bookmarks for the pages that need
them most, at maybe 300 lines of new code.

**D — Move the plot pages.** Templates embed `figures.py` SVGs. Delete
`PdfPages`, delete the pypdf merge, delete `_draw_header_footer` and the
`page_generators` list. `report_generator.py` becomes a shim.

**E — HTML endpoint and UI route.**

---

## 11. Testing

- **Model golden test** — `to_dict()` against the recorded fixture trees already
  in `backend/tests/fixtures/`, with `fixed_timestamp` pinned. Catches content
  regressions cheaply.
- **Structural PDF assertions** — render, then with pypdf assert: outline depth
  and entry count, page count within a band, every residue anchor appears in
  extracted text, no `Error rendering page` string present.
- **Template smoke tests** — `StrictUndefined` plus a model with every optional
  field `None` (no statistics runs, no grid cache, single residue, zero residues).
  The current code has a per-page `try/except` that papers over exactly this class
  of bug by printing a red error onto the page.
- **Snapshot images** — optional; rasterize page 1 and diff. High maintenance,
  low yield. Skip unless layout regressions actually bite you.

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| Pango/fontconfig missing on a lab host | Baked into `Containerfile.base`; every deployment path is containerized, so there is no bare-metal case |
| Unicode glyphs (Δω, χ²ᵣ, ⁺¹⁶₋₁₄) missing | `fonts-dejavu-core` in the image; verified rendering in the POC |
| Dense heatmaps bloat the SVG | Per-figure PNG fallback at 300 dpi, or `rasterized=True` |
| WeasyPrint CSS gaps vs a browser | No JS, no flexbox edge cases beyond simple wrap, no CSS grid subgrid. Stick to flex + tables. Everything in this design is verified on 69.0 |
| Two renderers coexisting during phase C | Time-boxed; phase D deletes one |

---

## 13. What was verified

WeasyPrint 69.0, 60-residue synthetic model, 8 embedded matplotlib SVGs:

- 7 pages, **91 KB**
- 3-level PDF outline via `bookmark-level` / `bookmark-label`
- `target-counter(attr(href), page)` resolving to real page numbers with leader dots
- `<thead>` repeating across the index-table page break
- `± ` column alignment via split cells + `tabular-nums`
- CSS footnotes functional (but rejected at per-cell scale, see §6)
- Δω, R₂A, χ²ᵣ, I / I₀ rendering correctly
- All report text extractable by pypdf
