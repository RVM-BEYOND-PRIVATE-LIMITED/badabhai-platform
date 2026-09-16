#!/usr/bin/env python3
"""Build the form-flow option glyph font (BbFormGlyphs) and its Dart constants.

The 18 option icons on the trade-form question cards (workholding, measuring
instruments, turning operations) are traced from the form-flow design mockup.
Each glyph is described below as STROKE primitives on a 24x24 grid (y grows
downwards, like SVG / Material Symbols) with a 1.75-unit round-capped stroke
(the weight measured off the mockup), and this script turns those strokes into
filled TrueType outlines:

  * a straight stroke  -> one "stadium" contour (two lines + two round caps)
  * a stroked circle   -> overlapping ring-sector contours
  * a stroked arc      -> a ring-sector contour + round end caps
  * rounded rectangle  -> butt-ended edge bars + quarter ring-sector corners
  * dots / knobs       -> filled discs (quadratic curves)

Every contour is emitted with the SAME winding (clockwise in TrueType's y-up
space), so overlapping strokes always add up under the non-zero fill rule and
never punch holes. Each glyph's ink bounding box is then centred on the em
(12, 12), the way Material icons are centred.

The em box is 2400 units (1 grid unit = 100) with ascent 2400 / descent 0 --
the same layout as Flutter's MaterialIcons font -- so `Icon(FormGlyphs.x)`
centres the 24-unit grid inside its square exactly like a Material icon.

Usage (from apps/worker-app):
    python3 tool/form_glyphs/build_form_glyphs.py
Writes:
    assets/fonts/BbFormGlyphs.ttf
    lib/core/widgets/onboarding/form_glyphs.dart
Requires fontTools (no skia-pathops needed).
"""

from __future__ import annotations

import argparse
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Sequence

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

FAMILY = 'BbFormGlyphs'
GRID = 24.0
UNITS_PER_GRID = 100
UPM = int(GRID * UNITS_PER_GRID)
STROKE = 1.75
FIRST_CODEPOINT = 0xE000
# Fixed head timestamps keep the binary reproducible across rebuilds.
FIXED_TIMESTAMP = 0x00000000E0000000
MAX_ARC_STEP = math.radians(45.0)

APP_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_FONT_OUT = APP_ROOT / 'assets' / 'fonts' / f'{FAMILY}.ttf'
DEFAULT_DART_OUT = APP_ROOT / 'lib' / 'core' / 'widgets' / 'onboarding' / 'form_glyphs.dart'

Point = tuple[float, float]
# A contour is a closed list of (point, on_curve) nodes in grid space. The
# first node is always on-curve and off-curve nodes are never adjacent
# (quadratic segments carry exactly one control point).
Node = tuple[Point, bool]
Contour = list[Node]


# --------------------------------------------------------------------------
# Geometry -> contours
# --------------------------------------------------------------------------

def _polar(c: Point, r: float, a: float) -> Point:
    return (c[0] + r * math.cos(a), c[1] + r * math.sin(a))


def _arc_nodes(c: Point, r: float, a0: float, a1: float, *, include_start: bool) -> list[Node]:
    """Quadratic approximation of an arc from angle a0 to a1 (either direction)."""
    steps = max(1, math.ceil(abs(a1 - a0) / MAX_ARC_STEP - 1e-9))
    delta = (a1 - a0) / steps
    ctrl_r = r / math.cos(delta / 2.0)
    nodes: list[Node] = [(_polar(c, r, a0), True)] if include_start else []
    for i in range(steps):
        mid = a0 + delta * (i + 0.5)
        end = a0 + delta * (i + 1)
        nodes.append((_polar(c, ctrl_r, mid), False))
        nodes.append((_polar(c, r, end), True))
    return nodes


def disc(c: Point, r: float) -> list[Contour]:
    nodes = _arc_nodes(c, r, 0.0, 2 * math.pi, include_start=True)
    return [nodes[:-1]]  # last node duplicates the first


def ring_sector(c: Point, r_in: float, r_out: float, a0: float, a1: float) -> list[Contour]:
    outer = _arc_nodes(c, r_out, a0, a1, include_start=True)
    inner = _arc_nodes(c, r_in, a1, a0, include_start=True)
    return [outer + inner]


