import type { ResumeSkin } from "@badabhai/types";

import { getResumeTemplate } from "./templates/registry";

/**
 * RÉSUMÉ SKINS (#1801) — how a skin reaches the page.
 *
 * A SKIN IS A SET OF COLOUR TOKENS, NOT A TEMPLATE (`templates/README.md`, "Skins"): the
 * `bb_trade` stylesheet reads every colour from custom properties in its single `:root` block, so
 * a skin is a replacement VALUE for each of those properties and nothing else — no markup, no new
 * template id, and no edit to a shipped `<id>.v<n>.html` file (immutable by the registry
 * contract). The swap happens on the in-memory copy of the skeleton, per render.
 *
 * VALUES ONLY, IN PLACE. Each declaration line keeps its indentation, its separator and anything
 * after its `;` (a comment), and only the value between is replaced. That is what makes the house
 * skin a byte-for-byte no-op: Neela's values ARE the shipped `:root` values, so a render with
 * `skin: "neela"` is identical to a render with no skin at all — pinned by the renderer tests.
 *
 * COLOURS ONLY. `--rule-w` / `--hair-w` are printing FLOORS (0.5pt, below which gate-desk printers
 * drop the line), not a matter of taste, so no skin may move them and they are not skin tokens.
 *
 * ONLY NEELA, by owner ruling (2026-09-28, "Plumbing, Neela only"). Saada, Kaagaz and Loha have no
 * approved tokens and must not be invented here: a skin joins `RESUME_SKINS` together with its
 * reviewed block below (which must pass the greyscale/photocopy floors), a migration widening
 * `wrs_skin_chk`, and a new `resume.skin_changed` version.
 */

/** Every custom property a skin sets on the `bb_trade` `:root`, in the template's own order. */
export const RESUME_SKIN_TOKEN_NAMES = [
  "--navy",
  "--ink",
  "--muted",
  "--chip-bg",
  "--chip-ink",
  "--rule",
  "--bar-bg",
  "--bar-ink",
  "--paper",
] as const;
export type ResumeSkinToken = (typeof RESUME_SKIN_TOKEN_NAMES)[number];

/**
 * The token block of every skin in `RESUME_SKINS`. `satisfies Record<ResumeSkin, …>` makes a skin
 * added to the vocabulary without its block a COMPILE error, never a runtime surprise.
 */
export const RESUME_SKIN_TOKENS = {
  // THE HOUSE STYLE — navy bar, navy section labels, light filled chips. Exactly the values
  // `bb_trade.v1.html` / `bb_trade.v2.html` shipped with (pinned against the files by test).
  neela: {
    "--navy": "#0f3d6e",
    "--ink": "#14181d",
    "--muted": "#3a424b",
    "--chip-bg": "#bcd2ea",
    "--chip-ink": "#0f3d6e",
    "--rule": "#0f3d6e",
    "--bar-bg": "#0f3d6e",
    "--bar-ink": "#ffffff",
    "--paper": "#ffffff",
  },
} as const satisfies Record<ResumeSkin, Readonly<Record<ResumeSkinToken, string>>>;

/**
 * The templates a skin applies to — `bb_trade` ONLY (owner ruling 2026-09-28). `bb_general`, the
 * legacy `classic` / `modern` / `minimal` layouts and the fallback print as they always have,
 * whatever the worker chose.
 */
const SKINNABLE_TEMPLATE_IDS: ReadonlySet<string> = new Set(["bb_trade"]);

/**
 * Does a render under `templateId` take a skin? Resolved through the registry exactly as the
 * renderer resolves it, so an unknown id (which renders the fallback) never counts as skinnable.
 */
export function templateTakesSkin(templateId: string | null | undefined): boolean {
  return SKINNABLE_TEMPLATE_IDS.has(getResumeTemplate(templateId).id);
}

/** A skeleton the skin cannot be applied to cleanly. Thrown, never degraded to a half-skinned sheet. */
export class ResumeSkinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeSkinError";
  }
}

const ROOT_OPEN = ":root {";

/**
 * One declaration line: indent, `--name`, separator, value, then `;` and whatever follows it on the
 * line (a trailing comment, a `\r`). A literal — never built from a token name (semgrep
 * `detect-non-literal-regexp`); the name is captured and compared with `===`.
 */
const DECLARATION_RE = /^(\s*)(--[a-z0-9-]+)(\s*:\s*)([^;\n]*)(;[^\n]*)$/;

/**
 * Return `skeleton` with its single `:root` block re-valued to `skin`. Everything outside the
 * block, and every line inside it that is not a skin token, is returned byte-for-byte.
 *
 * FAILS CLOSED: a skeleton with no `:root` block, more than one, or a block missing any skin token
 * throws {@link ResumeSkinError} rather than printing a sheet that is part one skin, part another.
 * The render processor already turns a throw from the renderer into "no PDF this run", which keeps
 * an existing PDF in service. Unreachable for `bb_trade.v2` — pinned by test for every skin.
 *
 * The messages carry constants only (never HTML, never worker data).
 */
export function applyResumeSkin(skeleton: string, skin: ResumeSkin): string {
  const open = skeleton.indexOf(ROOT_OPEN);
  if (open < 0) throw new ResumeSkinError("template has no :root token block");
  if (skeleton.indexOf(ROOT_OPEN, open + ROOT_OPEN.length) >= 0) {
    throw new ResumeSkinError("template has more than one :root token block");
  }
  const close = skeleton.indexOf("}", open);
  if (close < 0) throw new ResumeSkinError("template :root token block is not closed");

  const tokens: Readonly<Record<string, string>> = RESUME_SKIN_TOKENS[skin];
  const seen = new Set<string>();
  const block = skeleton
    .slice(open, close)
    .split("\n")
    .map((line) => {
      const m = DECLARATION_RE.exec(line);
      if (!m) return line;
      const [, indent, name, separator, , rest] = m as unknown as [
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      const value = tokens[name];
      if (value === undefined) return line;
      seen.add(name);
      return `${indent}${name}${separator}${value}${rest}`;
    })
    .join("\n");

  for (const name of RESUME_SKIN_TOKEN_NAMES) {
    if (!seen.has(name)) {
      throw new ResumeSkinError(`template :root token block does not declare ${name}`);
    }
  }
  return skeleton.slice(0, open) + block + skeleton.slice(close);
}
