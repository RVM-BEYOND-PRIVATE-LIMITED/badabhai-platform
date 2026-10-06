#!/usr/bin/env node
/**
 * Generate (or verify) every platform artifact built from `art/*.svg`, the ONE source of the
 * role illustrations.
 *
 *   node scripts/generate.mjs           # write all artifacts
 *   node scripts/generate.mjs --check   # verify only; exit 1 on any drift
 *
 * Artifacts (never hand-edit them — edit the SVG, re-run this):
 *   1. src/generated/role-art-data.ts                                   — web (React renderer data)
 *   2. role-art.css                                                     — web (keyframes, reduce-motion)
 *   3. apps/worker-app/lib/core/widgets/role_art/role_art_data.g.dart   — worker app (painter data)
 *
 * WHY PATH DATA AND NOT SVG FILES ON THE APP: the worker app paints the art with a CustomPainter
 * from the same normalized path commands the web renders as `<path d>`, so it needs no SVG
 * runtime (no flutter_svg, no asset bundle entries) and both platforms draw byte-identical
 * geometry from one parse.
 *
 * THE SVG SUBSET IS CLOSED, and anything outside it FAILS the run rather than being dropped —
 * a silently skipped shape would make the two platforms disagree. Allowed:
 *   <svg viewBox="0 0 300 100" data-loop="2..4">          the canvas; the role's loop, seconds
 *     <g data-part="name" [motion attrs]>                  one named part; no nesting
 *       <path d> | <circle cx cy r> | <ellipse cx cy rx ry> | <rect x y width height [rx]>
 * Paint: fill / stroke ∈ the three brand colours (or fill="none"), opacity ∈ {1, .8, .6, .4},
 * stroke-width, and a stroke is always round-capped and round-joined (thick, soft terminals).
 * Motion attrs on a part: data-motion (see MOTIONS), data-amp, data-origin="x y",
 * data-rate (whole cycles per loop, so every loop is seamless), data-phase (0..1).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_DIR = join(PKG_DIR, "..", "..");
const ART_DIR = join(PKG_DIR, "art");
const OUT_TS = join(PKG_DIR, "src", "generated", "role-art-data.ts");
const OUT_CSS = join(PKG_DIR, "role-art.css");
const OUT_DART = join(
  REPO_DIR,
  "apps",
  "worker-app",
  "lib",
  "core",
  "widgets",
  "role_art",
  "role_art_data.g.dart",
);

export const CANVAS = { width: 300, height: 100 };

/** The brand palette (CLAUDE.md design system) — the ONLY colours art may use. */
export const PALETTE = {
  primary: "#05194C", // Shift Blue
  accent: "#FFB32C", // Safety Yellow
  surface: "#F3F5F4", // Ivory
};
const OPACITY_STEPS = [1, 0.8, 0.6, 0.4];

/**
 * The motion vocabulary both platforms implement. A keyframe value is `base + key * amp`;
 * keyframes are evenly spaced over one cycle and each segment is eased (`ease-in-out` is
 * cubic-bezier(.42,0,.58,1) on the web and `Curves.easeInOut` — the same curve — in Flutter).
 * Every motion's first keyframe is its REST pose, which is also the reduce-motion frame.
 */
export const MOTIONS = {
  swing: { prop: "rotate", base: 0, keys: [0, 1, 0, -1, 0], easing: "ease-in-out" },
  nod: { prop: "rotate", base: 0, keys: [0, 1, 0], easing: "ease-in-out" },
  spin: { prop: "rotate", base: 0, keys: [0, 1], easing: "linear" },
  bob: { prop: "translateY", base: 0, keys: [0, 1, 0], easing: "ease-in-out" },
  slide: { prop: "translateX", base: 0, keys: [0, 1, 0, -1, 0], easing: "ease-in-out" },
  shuttle: { prop: "translateX", base: 0, keys: [0, 1, 0], easing: "ease-in-out" },
  // One-way travel for a repeating row (a conveyor): amp = the row's pitch, so the end pose
  // is the start pose shifted by exactly one item and the loop is seamless.
  convey: { prop: "translateX", base: 0, keys: [0, 1], easing: "linear" },
  pulse: { prop: "scale", base: 1, keys: [0, 1, 0], easing: "ease-in-out" },
  blink: { prop: "opacity", base: 1, keys: [0, -1, 0], easing: "ease-in-out" },
};