def stadium(p1: Point, p2: Point, w: float = STROKE) -> list[Contour]:
    """A straight stroke with round caps."""
    h = w / 2.0
    dx, dy = p2[0] - p1[0], p2[1] - p1[1]
    if math.hypot(dx, dy) < 1e-6:
        return disc(p1, h)
    a = math.atan2(dy, dx)
    nodes: list[Node] = []
    nodes += _arc_nodes(p2, h, a - math.pi / 2, a + math.pi / 2, include_start=True)
    nodes += _arc_nodes(p1, h, a + math.pi / 2, a + 3 * math.pi / 2, include_start=True)
    return [nodes]


def bar(p1: Point, p2: Point, w: float = STROKE) -> list[Contour]:
    """A straight stroke with butt ends (used where corners supply the join)."""
    h = w / 2.0
    dx, dy = p2[0] - p1[0], p2[1] - p1[1]
    length = math.hypot(dx, dy)
    nx, ny = -dy / length * h, dx / length * h
    pts = [(p1[0] + nx, p1[1] + ny), (p2[0] + nx, p2[1] + ny),
           (p2[0] - nx, p2[1] - ny), (p1[0] - nx, p1[1] - ny)]
    return [[(p, True) for p in pts]]


# --------------------------------------------------------------------------
# Stroke primitives (what the glyph table is written in)
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class Line:
    points: Sequence[Point]
    closed: bool = False
    width: float = STROKE

    def contours(self) -> list[Contour]:
        pts = list(self.points)
        if self.closed:
            pts.append(pts[0])
        if len(pts) == 1:
            return disc(pts[0], self.width / 2.0)
        out: list[Contour] = []
        for a, b in zip(pts, pts[1:]):
            out += stadium(a, b, self.width)
        return out


@dataclass(frozen=True)
class Circle:
    center: Point
    radius: float
    width: float = STROKE

    def contours(self) -> list[Contour]:
        h = self.width / 2.0
        r_in, r_out = self.radius - h, self.radius + h
        # Two overlapping half-rings (overlap is safe under non-zero winding).
        return (ring_sector(self.center, r_in, r_out, -0.05, math.pi + 0.05)
                + ring_sector(self.center, r_in, r_out, math.pi - 0.05, 2 * math.pi + 0.05))


@dataclass(frozen=True)
class Arc:
    center: Point
    radius: float
    start_deg: float
    end_deg: float
    width: float = STROKE

    def contours(self) -> list[Contour]:
        h = self.width / 2.0
        a0, a1 = math.radians(self.start_deg), math.radians(self.end_deg)
        return (ring_sector(self.center, self.radius - h, self.radius + h, a0, a1)
                + disc(_polar(self.center, self.radius, a0), h)
                + disc(_polar(self.center, self.radius, a1), h))


@dataclass(frozen=True)
class RoundRect:
    left: float
    top: float
    right: float
    bottom: float
    corner: float
    width: float = STROKE

    def contours(self) -> list[Contour]:
        l, t, r, b, k = self.left, self.top, self.right, self.bottom, self.corner
        h = self.width / 2.0
        out = (bar((l + k, t), (r - k, t), self.width) + bar((r, t + k), (r, b - k), self.width)
               + bar((r - k, b), (l + k, b), self.width) + bar((l, b - k), (l, t + k), self.width))
        corners = (((r - k, t + k), -90.0), ((r - k, b - k), 0.0),
                   ((l + k, b - k), 90.0), ((l + k, t + k), 180.0))
        for c, start in corners:
            a0 = math.radians(start)
            out += ring_sector(c, k - h, k + h, a0, a0 + math.pi / 2)
        return out


@dataclass(frozen=True)
class Dot:
    center: Point
    radius: float = STROKE / 2.0

    def contours(self) -> list[Contour]:
        return disc(self.center, self.radius)


@dataclass(frozen=True)
class Fill:
    """A filled straight-edged polygon (e.g. a diamond knob)."""
    points: Sequence[Point]

    def contours(self) -> list[Contour]:
        return [[(p, True) for p in self.points]]


Primitive = Line | Circle | Arc | RoundRect | Dot | Fill


@dataclass(frozen=True)
class Glyph:
    const_name: str
    option_key: str
    label: str
    primitives: Sequence[Primitive] = field(default_factory=tuple)
    # False keeps the traced placement for glyphs the mockup centres
    # optically rather than by their ink bounding box.
    centre: bool = True


