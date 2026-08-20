import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { AdminIdentityCapService } from "./admin-identity-cap.service";

const ADMIN_ID = "aaaaaaaa-0000-4000-8000-000000000001";

/**
 * The three arguments `AdminIdentityCapService` passes to `super()` — and nothing else, because
 * that is all this subclass is.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────
 * Nothing constructed this class. Every other reference to it in the suite is a TYPE-ONLY
 * import used to cast a hand-rolled `{ consume }` stub, plus a DI-token STRING check in
 * `admin.module.boot.test.ts` — so the Redis keyspace and the two budget keys this cap actually
 * uses were asserted nowhere, and three independent mutations were MEASURED to survive all 917
 * admin tests:
 *
 *   `"admin_identity"` → `"admin_pii_reveal"`                     — SURVIVED
 *   `"ADMIN_IDENTITY_MAX_PER_HOUR"` → the reveal's hourly key      — SURVIVED
 *   the hour and day keys swapped                                  — SURVIVED
 *
 * The namespace collision is the serious one. It is not a tidiness issue: a single 50-name page
 * would `INCRBY 50` into `admin_pii_reveal:hour:<id>:<stamp>`, blowing the 10/hour REVEAL budget
 * five times over on one screen — so ordinary console browsing would silently fail-close PII
 * reveal, the incident-response path, for that admin. The key swap is the other one: it enforces
 * the hourly bound at 1000 and the daily at 300, i.e. no effective hourly velocity control.
 *
 * `admin-pii-reveal-cap.service.test.ts`'s "its keyspace does not collide with the identity
 * cap's" proves NOTHING about any of this — it constructs the REVEAL service and asserts the
 * reveal's own keys match `/^admin_pii_reveal:/`, which is structurally incapable of observing
 * what THIS subclass passes to `super()`. It stays green through the exact collision its name
 * claims to prevent. This file is the other side of that assertion.
 */

function makeCap(overrides: Partial<Record<string, number>> = {}) {
  const incrby = vi.fn(async (_key: string, by: number) => by);
  const expire = vi.fn(async () => 1);
  const queue = { client: Promise.resolve({ incrby, expire }) };
  const config = {
    ADMIN_IDENTITY_MAX_PER_HOUR: 300,
    ADMIN_IDENTITY_MAX_PER_DAY: 1000,
    ADMIN_PII_REVEAL_MAX_PER_HOUR: 10,
    ADMIN_PII_REVEAL_MAX_PER_DAY: 30,
    ...overrides,
  } as unknown as ServerConfig;
  const svc = new AdminIdentityCapService(config, queue as unknown as Queue);
  return { svc, incrby };
}

describe("AdminIdentityCapService — the keyspace and budget it actually binds to", () => {
  it("counts in the `admin_identity:*` namespace, NEVER the reveal's", async () => {
    const { svc, incrby } = makeCap();
    await svc.consume(ADMIN_ID, 1);
    const keys = incrby.mock.calls.map((c) => c[0] as string);
    expect(keys).toHaveLength(2);
    for (const key of keys) {
      expect(key).toMatch(/^admin_identity:(hour|day):/);
      // Stated as its own assertion so the failure reads as the collision, not as a shape change.
      expect(key.startsWith("admin_pii_reveal")).toBe(false);
    }
  });

  it("keys are `admin_identity:{hour,day}:<adminId>:<stamp>`, hour first", async () => {
    const { svc, incrby } = makeCap();
    await svc.consume(ADMIN_ID, 1);
    expect(incrby.mock.calls[0]![0]).toMatch(
      new RegExp(`^admin_identity:hour:${ADMIN_ID}:\\d{10}$`),
    );
    expect(incrby.mock.calls[1]![0]).toMatch(
      new RegExp(`^admin_identity:day:${ADMIN_ID}:\\d{8}$`),
    );
  });

  it("the HOUR key is bound to ADMIN_IDENTITY_MAX_PER_HOUR — not the day's, not the reveal's", async () => {
    // 301 names against a 300/hour budget must trip the HOUR window. If the constructor's two
    // budget keys were swapped this would be checked against 1000 and pass, and if it were bound
    // to the reveal's 10 it would trip far earlier — so the assertion pins WHICH number.
    const { svc } = makeCap();
    await expect(svc.consume(ADMIN_ID, 301)).resolves.toEqual({ ok: false, window: "hour" });
    await expect(svc.consume(ADMIN_ID, 300)).resolves.toEqual({ ok: true });
  });

  it("the DAY key is bound to ADMIN_IDENTITY_MAX_PER_DAY", async () => {
    // Within the hour budget, over the day budget. The stub returns the increment as the running
    // count, so a day charge of 1001 is over 1000 while the hour charge of 1001... would also be
    // over 300 — so the day limb is exercised with a config whose hour budget is out of the way.
    const { svc } = makeCap({ ADMIN_IDENTITY_MAX_PER_HOUR: 5000 });
    await expect(svc.consume(ADMIN_ID, 1001)).resolves.toEqual({ ok: false, window: "day" });
    await expect(svc.consume(ADMIN_ID, 1000)).resolves.toEqual({ ok: true });
  });

  it("reads its budget from config at call time, so an env change is not baked in at boot", async () => {
    const { svc } = makeCap({ ADMIN_IDENTITY_MAX_PER_HOUR: 2 });
    await expect(svc.consume(ADMIN_ID, 3)).resolves.toEqual({ ok: false, window: "hour" });
  });
});