const fail = (file, msg) => {
  throw new Error(`${file}: ${msg}`);
};

/* ── Number formatting: 2 decimals, no trailing zeros, no "-0" ────────────────────────── */
function fmt(n) {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
}
function dartNum(n) {
  const s = fmt(n);
  return s.includes(".") ? s : `${s}.0`;
}

/* ── Minimal tokenizer for the closed SVG subset ──────────────────────────────────────── */
function parseAttrs(file, raw) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    if (m[1] in attrs) fail(file, `duplicate attribute ${m[1]}`);
    attrs[m[1]] = m[2];
  }
  const rest = raw.replace(re, "").trim();
  if (rest !== "") fail(file, `unparseable attribute text: ${rest}`);
  return attrs;
}

function tokenize(file, text) {
  const body = text.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?xml[\s\S]*?\?>/, "");
  const re = /<(\/?)([a-zA-Z]+)([^>]*?)(\/?)>/g;
  const tokens = [];
  let last = 0;
  let m;
  while ((m = re.exec(body)) !== null) {
    if (body.slice(last, m.index).trim() !== "") fail(file, "text content is not allowed");
    tokens.push({
      close: m[1] === "/",
      name: m[2],
      attrs: parseAttrs(file, m[3]),
      self: m[4] === "/",
    });
    last = re.lastIndex;
  }
  if (body.slice(last).trim() !== "") fail(file, "trailing content after </svg>");
  return tokens;
}

/* ── Path data → absolute command list ────────────────────────────────────────────────── */
const ARITY = { M: 2, L: 2, H: 1, V: 1, C: 6, Q: 4, A: 7, Z: 0 };

function normalizePath(file, d) {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  const leftover = d.replace(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?|[\s,]/g, "");
  if (leftover !== "") fail(file, `bad path data near "${leftover}"`);
  const out = [];
  let i = 0;
  let cmd = null;
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  const num = () => {
    const t = tokens[i++];
    if (t === undefined || /[a-zA-Z]/.test(t)) fail(file, `path "${d}" ends mid-command`);
    return Number(t);
  };
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) {
      cmd = tokens[i++];
      if (!(cmd.toUpperCase() in ARITY)) fail(file, `path command ${cmd} is outside the subset`);
    } else if (cmd === null) {
      fail(file, `path "${d}" must start with a command`);
    }
    const up = cmd.toUpperCase();
    const rel = cmd !== up;
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    switch (up) {
      case "M":
        x = ox + num();
        y = oy + num();
        sx = x;
        sy = y;
        out.push(["M", x, y]);
        cmd = rel ? "l" : "L"; // implicit lineto after a moveto pair
        break;
      case "L":
        x = ox + num();
        y = oy + num();
        out.push(["L", x, y]);
        break;
      case "H":
        x = ox + num();
        out.push(["L", x, y]);
        break;
      case "V":
        y = oy + num();
        out.push(["L", x, y]);
        break;
      case "C": {
        const v = [ox + num(), oy + num(), ox + num(), oy + num(), ox + num(), oy + num()];
        out.push(["C", ...v]);
        x = v[4];
        y = v[5];
        break;
      }
      case "Q": {
        const v = [ox + num(), oy + num(), ox + num(), oy + num()];
        out.push(["Q", ...v]);
        x = v[2];
        y = v[3];
        break;
      }
      case "A": {
        const rx = num();
        const ry = num();
        const rot = num();
        const large = num();
        const sweep = num();
        if (![0, 1].includes(large) || ![0, 1].includes(sweep)) fail(file, "arc flags must be 0/1");
        x = ox + num();
        y = oy + num();
        out.push(["A", rx, ry, rot, large, sweep, x, y]);
        break;
      }
      case "Z":
        out.push(["Z"]);
        x = sx;
        y = sy;
        cmd = null;
        break;
    }
  }
  if (out.length === 0 || out[0][0] !== "M") fail(file, `path "${d}" must start with M`);
  return out;
}

/* ── Primitive shapes → the same command list ─────────────────────────────────────────── */
function num(file, attrs, key, fallback) {
  const v = attrs[key];
  if (v === undefined) {
    if (fallback !== undefined) return fallback;
    fail(file, `missing ${key}`);
  }
  const n = Number(v);
  if (!Number.isFinite(n)) fail(file, `${key}="${v}" is not a number`);
  return n;
}

