import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STAGING_COMPOSE_PATH, environmentOfFile } from "../common/testing/compose-env";

/**
 * THE DEPLOYED BOX MUST BE ABLE TO CHOOSE THE MODEL — AND THE INR CEILINGS THAT BOUND IT (#1237).
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────
 * #1237 asks which model tier the chat turn should run on, and states the ids are "fully
 * env-overridable — no call site hardcodes a model". True of `apps/ai-service/app/config.py`,
 * and false of the deployment: none of the three model ids nor any of the four INR ceilings was
 * declared in EITHER compose file, so `export DEFAULT_CAPABLE_MODEL=…` on the box had no path
 * into the ai-service container and the pydantic default shipped regardless. The ceilings are
 * the worse half — the issue's own advice is to re-size them when raising the tier, and that
 * advice was inert.
 *
 * Same failure class as `WORKER_PHOTOS_BUCKET` (#794), `CHAT_LLM_INTERVIEW_ENABLED` (#798),
 * `ZEPTOMAIL_API_URL` (#813) and `WORKER_FEEDBACK_ATTACHMENTS_BUCKET` (#1191), and the same
 * remedy: a parser, not a review habit.
 *
 * ── WHY THESE ARE RESTATED AND NOT BARE `${VAR:-}` ──────────────────────────────────────
 * This is the one thing about this block that is easy to get wrong, and it is why the test
 * asserts the DEFAULT and not merely the presence of the name. Every name here is a
 * non-optional pydantic field carrying a real default, so a bare `${VAR:-}` hands the container
 * an EMPTY STRING rather than leaving the field unset:
 *
 *   - the four model ids resolve every real call to `""` — no transport, every task degrades
 *     to mock, and nothing in the logs names the cause;
 *   - the four `float` ceilings raise a VALIDATION ERROR AT BOOT — the identical shape that
 *     crash-looped the api on 2026-08-25 (#1221, `positiveIntFromString`);
 *   - `AI_CHAT_MODEL_TIER` is the mildest of the three (an empty tier fails soft to the route's
 *     shape default) and is still asserted, because "this one happens to survive" is not a
 *     property worth relying on when the rule for its four neighbours is the opposite.
 *
 * `SARVAM_TTS_MODEL` in the same block already carries this rule for the same reason.
 *
 * ── AND RESTATING CREATES A SECOND SOURCE OF TRUTH, WHICH IS WHAT THE LAST TEST IS FOR ──
 * A literal in compose that must equal a default in `config.py` is exactly the kind of pair
 * that drifts silently — and drifts in the dangerous direction, because compose WINS. So the
 * equality is machine-checked against the field defaults parsed straight out of `config.py`.
 */
const MODEL_VARS = [
  "DEFAULT_CAPABLE_MODEL",
  "DEFAULT_CHEAP_MODEL",
  "DEFAULT_PRO_MODEL",
  "DEFAULT_FALLBACK_MODEL",
] as const;

/**
 * Not a model id — the TIER SELECTOR for the chat turn, which is the A/B lever this change
 * exists to make usable (`AI_CHAT_MODEL_TIER=capable` puts chat back on flash from the box, no
 * deploy). Kept out of MODEL_VARS because its value is a tier name and would never appear in
 * the INR rate table; it still needs the declared + restated + no-drift guarantees.
 */
const TIER_VARS = ["AI_CHAT_MODEL_TIER"] as const;

const COST_CEILING_VARS = [
  "AI_MAX_CALL_COST_INR",
  "AI_MAX_DAILY_COST_INR",
  "AI_MAX_USER_DAILY_COST_INR",
  "AI_MAX_TOTAL_COST_INR",
] as const;

/** `apps/api/src/config/` → repo root is five levels up. */
const AI_SERVICE_CONFIG = join(__dirname, "../../../..", "apps/ai-service/app/config.py");

/**
 * The committed in-code default of one `Settings` field, read from the `config.py` SOURCE.
 *
 * Deliberately a regex over the file rather than anything that imports Python: this suite is
 * node/vitest and the ai-service is a separate runtime, so the only thing available to compare
 * against is the text. Narrow on purpose — it matches the exact field-definition shape
 * (`name: str = "value"` / `name: float = 10.0`) and returns null otherwise, so a config.py
 * refactor that changes that shape FAILS the test rather than silently matching nothing.
 */
