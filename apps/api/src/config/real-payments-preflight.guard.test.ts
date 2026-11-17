import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * #2749 part 5b — THE DEPLOY PREFLIGHT FOR REAL PAYMENTS.
 *
 * PAYMENTS_ENABLE_REAL and the three Razorpay values now reach the box from the GitHub
 * `production` environment secrets. The api refuses to boot with the flag on and any of the three
 * unset (assertPaymentsConfig), and a refused boot is an outage the deploy gate does not roll back,
 * so scripts/deploy/staging-deploy.sh must refuse that combination before a container moves. It
 * also refuses the flag as `1` (the api reads it as on, payer-web reads only `true`) and a key id
 * that is not `rzp_test_…` / `rzp_live_…` — and it must never print a value, only names.
 *
 * The block is read from the script (comments stripped, so prose cannot satisfy it) and, where a
 * bash is on PATH (always in CI), executed against each combination.
 */
const SCRIPT = readFileSync(join(__dirname, "../../../../scripts/deploy/staging-deploy.sh"), "utf8")
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

const HEAD = '_payments_key="${PAYMENTS_PROVIDER_KEY-}"';
const TAIL = '\n_payments_key=""';
const start = SCRIPT.indexOf(HEAD);
/** The payments block alone, from its first line to the line that clears the copied key. */
const BLOCK =
  start < 0 || SCRIPT.indexOf(TAIL, start) < 0
    ? ""
    : SCRIPT.slice(start, SCRIPT.indexOf(TAIL, start) + TAIL.length);

const HAS_BASH = spawnSync("bash", ["-c", "exit 0"], { encoding: "utf8" }).status === 0;

// Obviously fake values: none is, or could be mistaken for, a usable credential.
const TEST_KEY = "rzp_test_FAKEKEYID000";
const LIVE_KEY = "rzp_live_FAKEKEYID000";
const KEY_SECRET = "FAKE_KEY_SECRET_not_real";
const WEBHOOK_SECRET = "FAKE_WEBHOOK_SECRET_not_real";
const FAKE_VALUES = [TEST_KEY, LIVE_KEY, KEY_SECRET, WEBHOOK_SECRET, "FAKEKEYID000"];

const NAMES = ["PAYMENTS_PROVIDER_KEY", "PAYMENTS_PROVIDER_SECRET", "RAZORPAY_WEBHOOK_SECRET"];

type Env = Record<string, string | undefined>;

/**
 * Run the block with the given values; `_bad_flags` is what the script exits on. The values go in
 * through the process environment, exactly as the ssh action exports them, so a tab or a newline
 * inside one reaches bash as itself rather than as an escape sequence.
 */
function run(env: Env): { bad: boolean; stdout: string } {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ["PAYMENTS_ENABLE_REAL", "RETIRED_PRODUCTS_OFF_SALE", ...NAMES]) {
    delete base[name];
  }
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) base[name] = value;
  }
  const r = spawnSync("bash", ["-c", `set -e\n_bad_flags=0\n${BLOCK}\necho "bad=$_bad_flags"`], {
    encoding: "utf8",
    env: base,
  });
  expect(r.status, r.stderr).toBe(0);
  return { bad: /bad=1/.test(r.stdout), stdout: r.stdout };
}

/**
 * A complete, armable set: the three credentials, and the dropped products already off sale
 * (hardening 7 — they must be no later than real payments).
 */
const ALL_TEST: Env = {
  PAYMENTS_PROVIDER_KEY: TEST_KEY,
  PAYMENTS_PROVIDER_SECRET: KEY_SECRET,
  RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
  RETIRED_PRODUCTS_OFF_SALE: "true",
};
const ALL_LIVE: Env = { ...ALL_TEST, PAYMENTS_PROVIDER_KEY: LIVE_KEY };
/** What the bridge hands the box for an unset secret: the name, exported empty. */
const ALL_EMPTY: Env = {
  PAYMENTS_ENABLE_REAL: "",
  PAYMENTS_PROVIDER_KEY: "",
  PAYMENTS_PROVIDER_SECRET: "",
  RAZORPAY_WEBHOOK_SECRET: "",
};