function shapeCommands(file, name, a) {
  switch (name) {
    case "path":
      return normalizePath(file, a.d ?? fail(file, "path without d"));
    case "circle": {
      const [cx, cy, r] = [num(file, a, "cx"), num(file, a, "cy"), num(file, a, "r")];
      return ellipseCommands(cx, cy, r, r);
    }
    case "ellipse": {
      const [cx, cy] = [num(file, a, "cx"), num(file, a, "cy")];
      return ellipseCommands(cx, cy, num(file, a, "rx"), num(file, a, "ry"));
    }
    case "rect": {
      const [x, y] = [num(file, a, "x", 0), num(file, a, "y", 0)];
      const [w, h] = [num(file, a, "width"), num(file, a, "height")];
      const r = Math.min(num(file, a, "rx", 0), w / 2, h / 2);
      if (r === 0)
        return [["M", x, y], ["L", x + w, y], ["L", x + w, y + h], ["L", x, y + h], ["Z"]];
      return [
        ["M", x + r, y],
        ["L", x + w - r, y],
        ["A", r, r, 0, 0, 1, x + w, y + r],
        ["L", x + w, y + h - r],
        ["A", r, r, 0, 0, 1, x + w - r, y + h],
        ["L", x + r, y + h],
        ["A", r, r, 0, 0, 1, x, y + h - r],
        ["L", x, y + r],
        ["A", r, r, 0, 0, 1, x + r, y],
        ["Z"],
      ];
    }
    default:
      return fail(file, `<${name}> is outside the subset`);
  }
}

function ellipseCommands(cx, cy, rx, ry) {
  return [
    ["M", cx - rx, cy],
    ["A", rx, ry, 0, 1, 1, cx + rx, cy],
    ["A", rx, ry, 0, 1, 1, cx - rx, cy],
    ["Z"],
  ];
}

const commandsToD = (cmds) =>
  cmds.map(([c, ...v]) => (v.length ? `${c}${v.map(fmt).join(" ")}` : c)).join("");

/* ── Paint ────────────────────────────────────────────────────────────────────────────── */
function colourToken(file, value) {
  const hit = Object.entries(PALETTE).find(([, hex]) => hex.toLowerCase() === value.toLowerCase());
  if (!hit) fail(file, `colour ${value} is not one of the three brand colours`);
  return hit[0];
}

const PAINT_ATTRS = new Set([
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "opacity",
]);
const GEOMETRY_ATTRS = {
  path: ["d"],
  circle: ["cx", "cy", "r"],
  ellipse: ["cx", "cy", "rx", "ry"],
  rect: ["x", "y", "width", "height", "rx"],
};

function shapePaint(file, a) {
  const opacity = a.opacity === undefined ? 1 : Number(a.opacity);
  if (!OPACITY_STEPS.includes(opacity)) fail(file, `opacity ${a.opacity} is not one of 1/.8/.6/.4`);
  const fill = a.fill === undefined || a.fill === "none" ? null : colourToken(file, a.fill);
  const stroke = a.stroke === undefined || a.stroke === "none" ? null : colourToken(file, a.stroke);
  if (fill === null && stroke === null) fail(file, "a shape must have a fill or a stroke");
  if (fill !== null && stroke !== null) fail(file, "use two shapes, not fill + stroke on one");
  if (stroke !== null) {
    if (a["stroke-linecap"] !== "round" || a["stroke-linejoin"] !== "round") {
      fail(file, "strokes must be round-capped and round-joined (soft terminals)");
    }
    const w = Number(a["stroke-width"]);
    if (!(w >= 4)) fail(file, "stroke-width must be ≥ 4 — no thin wireframe lines");
    return { colour: stroke, opacity, strokeWidth: w };
  }
  return { colour: fill, opacity, strokeWidth: 0 };
}

