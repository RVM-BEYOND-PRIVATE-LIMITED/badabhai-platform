import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { DevicesRepository } from "./devices.repository";

/**
 * ADR-0034 D5b.1 + D5b.2 — the two REPOSITORY-level push-token rules, pinned against the
 * actual write payloads. DB-free: we capture Drizzle's `.values()` / `.set()` objects the
 * same way pin.repository.test.ts does.
 *
 * WHY THIS FILE EXISTS: push-security.regression.test.ts pins the SERVICE contract and
 * asserted that "the repository-level SQL is exercised by the integration suite" — it is
 * not. `registerOrTouch` appears in tests only as a `vi.fn()` mock, so both rules below
 * could regress with every suite green. They are the feature's load-bearing rules:
 *
 *   (a) A login that carries NO token must LEAVE a stored token alone. The shipped client
 *       omits push_token on login, so a blind `pushToken: input.pushToken ?? null` nulls a
 *       good token on the very next login — push works once, then dies silently.
 *   (b) A login that DOES carry a token must CLAIM it exclusively, on the touch path as
 *       well as the insert path. Two workers who have both logged in on one handset hold
 *       two rows (unique key = worker_id + device_hash); without the claim, the returning
 *       worker takes the token while the other row still holds it, and that worker's
 *       device_registered / logged_out_all alerts fire at a handset they no longer have.
 */

const WORKER = "11111111-1111-4111-8111-111111111111";
const EXISTING_ROW_ID = "22222222-2222-4222-8222-222222222222";
const TOKEN = "fcm-token-abc";

/** Captures the insert `.values()` and update `.set()` payloads; forces the TOUCH path. */
function makeDb() {
  const captured: { values?: Record<string, unknown>; set?: Record<string, unknown> } = {};

  const insertChain = {
    values(payload: Record<string, unknown>) {
      captured.values = payload;
      return {
        // Empty array => "lost the insert race / row already existed" => TOUCH path.
        onConflictDoNothing: () => ({ returning: () => Promise.resolve([]) }),
      };
    },
  };

  const updateChain = {
    set(payload: Record<string, unknown>) {
      captured.set = payload;
      return {
        where: () => ({
          returning: () => Promise.resolve([{ id: EXISTING_ROW_ID, workerId: WORKER }]),
        }),
      };
    },
  };

  const db = { insert: vi.fn(() => insertChain), update: vi.fn(() => updateChain) };
  return { db, captured };
}

const baseInput = {
  workerId: WORKER,
  deviceHash: "hash-1",
  platform: "android" as const,
  model: "Pixel",
  appVersion: "1.0.0",
};

describe("DevicesRepository.registerOrTouch — push-token rules (ADR-0034 D5b)", () => {
  it("(a) a login carrying NO token does not write push_token at all — a stored token survives", async () => {
    const { db, captured } = makeDb();
    const repo = new DevicesRepository(db as never);
    const claim = vi.spyOn(repo, "claimPushToken").mockResolvedValue(undefined as never);

    await repo.registerOrTouch({ ...baseInput });

    // The key must be ABSENT, not null. `pushToken: null` would clear a good token; the
    // spread-an-empty-object shape is what makes omission a no-op.
    expect(captured.set, "the touch path must issue an update .set(...)").toBeDefined();
    expect(Object.keys(captured.set!)).not.toContain("pushToken");
    expect(Object.keys(captured.set!)).not.toContain("pushTarget");
    // Nothing to claim when nothing was registered.
    expect(claim).not.toHaveBeenCalled();
  });

  it("(b) a login carrying a token writes it AND claims it exclusively — on the TOUCH path", async () => {
    const { db, captured } = makeDb();
    const repo = new DevicesRepository(db as never);
    const claim = vi.spyOn(repo, "claimPushToken").mockResolvedValue(undefined as never);

    await repo.registerOrTouch({ ...baseInput, pushToken: TOKEN });

    expect(captured.set?.pushToken).toBe(TOKEN);
    // push_target rotates whenever a NEW token is registered.
    expect(captured.set?.pushTarget).toEqual(expect.any(String));
    // THE REGRESSION: the claim used to run only in the insert branch, so a returning
    // worker took the token without nulling it on the other worker's row.
    expect(claim, "the touch path must claim the token exclusively").toHaveBeenCalledWith(
      TOKEN,
      EXISTING_ROW_ID,
    );
  });

  it("an empty-string token counts as NO token — it must not clear a stored one", async () => {
    const { db, captured } = makeDb();
    const repo = new DevicesRepository(db as never);
    const claim = vi.spyOn(repo, "claimPushToken").mockResolvedValue(undefined as never);

    await repo.registerOrTouch({ ...baseInput, pushToken: "" });

    expect(Object.keys(captured.set!)).not.toContain("pushToken");
    expect(claim).not.toHaveBeenCalled();
  });
});
