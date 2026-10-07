import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  earlierPurchaseMessage,
  OPTION_CHANGED_MESSAGE,
  priceChangedMessage,
} from "./purchase-messages";

/**
 * #2085 — the payer-facing purchase copy, and the fence that keeps it schema-free.
 *
 * The panels render these messages in the BROWSER. The boundary's zod schema lives in
 * `price-confirmation.ts` (Server Actions only), so a client module must never import that file,
 * and the message module must never import zod — or the schema rides into a client bundle just to
 * format a sentence.
 */

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** Every .ts/.tsx source file under src/ (tests excluded). */
function sources(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, acc);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) acc.push(p);
  }
  return acc;
}

describe("purchase messages — the copy every purchase surface shows", () => {
  it("a refused price names the API's current price, or asks to review when it carried none", () => {
    expect(priceChangedMessage(2400)).toBe("The price changed to ₹2,400. Review and confirm again.");
    expect(priceChangedMessage(null)).toBe(
      "The price changed. Review the new price and confirm again.",
    );
  });

  it("a held key names the price the earlier purchase was confirmed at", () => {
    expect(earlierPurchaseMessage(1000)).toBe(
      "An earlier purchase at ₹1,000 may still be processing — check back in a moment.",
    );
  });

  it("a changed option asks for a fresh confirm", () => {
    expect(OPTION_CHANGED_MESSAGE).toBe("This option changed — review and confirm again.");
  });
});

describe("purchase messages — zod stays out of the client modules (fence)", () => {
  it("the message module imports no zod", () => {
    const src = readFileSync(join(SRC, "lib", "purchase-messages.ts"), "utf8");
    expect(src).not.toContain('from "zod"');
    expect(src).not.toContain('price-confirmation"'); // as an import specifier
  });

  it("no 'use client' module imports the zod-bearing price-confirmation module", () => {
    const clients = sources(SRC).filter((p) =>
      readFileSync(p, "utf8").trimStart().startsWith('"use client"'),
    );
    expect(clients.length).toBeGreaterThan(0); // the fence actually looked at something
    const offenders = clients.filter((p) =>
      readFileSync(p, "utf8").includes('/price-confirmation"'),
    );
    expect(offenders).toEqual([]);
  });
});