# --------------------------------------------------------------------------
# The glyphs, traced from the mockup (grid units, y down, centre = 12,12)
# --------------------------------------------------------------------------

C = (12.0, 12.0)

GLYPHS: tuple[Glyph, ...] = (
    # --- Workholding -------------------------------------------------------
    # Ring with a small hub; four spokes run hub-to-rim and poke just past it.
    Glyph('teenJawChuck', 'three_jaw', 'Teen jaw chuck', (
        Circle(C, 10.0), Circle(C, 3.0),
        Line([(12, 1.625), (12, 9.0)]), Line([(12, 15.0), (12, 22.375)]),
        Line([(1.625, 12), (9.0, 12)]), Line([(15.0, 12), (22.375, 12)]),
    )),
    # Rounded square split into four cells.
    Glyph('chaarJawChuck', 'four_jaw', 'Chaar jaw chuck', (
        RoundRect(3, 3, 21, 21, 2.375),
        Line([(3, 12), (21, 12)]), Line([(12, 3), (12, 21)]),
    )),
    # Smaller ring with four short ticks pointing inwards from the rim.
    Glyph('collet', 'collet', 'Collet', (
        Circle(C, 8.0),
        Line([(12, 4.0), (12, 7.875)]), Line([(12, 16.125), (12, 20.0)]),
        Line([(4.0, 12), (7.875, 12)]), Line([(16.125, 12), (20.0, 12)]),
    )),
    # Three equal bars; the middle one carries a diamond knob at its left end.
    Glyph('softJaw', 'soft_jaw', 'Soft jaw', (
        Line([(4.5, 5.85), (19.5, 5.85)]),
        Line([(4.5, 12), (19.5, 12)]),
        Line([(4.5, 18.15), (19.5, 18.15)]),
        Fill([(4.5, 12), (8.0, 9.25), (11.5, 12), (8.0, 14.75)]),
    )),
    # Outline triangle pointing right, flatter than a play glyph.
    Glyph('tailstockCentre', 'tailstock', 'Tailstock ya centre', (
        Line([(4.875, 5.25), (18.875, 12), (4.875, 18.75)], closed=True),
    )),
    # Ring, small centre ring, short vertical ticks inside the top and bottom
    # of the rim.
    Glyph('steadyRest', 'steady_rest', 'Steady rest', (
        Circle(C, 9.0), Circle(C, 3.0),
        Line([(12, 3.0), (12, 6.0)]), Line([(12, 18.0), (12, 21.0)]),
    )),
    # --- Measuring ---------------------------------------------------------
    # Three long bars (beam + jaws) tied by two full-height stems and a short
    # centre stem in the upper cell.
    Glyph('vernierCaliper', 'vernier', 'Vernier caliper', (
        Line([(2.0, 5.1), (22.0, 5.1)]),
        Line([(2.0, 12.1), (22.0, 12.1)]),
        Line([(2.0, 18.9), (22.0, 18.9)]),
        Line([(7.0, 5.1), (7.0, 18.9)]),
        Line([(15.75, 5.1), (15.75, 18.9)]),
        Line([(11.5, 5.1), (11.5, 12.1)]),
    )),
    # Clock face: large ring, hand up then down-right.
    Glyph('micrometer', 'micrometer', 'Micrometer', (
        Circle(C, 10.125),
        Line([(12, 7.125), (12, 12), (15.875, 16.0)]),
    )),
    # Ring with an exclamation bar and dot.
    Glyph('boreDialGauge', 'bore_gauge', 'Bore dial gauge', (
        Circle(C, 9.125),
        Line([(12, 7.5), (12, 11.5)]),
        Dot((12, 16.625)),
    )),
    # Up arrow standing on a wide base line.
    Glyph('heightGauge', 'height_gauge', 'Height gauge', (
        Line([(2.75, 20.825), (21.25, 20.825)]),
        Line([(12, 3.05), (12, 20.825)]),
        Line([(7.375, 7.55), (12, 3.05), (16.625, 7.55)]),
    )),
    # Solid plug ring on the left with a faint hairline needle towards two
    # o'clock, and four dots curving round its right side (the ring gauge).
    Glyph('plugRingGauge', 'plug_gauge', 'Plug ya ring gauge', (
        Circle((8.125, 12.875), 5.8),
        Line([(8.125, 12.875), (10.875, 10.5)], width=0.75),
        Dot((16.45, 7.375), 1.0),
        Dot((19.7, 10.3), 1.0),
        Dot((20.45, 14.05), 1.0),
        Dot((18.425, 17.65), 1.0),
    ), centre=False),
    # Gauge dial on a stem, with a small clock hand.
    Glyph('dialIndicator', 'dial_indicator', 'Dial indicator', (
        Circle((12, 9.875), 6.875),
        Line([(12, 16.75), (12, 22.0)]),
        Line([(12, 7.0), (12, 9.875), (14.25, 10.75)]),
    ), centre=False),
    # --- Turning -----------------------------------------------------------
    # Left-aligned text lines: two long, one short.
    Glyph('facingOdTurning', 'facing_od', 'Facing aur OD turning', (
        Line([(5.0, 6.375), (19.625, 6.375)]),
        Line([(5.0, 12), (19.625, 12)]),
        Line([(5.0, 17.625), (13.125, 17.625)]),
    )),
    # Two concentric rings.
    Glyph('boringIdTurning', 'boring', 'Boring, ID turning', (
        Circle(C, 8.5), Circle(C, 3.875),
    )),
    # Three parallel strokes falling left-to-right.
    Glyph('threading', 'threading', 'Threading', (
        Line([(7.25, 4.75), (17.25, 9.75)]),
        Line([(7.25, 9.5), (17.25, 14.5)]),
        Line([(7.25, 14.25), (17.25, 19.25)]),
    )),
    # Upright hash.
    Glyph('groovingParting', 'grooving', 'Grooving aur parting', (
        Line([(9.125, 4.0), (9.125, 20.0)]), Line([(14.875, 4.0), (14.875, 20.0)]),
        Line([(3.75, 9.3), (20.25, 9.3)]), Line([(3.75, 14.7), (20.25, 14.7)]),
    )),
    # Drill: arrow head on a stem with alternating flute barbs and a foot.
    Glyph('drillingTapping', 'drilling', 'Drilling aur tapping', (
        Line([(12, 2.75), (12, 19.5)]),
        Line([(8.5, 7.0), (12, 2.75), (15.5, 7.0)]),
        Line([(8.875, 11.125), (9.375, 12.25), (12, 12.5)]),
        Line([(12, 13.5), (14.625, 14.0), (15.125, 14.625)]),
        Line([(8.875, 16.75), (9.375, 17.875), (12, 18.125)]),
        Line([(12, 19.625), (15.75, 20.5)]),
    )),
    # Large X.
    Glyph('knurlingTaper', 'knurling', 'Knurling aur taper', (
        Line([(4.5, 4.5), (19.5, 19.5)]),
        Line([(19.5, 4.5), (4.5, 19.5)]),
    )),
)


