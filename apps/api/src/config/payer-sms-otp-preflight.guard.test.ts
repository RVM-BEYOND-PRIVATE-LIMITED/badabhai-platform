import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * #2754 — THE DEPLOY PREFLIGHT FOR COMPANY SMS SIGN-IN.
 *
 * #2816 made scripts/deploy/staging-deploy.sh refuse ANY armed PAYER_SMS_OTP_ENABLED, because a
 * company's phone was stored unproven. #2754 item 3 makes a phone a sign-in credential only once
 * the company has PROVED it (`payer_phone_proofs`, one account per proven phone), so the blanket
 * refusal is replaced by the cross-check the api's boot guard needs: armed ⇒ the company template's
 * DLT id (FAST2SMS_PAYER_DLT_TEMPLATE_ID) is set. A refused boot is an outage the deploy gate does
 * not roll back, so the script must stop before a container moves.
 *
 * The block is read from the script (comments stripped, so prose cannot satisfy it) and, where a
 * bash is on PATH (always in CI), executed against each combination.
 */
const SCRIPT = readFileSync(join(__dirname, "../../../../scripts/deploy/staging-deploy.sh"), "utf8")
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

const HEAD = 'case "${PAYER_SMS_OTP_ENABLED-}" in';
const start = SCRIPT.indexOf(HEAD);
/** The case statement alone, up to its OWN `esac`. */
const BLOCK =
  start < 0 ? "" : SCRIPT.slice(start, SCRIPT.indexOf("\nesac", start) + "\nesac".length);

const HAS_BASH = spawnSync("bash", ["-c", "exit 0"], { encoding: "utf8" }).status === 0;

/** Run the block with the given values; the variable `_bad_flags` is what the script exits on. */
function run(env: Record<string, string | undefined>): { bad: boolean; stdout: string } {
  const exports = Object.entries(env)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
    .join("\n");
  const r = spawnSync(
    "bash",
    [
      "-c",
      `set -e\nunset PAYER_SMS_OTP_ENABLED FAST2SMS_PAYER_DLT_TEMPLATE_ID\n${exports}\n_bad_flags=0\n${BLOCK}\necho "bad=$_bad_flags"`,
    ],
    { encoding: "utf8" },
  );
  expect(r.status, r.stderr).toBe(0);
  return { bad: /bad=1/.test(r.stdout), stdout: r.stdout };
}

describe("PAYER_SMS_OTP_ENABLED — the deploy preflight (#2754 item 3)", () => {
  it("carries the case block on the flag, and it fails the job through _bad_flags", () => {
    expect(BLOCK, "the preflight case on PAYER_SMS_OTP_ENABLED is missing or reshaped").not.toBe(
      "",
    );
    expect(BLOCK).toMatch(/true \| 1\)/);
    expect(BLOCK).toContain("FAST2SMS_PAYER_DLT_TEMPLATE_ID");
    expect(BLOCK).toMatch(/_bad_flags=1/);
  });

  it("no longer refuses every armed value (the #2816 blanket refusal is gone)", () => {
    expect(SCRIPT).not.toContain("must stay false until #2754 item 3");
  });

  it("never echoes the template id's value — only the names", () => {
    expect(BLOCK).not.toMatch(/echo[^\n]*\$\{?_payer_sms_template/);
    expect(BLOCK).not.toMatch(/echo[^\n]*\$\{?FAST2SMS_PAYER_DLT_TEMPLATE_ID/);
  });

  it("runs before anything moves (ahead of the GHCR logout trap and the first git pull)", () => {
    expect(start).toBeGreaterThan(0);
    expect(start).toBeLessThan(SCRIPT.indexOf("git pull origin main"));
  });

  describe.skipIf(!HAS_BASH)("executed", () => {
    it.each([
      [
        "armed (true), template set",
        { PAYER_SMS_OTP_ENABLED: "true", FAST2SMS_PAYER_DLT_TEMPLATE_ID: "1707000000000000001" },
        false,
      ],
      [
        "armed (1), template set",
        { PAYER_SMS_OTP_ENABLED: "1", FAST2SMS_PAYER_DLT_TEMPLATE_ID: "1707" },
        false,
      ],
      ["armed, template unset", { PAYER_SMS_OTP_ENABLED: "true" }, true],
      [
        "armed, template empty",
        { PAYER_SMS_OTP_ENABLED: "true", FAST2SMS_PAYER_DLT_TEMPLATE_ID: "" },
        true,
      ],
      [
        "armed, template whitespace",
        { PAYER_SMS_OTP_ENABLED: "1", FAST2SMS_PAYER_DLT_TEMPLATE_ID: "   " },
        true,
      ],
      ["off, template unset", { PAYER_SMS_OTP_ENABLED: "false" }, false],
      ["empty, template unset", { PAYER_SMS_OTP_ENABLED: "" }, false],
      ["unset entirely", {}, false],
    ] as const)("%s", (_label, env, refused) => {
      const out = run(env);
      expect(out.bad).toBe(refused);
      if (refused) expect(out.stdout).toContain("::error::PAYER_SMS_OTP_ENABLED is armed");
      expect(out.stdout).not.toContain("1707000000000000001");
    });
  });
});