/* ── One SVG → one role definition ────────────────────────────────────────────────────── */
function parseArt(file, text) {
  const tokens = tokenize(file, text);
  const root = tokens.shift();
  if (!root || root.name !== "svg" || root.close) fail(file, "must start with <svg>");
  if (tokens.pop()?.name !== "svg") fail(file, "must end with </svg>");
  if (root.attrs.viewBox !== `0 0 ${CANVAS.width} ${CANVAS.height}`) {
    fail(
      file,
      `viewBox must be "0 0 ${CANVAS.width} ${CANVAS.height}" (one canvas for every role)`,
    );
  }
  const loop = Number(root.attrs["data-loop"]);
  if (!(loop >= 2 && loop <= 4)) fail(file, "data-loop must be 2..4 seconds");

  const parts = [];
  let part = null;
  for (const t of tokens) {
    if (t.name === "g") {
      if (t.close) {
        if (!part) fail(file, "unbalanced </g>");
        if (part.shapes.length === 0) fail(file, `part "${part.name}" is empty`);
        parts.push(part);
        part = null;
        continue;
      }
      if (part) fail(file, "nested <g> is outside the subset");
      part = {
        name: t.attrs["data-part"] ?? fail(file, "<g> needs data-part"),
        motion: motionOf(file, t.attrs),
        shapes: [],
      };
      if (parts.some((p) => p.name === part.name)) fail(file, `duplicate part ${part.name}`);
      continue;
    }
    if (t.close) fail(file, `unexpected </${t.name}>`);
    if (!t.self) fail(file, `<${t.name}> must be self-closing`);
    if (!part) fail(file, `<${t.name}> must sit inside a <g data-part>`);
    const allowed = new Set([...(GEOMETRY_ATTRS[t.name] ?? []), ...PAINT_ATTRS]);
    for (const k of Object.keys(t.attrs))
      if (!allowed.has(k)) fail(file, `<${t.name} ${k}> is outside the subset`);
    part.shapes.push({ cmds: shapeCommands(file, t.name, t.attrs), ...shapePaint(file, t.attrs) });
  }
  if (part) fail(file, "unclosed <g>");
  const moving = parts.filter((p) => p.motion !== null).length;
  if (moving < 1 || moving > 2) fail(file, `needs 1–2 moving parts, has ${moving}`);
  return { loop, parts };
}

function motionOf(file, a) {
  const type = a["data-motion"];
  if (type === undefined) {
    for (const k of ["data-amp", "data-origin", "data-rate", "data-phase"]) {
      if (k in a) fail(file, `${k} without data-motion`);
    }
    return null;
  }
  if (!(type in MOTIONS)) fail(file, `unknown data-motion "${type}"`);
  const amp = Number(a["data-amp"]);
  if (!Number.isFinite(amp) || amp === 0) fail(file, "data-amp must be a non-zero number");
  const [ox, oy] = (a["data-origin"] ?? "150 50").split(/\s+/).map(Number);
  if (!Number.isFinite(ox) || !Number.isFinite(oy)) fail(file, 'data-origin must be "x y"');
  const rate = Number(a["data-rate"] ?? 1);
  if (!Number.isInteger(rate) || rate < 1 || rate > 4) fail(file, "data-rate must be a whole 1..4");
  const phase = Number(a["data-phase"] ?? 0);
  if (!(phase >= 0 && phase < 1)) fail(file, "data-phase must be in [0, 1)");
  return { type, amp, ox, oy, rate, phase };
}

/* ── Emitters ─────────────────────────────────────────────────────────────────────────── */
const HEADER =
  "GENERATED by packages/role-art/scripts/generate.mjs from packages/role-art/art/*.svg — DO NOT EDIT. Edit the SVG and re-run `pnpm --filter @badabhai/role-art art:generate`.";

function emitTs(roles) {
  const L = [];
  L.push(`// ${HEADER}`, "");
  L.push('import type { RoleArtDef, RoleArtMotionSpec } from "../types";', "");
  L.push(
    `export const ROLE_ART_CANVAS = { width: ${CANVAS.width}, height: ${CANVAS.height} } as const;`,
    "",
  );
  L.push("export const ROLE_ART_PALETTE = {");
  for (const [k, v] of Object.entries(PALETTE)) L.push(`  ${k}: "${v}",`);
  L.push("} as const;", "");
  L.push("export const ROLE_ART_MOTIONS = {");
  for (const [k, m] of Object.entries(MOTIONS)) {
    L.push(
      `  ${k}: { prop: "${m.prop}", base: ${m.base}, keys: [${m.keys.join(", ")}], easing: "${m.easing}" },`,
    );
  }
  L.push("} as const satisfies Record<string, RoleArtMotionSpec>;", "");
  L.push("export const ROLE_ART_KINDS = [");
  for (const k of Object.keys(roles)) L.push(`  "${k}",`);
  L.push("] as const;", "");
  L.push("export type RoleArtKind = (typeof ROLE_ART_KINDS)[number];", "");
  L.push("export const ROLE_ART_DATA: Readonly<Record<RoleArtKind, RoleArtDef>> = {");
  for (const [kind, def] of Object.entries(roles)) {
    L.push(`  ${kind}: {`, `    loop: ${def.loop},`, "    parts: [");
    for (const p of def.parts) {
      const motion = p.motion
        ? `{ type: "${p.motion.type}", amp: ${fmt(p.motion.amp)}, ox: ${fmt(p.motion.ox)}, oy: ${fmt(p.motion.oy)}, rate: ${p.motion.rate}, phase: ${fmt(p.motion.phase)} }`
        : "null";
      L.push(
        "      {",
        `        name: "${p.name}",`,
        `        motion: ${motion},`,
        "        shapes: [",
      );
      for (const s of p.shapes) {
        L.push(
          `          { d: "${commandsToD(s.cmds)}", colour: "${s.colour}", opacity: ${fmt(s.opacity)}, strokeWidth: ${fmt(s.strokeWidth)} },`,
        );
      }
      L.push("        ],", "      },");
    }
    L.push("    ],", "  },");
  }
  L.push("};", "");
  return L.join("\n");
}