# --------------------------------------------------------------------------
# Font assembly
# --------------------------------------------------------------------------

def _to_font(p: Point) -> tuple[int, int]:
    return (round(p[0] * UNITS_PER_GRID), round((GRID - p[1]) * UNITS_PER_GRID))


def _signed_area(points: Sequence[tuple[int, int]]) -> float:
    return sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(points, points[1:] + points[:1])) / 2.0


def _quad_point(a: Point, c: Point, b: Point, t: float) -> Point:
    u = 1.0 - t
    return (u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1])


def _contour_samples(contour: Contour) -> list[Point]:
    """On-curve points plus samples along every quadratic segment."""
    out: list[Point] = []
    n = len(contour)
    for i, (p, on) in enumerate(contour):
        if on:
            out.append(p)
        else:
            a, b = contour[i - 1][0], contour[(i + 1) % n][0]
            out += [_quad_point(a, p, b, t / 8.0) for t in range(1, 8)]
    return out


def _centred(contours: list[Contour]) -> list[Contour]:
    """Translate the glyph so its ink bounding box is centred on the em."""
    pts = [p for c in contours for p in _contour_samples(c)]
    dx = GRID / 2 - (min(p[0] for p in pts) + max(p[0] for p in pts)) / 2
    dy = GRID / 2 - (min(p[1] for p in pts) + max(p[1] for p in pts)) / 2
    return [[((p[0] + dx, p[1] + dy), on) for p, on in c] for c in contours]