function pythonFieldDefault(source: string, field: string): string | null {
  // A fixed prefix + a HARDCODED regex, rather than interpolating `field` into a `new RegExp`.
  // The values are compile-time constants from the arrays above, so a dynamic pattern was never
  // a real ReDoS risk — but semgrep's detect-non-literal-regexp blocks on the shape rather than
  // the provenance, and a `nosemgrep` suppression would be a standing claim a later editor has
  // to re-verify. Not building the regex at all is cheaper than justifying it.
  //
  // Exactly four spaces: `Settings` fields sit at one level of class indentation, so this cannot
  // accidentally match a more deeply nested assignment that happens to share a name.
  const prefix = `    ${field}:`;
  for (const line of source.split(/\r?\n/)) {
    if (!line.startsWith(prefix)) continue;
    const m = /^(?:str|float|int)\s*=\s*(.+?)\s*$/.exec(line.slice(prefix.length).trim());
    // A matched field whose SHAPE changed (a `Field(...)` wrapper, a new annotation) returns
    // null rather than a wrong value, so a config.py refactor fails the guard loudly.
    return m ? m[1]!.replace(/^["']|["']$/g, "") : null;
  }
  return null;
}

/** The literal a `${VAR:-default}` entry falls back to, or null if it is a bare pass-through. */
function composeDefault(entry: string | undefined): string | null {
  if (entry === undefined) return null;
  const m = /^\$\{[A-Z_][A-Z0-9_]*:-(.*)\}$/.exec(entry.replace(/^"|"$/g, ""));
  return m ? m[1]! : null;
}

describe("docker-compose.staging.yml — ai-service model routing is settable from the box (#1237)", () => {
  const ai = environmentOfFile(STAGING_COMPOSE_PATH, "ai-service");
  const configPy = readFileSync(AI_SERVICE_CONFIG, "utf8");

  it("parses the ai-service environment (guards the parser, not the rule)", () => {
    // Without this canary every assertion below could pass vacuously on a parser that found
    // nothing. A long-stable literal from this service, unrelated to model routing.
    expect(ai.get("GEMINI_FLASH_API_KEY")).toBe("${GEMINI_FLASH_API_KEY:-}");
  });

  it("reads config.py at all (guards the OTHER parser)", () => {
    // Same reason, other side: if the regex or the path silently found nothing, the drift test
    // would compare null to null and pass while asserting nothing.
    expect(pythonFieldDefault(configPy, "default_cheap_model")).toBeTruthy();
  });

  it.each([...MODEL_VARS, ...TIER_VARS, ...COST_CEILING_VARS])("%s is declared on the ai-service", (name) => {
    expect(ai.has(name), `${name} missing from the ai-service — the box cannot set it`).toBe(true);
  });

  it.each([...MODEL_VARS, ...TIER_VARS, ...COST_CEILING_VARS])(
    "%s carries a RESTATED default — a bare `${VAR:-}` would inject an empty string",
    (name) => {
      expect(
        composeDefault(ai.get(name)),
        `${name} must be \${${name}:-<default>}, never a bare pass-through: empty is not "unset" ` +
          `to pydantic — the model ids resolve to "" (silent mock) and the float ceilings fail boot`,
      ).not.toBeNull();
    },
  );

  it.each([...MODEL_VARS, ...TIER_VARS])("%s matches the committed config.py default (drift guard)", (name) => {
    // The whole cost of restating. Compose WINS over the library default, so a drifted literal
    // here does not error — it quietly ships a different model than config.py claims.
    const field = name.toLowerCase();
    expect(composeDefault(ai.get(name))).toBe(pythonFieldDefault(configPy, field));
  });

  it.each(COST_CEILING_VARS)("%s matches the committed config.py default (drift guard)", (name) => {
    const field = name.toLowerCase();
    // Compared as NUMBERS: compose must carry a parseable float, and `10.0` and `10` are the
    // same ceiling. Anything unparseable on either side is a boot failure waiting to happen.
    const composed = Number(composeDefault(ai.get(name)));
    const source = Number(pythonFieldDefault(configPy, field));
    expect(Number.isFinite(composed), `${name} in compose is not a number`).toBe(true);
    expect(Number.isFinite(source), `${field} in config.py is not a number`).toBe(true);
    expect(composed).toBe(source);
  });

  it("every routed model default is PRICED in the INR rate table", () => {
    // The ceilings are computed from an ESTIMATE, and an unpriced model falls back to
    // `_DEFAULT_RATE_INR`. That under-reads every model above the flash tier, so the caps stop
    // tripping and the failure is silent OVERSPEND rather than the fall-to-mock an over-estimate
    // would cause. Adding a model id to a tier default without a rate row is the mistake this
    // catches — it is the exact gap #1237 warned about, in the opposite direction to its warning.
    const rates = readFileSync(
      join(__dirname, "../../../..", "apps/ai-service/app/ai/model_config.py"),
      "utf8",
    );
    for (const name of MODEL_VARS) {
      const model = pythonFieldDefault(configPy, name.toLowerCase());
      expect(model, `${name} has no readable default in config.py`).toBeTruthy();
      expect(
        rates.includes(`"${model}":`),
        `${model} is a shipped tier default with no _MODEL_RATES_INR row — the spend guardrails ` +
          `would silently under-read it`,
      ).toBe(true);
    }
  });
});
