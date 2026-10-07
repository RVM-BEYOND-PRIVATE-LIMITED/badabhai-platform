import { describe, expect, it } from "vitest";
import { DEMO_PHONE_PATTERN, hashPhone, isDemoWorkerPhone } from "@badabhai/db";
import { AdminEngineDemoGate, demoBlockPhones } from "./admin-engine-demo-gate";

const PEPPER = "p".repeat(48);
const pii = { hashPhone: (phone: string) => hashPhone(phone, PEPPER) };
const gate = (
  allow: string[] = [],
  workers: unknown = { findLiveIdsByPhoneHashes: async () => [] },
) =>
  new AdminEngineDemoGate(
    { ADMIN_ENGINE_VIEW_ALLOW_PHONES: allow } as never,
    pii as never,
    workers as never,
  );

describe("AdminEngineDemoGate — the Engine view shows demo workers only (owner ruling 2026-10-06)", () => {
  it("covers exactly the reserved demo block +910000026000…999", () => {
    const phones = demoBlockPhones();
    expect(phones).toHaveLength(1000);
    expect(phones[0]).toBe("+910000026000");
    expect(phones[999]).toBe("+910000026999");
    // The demo seed's first persona (#2013 `demoPhone(0)`) is inside the block.
    expect(phones).toContain("+910000026001");
    for (const p of phones) expect(p).toMatch(/^\+910000026\d{3}$/);
  });

  it("enumerates EXACTLY the shared demo block — the one definition in @badabhai/db (#2013)", () => {
    const phones = demoBlockPhones();
    // Every enumerated phone is a demo phone by the shared definition…
    for (const p of phones) {
      expect(DEMO_PHONE_PATTERN.test(p)).toBe(true);
      expect(isDemoWorkerPhone(p)).toBe(true);
    }
    // …no two are the same, and the pattern admits nothing the enumeration missed: it is
    // `prefix + exactly three digits`, so 1,000 distinct matches is the whole of it.
    expect(new Set(phones).size).toBe(1000);
    expect(DEMO_PHONE_PATTERN.test("+9100000261000")).toBe(false);
    expect(DEMO_PHONE_PATTERN.test("+91000002600")).toBe(false);
    expect(DEMO_PHONE_PATTERN.test("+910000019844")).toBe(false);
  });

  it("a demo worker's hash is in the set; a real worker's is not", () => {
    const hashes = new Set(gate().demoPhoneHashes());
    expect(hashes.has(hashPhone("+910000026001", PEPPER))).toBe(true);
    expect(hashes.has(hashPhone("+919876543210", PEPPER))).toBe(false);
    // Neighbouring reserved blocks (the E4 fixture, the smoke worker) are NOT demo workers.
    expect(hashes.has(hashPhone("+910000019844", PEPPER))).toBe(false);
    expect(hashes.has(hashPhone("+910000000000", PEPPER))).toBe(false);
  });

  it("an allow-listed handset is added, and nothing else", () => {
    const hashes = gate(["+919812345678"]).demoPhoneHashes();
    expect(hashes).toHaveLength(1001);
    expect(hashes).toContain(hashPhone("+919812345678", PEPPER));
    expect(hashes).not.toContain(hashPhone("+919812345679", PEPPER));
  });

  it("hashes with the SERVER pepper, so a different pepper matches nobody", () => {
    expect(gate().demoPhoneHashes()).not.toContain(hashPhone("+910000026001", "other".repeat(10)));
  });

  it("resolves demo worker ids through the workers domain, by the full hash set", async () => {
    const seen: string[][] = [];
    const g = gate([], {
      findLiveIdsByPhoneHashes: async (h: readonly string[]) => {
        seen.push([...h]);
        return ["w-demo"];
      },
    });
    expect(await g.demoWorkerIds()).toEqual(["w-demo"]);
    expect(seen[0]).toHaveLength(1000);
  });

  it("fails closed: no live demo worker means an empty id list, never 'everyone'", async () => {
    expect(await gate().demoWorkerIds()).toEqual([]);
  });
});