function emitCss() {
  const L = [];
  L.push(`/* ${HEADER} */`, "");
  L.push(
    "/* One animated role illustration (<RoleArt>). The part's motion arrives as custom properties",
    "   (--ra-amp, --ra-ox, --ra-oy, --ra-dur, --ra-delay) stamped by the renderer from the same",
    "   generated data the worker app paints, so both platforms move the same parts the same way. */",
    "",
    ".bb-role-art {",
    "  display: block;",
    "  width: 100%;",
    "  height: auto;",
    `  aspect-ratio: ${CANVAS.width} / ${CANVAS.height};`,
    "}",
    "",
    ".bb-role-art__part {",
    "  transform-box: view-box;",
    "  transform-origin: var(--ra-ox) var(--ra-oy);",
    "  animation-duration: var(--ra-dur);",
    "  animation-delay: var(--ra-delay);",
    "  animation-iteration-count: infinite;",
    "}",
    "",
  );
  const valueOf = (m, k) => {
    const coeff = k === 0 ? "0" : String(k);
    const v = m.base === 0 ? `var(--ra-amp) * ${coeff}` : `${m.base} + var(--ra-amp) * ${coeff}`;
    switch (m.prop) {
      case "rotate":
        return `transform: rotate(calc(${v} * 1deg));`;
      case "translateX":
        return `transform: translateX(calc(${v} * 1px));`;
      case "translateY":
        return `transform: translateY(calc(${v} * 1px));`;
      case "scale":
        return `transform: scale(calc(${v}));`;
      case "opacity":
        return `opacity: calc(${v});`;
      default:
        throw new Error(m.prop);
    }
  };
  for (const [name, m] of Object.entries(MOTIONS)) {
    L.push(`@keyframes bb-role-art-${name} {`);
    m.keys.forEach((k, i) => {
      const pct = fmt((i / (m.keys.length - 1)) * 100);
      L.push(`  ${pct}% {`, `    ${valueOf(m, k)}`, "  }");
    });
    L.push("}", "");
    const timing = m.easing === "linear" ? "linear" : "cubic-bezier(0.42, 0, 0.58, 1)";
    L.push(
      `.bb-role-art--animated .bb-role-art__part--${name} {`,
      `  animation-name: bb-role-art-${name};`,
      `  animation-timing-function: ${timing};`,
      "}",
      "",
    );
  }
  L.push(
    "/* Reduce motion: the art holds its rest pose (every motion's first keyframe). */",
    "@media (prefers-reduced-motion: reduce) {",
    "  .bb-role-art__part {",
    "    animation: none !important;",
    "  }",
    "}",
    "",
  );
  return L.join("\n");
}

