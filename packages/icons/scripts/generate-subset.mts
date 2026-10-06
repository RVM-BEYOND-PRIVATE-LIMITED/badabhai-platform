/**
 * Writes `phosphor-fill.subset.css` from the installed `@phosphor-icons/web` fill sheet and the
 * `IconName` union (#1893). Run after adding a glyph to `src/names.ts` or bumping the pin:
 *
 *   pnpm --filter @badabhai/icons generate:subset
 *
 * Plain Node (`--experimental-strip-types`, Node ≥ 22.6; CI never runs this file) — no build step and no extra dependency. The logic
 * lives in `src/subset.ts`, which `names.test.ts` also runs to prove the checked-in file is fresh.
 * Because Node runs `src/names.ts` and `src/subset.ts` natively here, both must stay
 * erasable-only TypeScript (no enum / namespace) with explicit-extension relative imports.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_ICON_NAMES } from "../src/names.ts";
import { SUBSET_FILE, buildSubsetCss } from "../src/subset.ts";

const require = createRequire(import.meta.url);
const fillCss = readFileSync(require.resolve("@phosphor-icons/web/fill"), "utf8");
const out = join(dirname(fileURLToPath(import.meta.url)), "..", SUBSET_FILE);

writeFileSync(out, buildSubsetCss(fillCss, ALL_ICON_NAMES));
console.log(`wrote ${out} (${ALL_ICON_NAMES.length} glyphs)`);