def _draw_contour(pen: TTGlyphPen, contour: Contour) -> None:
    nodes = [(_to_font(p), on) for p, on in contour]
    # TrueType outer contours run clockwise in y-up space (negative area).
    if _signed_area([p for p, _ in nodes]) > 0:
        nodes = [nodes[0]] + nodes[:0:-1]
    pen.moveTo(nodes[0][0])
    i = 1
    n = len(nodes)
    while i < n:
        point, on = nodes[i]
        if on:
            pen.lineTo(point)
            i += 1
        else:
            end = nodes[(i + 1) % n][0]
            pen.qCurveTo(point, end)
            i += 2
    pen.closePath()


def build_font(out: Path) -> None:
    names = ['.notdef'] + [f'uni{FIRST_CODEPOINT + i:04X}' for i in range(len(GLYPHS))]
    glyf = {'.notdef': TTGlyphPen(None).glyph()}
    for name, spec in zip(names[1:], GLYPHS):
        pen = TTGlyphPen(None)
        contours = [c for prim in spec.primitives for c in prim.contours()]
        for contour in (_centred(contours) if spec.centre else contours):
            _draw_contour(pen, contour)
        glyf[name] = pen.glyph()

    fb = FontBuilder(UPM, isTTF=True)
    fb.font.recalcTimestamp = False
    fb.setupGlyphOrder(names)
    fb.setupCharacterMap({FIRST_CODEPOINT + i: n for i, n in enumerate(names[1:])})
    fb.setupGlyf(glyf)
    table = fb.font['glyf']
    metrics = {}
    for n in names:
        g = table[n]
        g.recalcBounds(table)
        metrics[n] = (UPM, getattr(g, 'xMin', 0))
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=UPM, descent=0, lineGap=0)
    fb.setupNameTable({'familyName': FAMILY, 'styleName': 'Regular',
                       'uniqueFontIdentifier': f'{FAMILY}-Regular',
                       'fullName': f'{FAMILY} Regular', 'psName': f'{FAMILY}-Regular',
                       'version': 'Version 1.000'})
    fb.setupOS2(sTypoAscender=UPM, sTypoDescender=0, sTypoLineGap=0,
                usWinAscent=UPM, usWinDescent=0, fsSelection=0x40,
                achVendID='BBAI', usWeightClass=400)
    fb.setupPost()
    head = fb.font['head']
    head.created = head.modified = FIXED_TIMESTAMP
    out.parent.mkdir(parents=True, exist_ok=True)
    fb.save(str(out))


def build_dart(out: Path) -> None:
    lines = [
        '// GENERATED by tool/form_glyphs/build_form_glyphs.py -- do not edit by hand.',
        '',
        "import 'package:flutter/widgets.dart';",
        '',
        '/// Option glyphs for the trade-form question cards, traced from the',
        '/// form-flow mockup (workholding, measuring instruments, turning',
        '/// operations).',
        '///',
        '/// They live in the bundled `BbFormGlyphs` icon font (24-unit grid,',
        '/// 1.75-unit round stroke, laid out like MaterialIcons) and are used like',
        '/// Material icons: `Icon(FormGlyphs.collet, size: 20)`. Change a glyph by',
        '/// editing its strokes in `tool/form_glyphs/build_form_glyphs.py` and',
        '/// re-running it; the script regenerates both the font and this file.',
        'abstract final class FormGlyphs {',
        f"  static const String _family = '{FAMILY}';",
    ]
    for i, g in enumerate(GLYPHS):
        lines += [
            '',
            f'  /// `{g.option_key}` -- {g.label}.',
            f'  static const IconData {g.const_name} = IconData(0x{FIRST_CODEPOINT + i:X}, fontFamily: _family);',
        ]
    lines += ['}', '']
    out.write_text('\n'.join(lines), encoding='utf-8')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--font-out', type=Path, default=DEFAULT_FONT_OUT)
    parser.add_argument('--dart-out', type=Path, default=DEFAULT_DART_OUT)
    parser.add_argument('--no-dart', action='store_true', help='only rebuild the font')
    args = parser.parse_args()
    build_font(args.font_out)
    if not args.no_dart:
        build_dart(args.dart_out)
    print(f'wrote {args.font_out} ({len(GLYPHS)} glyphs)')


if __name__ == '__main__':
    main()
