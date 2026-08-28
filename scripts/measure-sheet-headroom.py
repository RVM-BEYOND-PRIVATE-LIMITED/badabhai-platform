"""Measure how much room every trade sheet has left, and fail if any is too close to the edge.

WHY THIS EXISTS AS A GATE RATHER THAN A NOTE. "28/28 on one page" was true and told us nothing:
the worst sheet fit at exactly 297.00 mm and spilled at 296.75. A binary fit assertion cannot
distinguish a comfortable page from one that a WeasyPrint patch release, a changed base image or
a missing font package breaks silently across every sheet at once.

WHAT IT MEASURES. For each sheet, the SHORTEST page height at which it still renders on one page,
by binary search at 0.25 mm. Headroom is 297 mm minus that height. It is a whole-page measurement,
so page margins, break behaviour and the footer's flex row are all inside it — which "the bottom
of the last box" is not.

WHY THE FLOOR IS 5 mm. Measured, not chosen. Rendering the matrix across WeasyPrint 63.1, 66.0
and 69.0 gives byte-identical headroom on all 28 sheets, so renderer version is not the risk. The
variance is FONT FALLBACK: with `fonts-noto-core` absent the stack falls to DejaVu Sans and the
numbers move by up to 3.64 mm, in both directions. 5 mm sits above the largest observed movement
and is within a rounding error of one 4.89 mm text line, which is the smallest unit this page can
actually shed.

HOW TO RUN IT. WeasyPrint does not run on the Windows dev host, so this goes through the same
Docker image the API uses:

    # 1. write the sheets (and their manifest)
    EMIT_SHEETS=/tmp/sheets pnpm --filter @badabhai/api run test sheet-shape-emit

    # 2. measure them
    docker run --rm -v "$PWD:/w" -v /tmp/sheets:/sheets -w /w bb-weasy:local \
        python scripts/measure-sheet-headroom.py /sheets

NOT WIRED INTO CI, AND THAT IS STATED RATHER THAN IMPLIED. The `e2e` job has no WeasyPrint, so
this is a local/manual gate today. Its result is recorded in docs/resume-engine-r1-journal.md.
"""

import argparse
import glob
import json
import os
import re
import sys

from weasyprint import HTML

A4_MM = 297.0
SEARCH_STEP_MM = 0.25
DEFAULT_FLOOR_MM = 5.0

# The template writes `@page { size: A4; margin: 12mm; }`. Substituting the height is how the
# search asks "would this still fit if the page were shorter?" without touching the content.
PAGE_RE = re.compile(r"@page\s*\{\s*size:\s*A4;")


def pages_at(html_src: str, height_mm: float) -> int:
    patched = PAGE_RE.sub("@page { size: 210mm %.3fmm;" % height_mm, html_src, count=1)
    if patched == html_src:
        # Fail loudly rather than silently measuring an unmodified page and reporting it as a
        # pass — a measurement that cannot observe what it claims is the failure this repo keeps
        # rediscovering.
        raise SystemExit("FATAL: '@page { size: A4;' not found; the measurement would be a lie")
    return len(HTML(string=patched).render().pages)


def headroom_mm(html_src: str):
    """Shortest page that still holds this sheet, as headroom below A4. None if it overflows."""
    if pages_at(html_src, A4_MM) != 1:
        return None
    lo, hi = 40.0, A4_MM  # lo assumed to overflow, hi known to fit
    if pages_at(html_src, lo) == 1:
        return A4_MM - lo
    while hi - lo > SEARCH_STEP_MM:
        mid = (lo + hi) / 2
        if pages_at(html_src, mid) == 1:
            hi = mid
        else:
            lo = mid
    return A4_MM - hi


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("sheet_dir")
    ap.add_argument("--floor-mm", type=float, default=DEFAULT_FLOOR_MM)
    args = ap.parse_args()

    files = sorted(glob.glob(os.path.join(args.sheet_dir, "*.html")))
    if not files:
        raise SystemExit("FATAL: no sheets in %s — run the emit test first" % args.sheet_dir)

    stages = {}
    manifest_path = os.path.join(args.sheet_dir, "manifest.json")
    if os.path.exists(manifest_path):
        for row in json.load(open(manifest_path, encoding="utf-8")):
            stages[row["file"]] = row

    results = []
    for path in files:
        name = os.path.basename(path)
        h = headroom_mm(open(path, encoding="utf-8").read())
        results.append((h, name))
        print("  measured %-28s %s" % (name, "OVERFLOW" if h is None else "%.2f mm" % h),
              flush=True)

    results.sort(key=lambda r: (r[0] is not None, r[0]))
    print("\n%-28s %10s %6s  %s" % ("sheet", "headroom", "stage", "dropped"))
    for h, name in results:
        row = stages.get(name, {})
        dropped = ", ".join(row.get("dropped", [])) or "-"
        print("%-28s %10s %6s  %s" % (
            name.replace(".html", ""),
            "OVERFLOW" if h is None else "%.2f mm" % h,
            row.get("stage", "?"),
            dropped,
        ))

    over = [n for h, n in results if h is None]
    under = [(h, n) for h, n in results if h is not None and h < args.floor_mm]
    fits = [h for h, _ in results if h is not None]

    print("\nsheets=%d  one-page=%d  over=%d  floor=%.2fmm" % (
        len(results), len(fits), len(over), args.floor_mm))
    if fits:
        print("worst headroom: %.2f mm" % min(fits))

    for name in over:
        print("::error::%s renders on more than one page" % name)
    for h, name in under:
        print("::error::%s has %.2f mm headroom, below the %.2f mm floor"
              % (name, h, args.floor_mm))

    return 1 if (over or under) else 0


if __name__ == "__main__":
    sys.exit(main())
