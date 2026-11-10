"""WCAG contrast audit for text colours used on the Methods page, in both themes.

resoFlow remaps Tailwind's slate/blue/indigo/emerald/green/red/amber/yellow palettes to CSS
variables (frontend/src/index.css), with a different mapping in dark mode, so Tailwind's
stock contrast intuition does not hold. This script resolves each text class to the real RGB of
each theme and checks it against the page's card backgrounds (white / slate-50 in light,
slate-900 / slate-800 in dark), reporting the worst case.

    python3 dev/contrast_audit.py [--fix] [files...]

--fix rewrites failing `text-<hue>-<shade>` / `dark:text-<hue>-<shade>` tokens to the nearest
shade of the same hue that passes AA (4.5:1) in that theme.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CSS = ROOT / "frontend" / "src" / "index.css"
DEFAULT_FILES = sorted((ROOT / "frontend" / "src" / "components" / "methods").glob("*.tsx")) + [
    ROOT / "frontend" / "src" / "components" / "chemex" / n for n in ("TomlEditorParts.tsx", "StartingValuesMenu.tsx", "SaveButton.tsx")
]
REMAPPED = ("slate", "blue", "indigo", "emerald", "green", "red", "amber", "yellow")
SHADES = ("50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950")
# Stock Tailwind v3 shades for hues the theme does not remap (only those used on the page).
STOCK = {
    "purple": {"200": (233, 213, 255), "300": (216, 180, 254), "400": (192, 132, 252), "600": (147, 51, 234), "700": (126, 34, 206), "800": (107, 33, 168)},
    "sky": {"300": (125, 211, 252), "400": (56, 189, 248)},
}
AA = 4.5


def _vars(block: str) -> dict[str, str]:
    return {m.group(1): m.group(2).strip() for m in re.finditer(r"--([a-z0-9-]+):\s*([^;]+);", block)}


def palettes() -> dict[str, dict[str, tuple[int, int, int]]]:
    css = CSS.read_text(encoding="utf-8")
    light_block = css[: css.index(".dark {")]
    dark_block = css[css.index(".dark {") : css.index("}", css.index(".dark {"))]
    out = {}
    for theme, block in (("light", light_block), ("dark", dark_block)):
        v = _vars(light_block)
        if theme == "dark":
            v.update(_vars(dark_block))

        def resolve(name: str, depth: int = 0) -> tuple[int, int, int] | None:
            raw = v.get(name)
            if raw is None or depth > 5:
                return None
            m = re.match(r"var\(--([a-z0-9-]+)\)", raw)
            if m:
                return resolve(m.group(1), depth + 1)
            parts = raw.split()
            return tuple(int(p) for p in parts[:3]) if len(parts) >= 3 else None  # type: ignore[return-value]

        pal = {}
        for hue in REMAPPED:
            for sh in SHADES:
                rgb = resolve(f"{hue}-{sh}")
                if rgb:
                    pal[f"{hue}-{sh}"] = rgb
        for hue, shades in STOCK.items():
            for sh, rgb in shades.items():
                pal[f"{hue}-{sh}"] = rgb
        pal["white"] = (255, 255, 255)
        out[theme] = pal
    return out


def lum(rgb: tuple[int, int, int]) -> float:
    def ch(c: float) -> float:
        c /= 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = (ch(x) for x in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def ratio(a: tuple[int, int, int], b: tuple[int, int, int]) -> float:
    la, lb = sorted((lum(a), lum(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def backgrounds(pal: dict, theme: str) -> list[tuple[int, int, int]]:
    return [pal["white"], pal["slate-50"]] if theme == "light" else [pal["slate-900"], pal["slate-800"]]


def worst(token: str, pal: dict, theme: str) -> float | None:
    rgb = pal.get(token)
    if rgb is None:
        return None
    return min(ratio(rgb, bg) for bg in backgrounds(pal, theme))


# Text drawn on the always-dark code panels (TOML viewer, diffs) is checked against those panels
# by eye, not against the card backgrounds: skip lines that set such a panel or its line styles.
SKIP_LINE = re.compile(r"((?<!dark:)bg-slate-9(00|50)|^\s*'[ +-]': '|font-mono text-emerald-400)")

TOKEN = re.compile(r"(?<![\w:-])(dark:)?text-([a-z]+)-(\d{2,3})(?![\w/-])")


def best_shade(hue: str, current: str, pal: dict, theme: str) -> str | None:
    """Nearest shade of the same hue that passes AA in this theme."""
    candidates = [s for s in SHADES if f"{hue}-{s}" in pal and (worst(f"{hue}-{s}", pal, theme) or 0) >= AA]
    if not candidates:
        return None
    idx = SHADES.index(current)
    return min(candidates, key=lambda s: abs(SHADES.index(s) - idx))


def main() -> int:
    fix = "--fix" in sys.argv
    files = [Path(a) for a in sys.argv[1:] if not a.startswith("--")] or DEFAULT_FILES
    pals = palettes()
    failures: dict[tuple[str, str], set[str]] = {}
    for f in files:
        text = f.read_text(encoding="utf-8")
        new = text

        def repl(m: re.Match[str]) -> str:
            dark, hue, shade = m.group(1), m.group(2), m.group(3)
            theme = "dark" if dark else "light"
            token = f"{hue}-{shade}"
            r = worst(token, pals[theme], theme)
            if r is None or r >= AA:
                return m.group(0)
            failures.setdefault((theme, f"text-{token}"), set()).add(f.name)
            if not fix:
                return m.group(0)
            alt = best_shade(hue, shade, pals[theme], theme)
            return f"{dark or ''}text-{hue}-{alt}" if alt else m.group(0)

        new = "".join(line if SKIP_LINE.search(line) else TOKEN.sub(repl, line) for line in text.splitlines(keepends=True))
        if fix and new != text:
            f.write_text(new, encoding="utf-8")
    for (theme, cls), where in sorted(failures.items()):
        token = cls[len("text-") :]
        r = worst(token, pals[theme], theme)
        alt = best_shade(token.split("-")[0], token.split("-")[1], pals[theme], theme)
        print(f"{theme:5}  {cls:22} {r:4.2f}:1  → {('text-' + token.split('-')[0] + '-' + alt) if alt else 'no passing shade'}   ({', '.join(sorted(where))})")
    print(f"{len(failures)} failing text classes{' (fixed)' if fix and failures else ''}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