describe("real payments — the deploy preflight (#2749 part 5b)", () => {
  it("carries the block, and it fails the job through _bad_flags", () => {
    expect(BLOCK, "the payments preflight is missing or reshaped").not.toBe("");
    expect(BLOCK).toContain('case "${PAYMENTS_ENABLE_REAL-}" in');
    for (const name of NAMES) expect(BLOCK).toContain(name);
    expect(BLOCK).toMatch(/_bad_flags=1/);
    expect(BLOCK).toMatch(/rzp_test_\?\* \| rzp_live_\?\*\)/);
    // Hardening 7: armed only with the dropped products off sale (true or 1, as the api reads it).
    expect(BLOCK).toMatch(/case "\$\{RETIRED_PRODUCTS_OFF_SALE-\}" in\n\s*true \| 1\) ;;/);
  });

  it("is checked before the job exits on _bad_flags", () => {
    const exitAt = SCRIPT.indexOf('if [ "$_bad_flags" -ne 0 ]; then');
    expect(exitAt).toBeGreaterThan(start);
  });

  it("never echoes a value — only names", () => {
    for (const line of BLOCK.split("\n").filter((l) => /\becho\b/.test(l))) {
      // `${_name}` and `${_missing_list}` are NAMES; any other expansion on an echo line could be
      // a value (the key copy, the loop's value, an indirect `${!…}`, or a secret by name).
      const expansions = [...line.matchAll(/\$\{?(!?[A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
      expect(
        expansions.filter((e) => e !== "_missing_list" && e !== "_name"),
        line,
      ).toEqual([]);
    }
  });

  it("runs before anything moves (ahead of the GHCR logout trap and the first git pull)", () => {
    expect(start).toBeGreaterThan(0);
    expect(start).toBeLessThan(SCRIPT.indexOf("git pull origin main"));
    for (const command of ["docker image prune", "$COMPOSE pull", "$COMPOSE up"]) {
      expect(SCRIPT.indexOf(command), `${command} runs before the preflight`).toBeGreaterThan(
        start,
      );
    }
  });

  it("PAYMENTS_ENABLE_REAL is also in the bridged-boolean grammar check", () => {
    const list = /^BRIDGED_BOOLEAN_FLAGS=\(\n([\s\S]*?)\n\)$/m.exec(SCRIPT)?.[1] ?? "";
    expect(list.split("\n").map((l) => l.trim())).toContain("PAYMENTS_ENABLE_REAL");
  });

  describe.skipIf(!HAS_BASH)("executed", () => {
    it.each([
      ["PRODUCTION TODAY: nothing set", {}],
      ["every secret exported empty (the bridge's unset)", ALL_EMPTY],
      ["flag false, nothing else", { PAYMENTS_ENABLE_REAL: "false" }],
      ["flag 0, nothing else", { PAYMENTS_ENABLE_REAL: "0" }],
      ["flag false, test credentials staged", { PAYMENTS_ENABLE_REAL: "false", ...ALL_TEST }],
      ["flag empty, live credentials staged", { ...ALL_EMPTY, ...ALL_LIVE }],
      [
        "flag false, only the key staged",
        { PAYMENTS_ENABLE_REAL: "false", PAYMENTS_PROVIDER_KEY: LIVE_KEY },
      ],
      [
        "flag false, a whitespace-only key (inert)",
        { PAYMENTS_ENABLE_REAL: "false", PAYMENTS_PROVIDER_KEY: "   " },
      ],
      [
        "flag false, products still on sale (today)",
        { PAYMENTS_ENABLE_REAL: "false", ...ALL_LIVE, RETIRED_PRODUCTS_OFF_SALE: "false" },
      ],
      [
        "flag empty, products off-sale switch empty (today)",
        { ...ALL_EMPTY, RETIRED_PRODUCTS_OFF_SALE: "" },
      ],
      ["flag true, the full live set", { PAYMENTS_ENABLE_REAL: "true", ...ALL_LIVE }],
      ["flag true, the full test set", { PAYMENTS_ENABLE_REAL: "true", ...ALL_TEST }],
      [
        "flag true, the full live set, products off sale as 1",
        { PAYMENTS_ENABLE_REAL: "true", ...ALL_LIVE, RETIRED_PRODUCTS_OFF_SALE: "1" },
      ],
    ] as const)("passes: %s", (_label, env) => {
      const out = run(env);
      expect(out.bad).toBe(false);
      expect(out.stdout).not.toContain("::error::");
      for (const value of FAKE_VALUES) expect(out.stdout).not.toContain(value);
    });

    it("armed with a test key warns (no value); armed with a live key does not", () => {
      const test = run({ PAYMENTS_ENABLE_REAL: "true", ...ALL_TEST });
      expect(test.stdout).toContain("::warning::Real payments are armed with a Razorpay TEST key");
      const live = run({ PAYMENTS_ENABLE_REAL: "true", ...ALL_LIVE });
      expect(live.stdout).not.toContain("::warning::");
      const off = run({ PAYMENTS_ENABLE_REAL: "false", ...ALL_TEST });
      expect(off.stdout).not.toContain("::warning::");
    });

    describe.each(NAMES)("flag true, %s missing", (name) => {
      it.each([
        ["unset", undefined],
        ["empty", ""],
        ["whitespace", "  \t "],
      ] as const)("%s → refused, naming it and only it", (_how, value) => {
        const out = run({ PAYMENTS_ENABLE_REAL: "true", ...ALL_LIVE, [name]: value });
        expect(out.bad).toBe(true);
        const error = out.stdout
          .split("\n")
          .find((l) => l.includes("::error::PAYMENTS_ENABLE_REAL"));
        expect(error, out.stdout).toBeDefined();
        for (const other of NAMES) {
          if (other === name) expect(error).toContain(other);
          else expect(error).not.toContain(other);
        }
        expect(out.stdout).toContain("Nothing was deployed.");
        for (const v of FAKE_VALUES) expect(out.stdout).not.toContain(v);
      });
    });

    it.each([
      ["unset", undefined],
      ["empty", ""],
      ["false", "false"],
      ["0", "0"],
    ] as const)(
      "hardening 7: flag true while RETIRED_PRODUCTS_OFF_SALE is %s → refused, naming both switches",
      (_how, offSale) => {
        for (const set of [ALL_LIVE, ALL_TEST]) {
          const out = run({
            PAYMENTS_ENABLE_REAL: "true",
            ...set,
            RETIRED_PRODUCTS_OFF_SALE: offSale,
          });
          expect(out.bad).toBe(true);
          const errors = out.stdout.split("\n").filter((l) => l.startsWith("::error::"));
          // Exactly this one refusal: the credentials are complete, the key is well formed.
          expect(errors, out.stdout).toHaveLength(1);
          expect(errors[0]).toContain(
            "::error::PAYMENTS_ENABLE_REAL is true but RETIRED_PRODUCTS_OFF_SALE is not",
          );
          expect(errors[0]).toContain("Nothing was deployed.");
          for (const v of FAKE_VALUES) expect(out.stdout).not.toContain(v);
        }
      },
    );

    it("hardening 7 is checked only when armed: flag false or empty never asks for it", () => {
      for (const flag of ["false", "0", ""]) {
        const out = run({ PAYMENTS_ENABLE_REAL: flag, ...ALL_LIVE, RETIRED_PRODUCTS_OFF_SALE: "" });
        expect(out.bad, `flag=${flag}`).toBe(false);
        expect(out.stdout).not.toContain("RETIRED_PRODUCTS_OFF_SALE");
      }
    });

    it("flag true with all three empty → refused once, naming all three", () => {
      const out = run({
        ...ALL_EMPTY,
        PAYMENTS_ENABLE_REAL: "true",
        RETIRED_PRODUCTS_OFF_SALE: "true",
      });
      expect(out.bad).toBe(true);
      expect(out.stdout).toContain(
        "::error::PAYMENTS_ENABLE_REAL is true but these production secrets are empty: PAYMENTS_PROVIDER_KEY,PAYMENTS_PROVIDER_SECRET,RAZORPAY_WEBHOOK_SECRET.",
      );
    });

    it("flag 1 → refused even with the full set (payer-web reads only true)", () => {
      const out = run({ PAYMENTS_ENABLE_REAL: "1", ...ALL_LIVE });
      expect(out.bad).toBe(true);
      expect(out.stdout).toContain(
        "::error::PAYMENTS_ENABLE_REAL must be exactly true, false or empty",
      );
      for (const v of FAKE_VALUES) expect(out.stdout).not.toContain(v);
    });

    const MALFORMED_KEYS = [
      ["the key secret pasted into the key slot", KEY_SECRET],
      ["a bare prefix", "rzp_live_"],
      ["a capitalised prefix", "RZP_LIVE_FAKEKEYID000"],
      ["a leading space", ` ${LIVE_KEY}`],
      ["a trailing newline", `${LIVE_KEY}\n`],
      ["an inner space", "rzp_live_FAKE KEYID000"],
    ] as const;

    it.each(MALFORMED_KEYS)(
      "a malformed key id (%s) with the flag true → refused, value never printed",
      (_label, key) => {
        const out = run({ PAYMENTS_ENABLE_REAL: "true", ...ALL_LIVE, PAYMENTS_PROVIDER_KEY: key });
        expect(out.bad).toBe(true);
        const errors = out.stdout.split("\n").filter((l) => l.startsWith("::error::"));
        expect(errors, out.stdout).toHaveLength(1);
        expect(errors[0]).toContain("::error::PAYMENTS_PROVIDER_KEY must be the Razorpay key ID");
        expect(errors[0]).toContain("Nothing was deployed.");
        expect(out.stdout).not.toContain("::warning::PAYMENTS_PROVIDER_KEY");
        for (const v of [...FAKE_VALUES, KEY_SECRET]) expect(out.stdout).not.toContain(v);
        expect(out.stdout).not.toContain("FAKE KEYID000");
      },
    );

    it.each(MALFORMED_KEYS)(
      "a malformed key id (%s) with the flag NOT true → a warning naming it, and the deploy goes on",
      (_label, key) => {
        // Nothing reads the key while real payments are off, so a bad paste must not block every
        // unrelated deploy; it is named once, so it is fixed before anyone arms the flag.
        for (const flag of ["false", "0", "", undefined]) {
          const out = run({ PAYMENTS_ENABLE_REAL: flag, ...ALL_LIVE, PAYMENTS_PROVIDER_KEY: key });
          expect(out.bad, `flag=${String(flag)}`).toBe(false);
          expect(out.stdout).not.toContain("::error::");
          const warnings = out.stdout
            .split("\n")
            .filter((l) => l.startsWith("::warning::PAYMENTS_PROVIDER_KEY"));
          expect(warnings, out.stdout).toHaveLength(1);
          expect(warnings[0]).toContain("is not a Razorpay key ID");
          for (const v of [...FAKE_VALUES, KEY_SECRET]) expect(out.stdout).not.toContain(v);
          expect(out.stdout).not.toContain("FAKE KEYID000");
        }
      },
    );

    it("a malformed key id with the flag 1 → refused (for the flag), the key only warned", () => {
      const out = run({
        PAYMENTS_ENABLE_REAL: "1",
        ...ALL_LIVE,
        PAYMENTS_PROVIDER_KEY: KEY_SECRET,
      });
      expect(out.bad).toBe(true);
      expect(out.stdout).toContain(
        "::error::PAYMENTS_ENABLE_REAL must be exactly true, false or empty",
      );
      expect(out.stdout).toContain("::warning::PAYMENTS_PROVIDER_KEY is not a Razorpay key ID");
      expect(out.stdout).not.toContain(KEY_SECRET);
    });
  });
});
