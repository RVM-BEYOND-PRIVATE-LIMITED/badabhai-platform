import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The event envelope's `correlation_id` must be a UUID: `createEvent` throws on anything else, and
 * inside a transaction that throw rolls the whole state change back. #2750's e2e found three
 * sweeps/webhooks building `correlationId: \`<prefix>:${id}\``: every deadline close of the
 * couldn't-reach desk, every Managed Hiring deadline step and every Razorpay refund webhook
 * update failed and retried forever, while their unit tests (fake EventsService) passed.
 *
 * This fails the build on a correlation id written as a string or template literal in app code. A
 * fixed UUID literal (a test fake) is allowed. Use the request's `ctx.correlationId` or
 * `randomUUID()`.
 */
const SRC = join(__dirname, "..");
const LITERAL = /correlation(?:Id|_id)\s*:\s*([`"'])((?:(?!\1).)*)\1/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      // Test harnesses (fakes, replay worlds) are not app code.
      if (name !== "testing") out.push(...sources(path));
    } else if (
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".d.ts") &&
      !name.includes(".test-support.")
    ) {
      out.push(path);
    }
  }
  return out;
}

describe("event correlation ids are UUIDs", () => {
  it("no app code sets a correlation id from a non-UUID string or template literal", () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(LITERAL)) {
        if (m[1] === "`" || !UUID.test(m[2]!)) {
          const line = text.slice(0, m.index).split("\n").length;
          offenders.push(`${relative(SRC, file)}:${line}  ${m[0]}`);
        }
      }
    }
    expect(offenders, "use ctx.correlationId or randomUUID() — the envelope refuses anything else").toEqual([]);
  });

  it("the pattern catches the shapes that broke (#2750)", () => {
    const bad = [
      "correlationId: `reach-deadline:${id}`,",
      "correlationId: `managed-hiring-sweep:${row.id}`,",
      'correlationId: "nightly-sweep",',
    ];
    for (const sample of bad) {
      const m = [...sample.matchAll(LITERAL)][0]!;
      expect(m[1] === "`" || !UUID.test(m[2]!)).toBe(true);
    }
    const ok = [...'correlationId: "33333333-3333-4333-8333-333333333333"'.matchAll(LITERAL)][0]!;
    expect(ok[1] === "`" || !UUID.test(ok[2]!)).toBe(false);
  });
});