function emitDart(roles) {
  const L = [];
  L.push(`// ${HEADER}`, "//", "// ignore_for_file: lines_longer_than_80_chars", "");
  L.push("part of 'role_art.dart';", "");
  L.push(`const double _kCanvasWidth = ${dartNum(CANVAS.width)};`);
  L.push(`const double _kCanvasHeight = ${dartNum(CANVAS.height)};`, "");
  L.push("const Map<RoleArtColour, int> _kPalette = <RoleArtColour, int>{");
  for (const [k, v] of Object.entries(PALETTE))
    L.push(`  RoleArtColour.${k}: 0xFF${v.slice(1).toUpperCase()},`);
  L.push("};", "");
  L.push("const Map<String, RoleArtMotionSpec> _kMotions = <String, RoleArtMotionSpec>{");
  for (const [k, m] of Object.entries(MOTIONS)) {
    L.push(
      `  '${k}': RoleArtMotionSpec(prop: RoleArtMotionProp.${m.prop}, base: ${dartNum(m.base)}, keys: <double>[${m.keys.map(dartNum).join(", ")}], eased: ${m.easing === "ease-in-out"}),`,
    );
  }
  L.push("};", "");
  L.push("/// Every kind with art, in declared order (the 21 role kinds, then `generic`).");
  L.push("const List<String> kRoleArtKinds = <String>[");
  for (const k of Object.keys(roles)) L.push(`  '${k}',`);
  L.push("];", "");
  const OP = { M: 0, L: 1, C: 2, Q: 3, A: 4, Z: 5 };
  L.push("const Map<String, RoleArtDef> _kRoleArt = <String, RoleArtDef>{");
  for (const [kind, def] of Object.entries(roles)) {
    L.push(
      `  '${kind}': RoleArtDef(`,
      `    loopSeconds: ${dartNum(def.loop)},`,
      "    parts: <RoleArtPart>[",
    );
    for (const p of def.parts) {
      const motion = p.motion
        ? `RoleArtMotion(type: '${p.motion.type}', amp: ${dartNum(p.motion.amp)}, ox: ${dartNum(p.motion.ox)}, oy: ${dartNum(p.motion.oy)}, rate: ${p.motion.rate}, phase: ${dartNum(p.motion.phase)})`
        : "null";
      L.push(
        "      RoleArtPart(",
        `        name: '${p.name}',`,
        `        motion: ${motion},`,
        "        shapes: <RoleArtShape>[",
      );
      for (const s of p.shapes) {
        const ops = s.cmds
          .flatMap(([c, ...v]) => [OP[c], ...v])
          .map(dartNum)
          .join(", ");
        L.push(
          `          RoleArtShape(colour: RoleArtColour.${s.colour}, opacity: ${dartNum(s.opacity)}, strokeWidth: ${dartNum(s.strokeWidth)}, ops: <double>[${ops}]),`,
        );
      }
      L.push("        ],", "      ),");
    }
    L.push("    ],", "  ),");
  }
  L.push("};", "");
  return L.join("\n");
}

/* ── Driver ───────────────────────────────────────────────────────────────────────────── */
export function buildArtifacts() {
  const files = readdirSync(ART_DIR).filter((f) => f.endsWith(".svg"));
  const kinds = files.map((f) => f.slice(0, -4));
  // Declared order: the kinds file (art/ORDER) lists the 21 role kinds + generic, so the
  // generated lists read in the same order as TRADE_FORM_KINDS_ALL.
  const order = readFileSync(join(ART_DIR, "ORDER"), "utf8")
    .split("\n")
    .map((l) => l.replace(/#.*/, "").trim())
    .filter(Boolean);
  const missing = order.filter((k) => !kinds.includes(k));
  const extra = kinds.filter((k) => !order.includes(k));
  if (missing.length || extra.length) {
    throw new Error(
      `art/ORDER and art/*.svg disagree — missing svg: [${missing}], unlisted svg: [${extra}]`,
    );
  }
  const roles = {};
  for (const kind of order) {
    const file = join(ART_DIR, `${kind}.svg`);
    roles[kind] = parseArt(
      relative(REPO_DIR, file),
      readFileSync(file, "utf8").replace(/\r\n/g, "\n"),
    );
  }
  return new Map([
    [OUT_TS, emitTs(roles)],
    [OUT_CSS, emitCss()],
    [OUT_DART, emitDart(roles)],
  ]);
}

function main() {
  const check = process.argv.includes("--check");
  const artifacts = buildArtifacts();
  let drift = 0;
  for (const [path, text] of artifacts) {
    const rel = relative(REPO_DIR, path);
    const current = existsSync(path) ? readFileSync(path, "utf8").replace(/\r\n/g, "\n") : null;
    if (current === text) continue;
    if (check) {
      console.error(`DRIFT: ${rel} is not what art/*.svg generates — run the generator.`);
      drift++;
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      console.log(`wrote ${rel}`);
    }
  }
  if (check && drift > 0) process.exit(1);
  if (check) console.log(`role-art: ${artifacts.size} generated artifacts are up to date.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
