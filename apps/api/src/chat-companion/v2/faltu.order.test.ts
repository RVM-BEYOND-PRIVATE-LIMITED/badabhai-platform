import { describe, expect, it } from "vitest";
import { V2_FALTU_COOLDOWN } from "../companion-replies";
import { CTX, makeCompanionServiceForV2, NOW, WORKER } from "../chat-companion.v2.fake";

/**
 * ADR-0046 P2 §2 — THE ORDERING, asserted where it lives: chip keys → cool-down → v1 text
 * resolver → lexicon → classifier. The orchestrator is faked here, so each step's participation
 * is visible: the gate must see free text BEFORE v1, must never see a chip tap, and must not
 * exist at all while its flag is off.
 */
const COOLING_UNTIL = "2026-09-26T10:30:00.000Z";

describe("faltu ordering (ADR-0046 P2)", () => {
  it("blocks FREE TEXT during the cool-down — even text v1 would have answered", async () => {
    const h = makeCompanionServiceForV2({ v2: true, faltu: true, cooling: COOLING_UNTIL });
    const out = await h.svc.message(WORKER, { text: "phir se jobs dikhao" }, CTX as never, NOW);

    expect(h.v2.cooldownUntil).toHaveBeenCalledWith(WORKER, NOW);
    expect(h.v2.handleCooldown).toHaveBeenCalledWith(
      WORKER,
      { text: "phir se jobs dikhao" },
      CTX,
      NOW,
      COOLING_UNTIL,
    );
    // v1 never ran: the cool-down line carries the instant the composer may reopen.
    expect(h.jobs.searchOpenPostings).not.toHaveBeenCalled();
    if (out.mode !== "companion") throw new Error("expected companion");
    expect(out.turn.reply).toBe(V2_FALTU_COOLDOWN.latin);
    expect(out.turn.cooldown_until).toBe(COOLING_UNTIL);
  });

  it("serves a V1 chip tap during the cool-down — the résumé and jobs stay reachable", async () => {
    const h = makeCompanionServiceForV2({ v2: true, faltu: true, cooling: COOLING_UNTIL });
    const out = await h.svc.message(WORKER, { text: "companion_new_jobs" }, CTX as never, NOW);

    // The gate is not even consulted for an exact chip tap...
    expect(h.v2.cooldownUntil).not.toHaveBeenCalled();
    expect(h.v2.handleCooldown).not.toHaveBeenCalled();
    // ...and v1 answers it as it always has.
    expect(h.jobs.searchOpenPostings).toHaveBeenCalled();
    if (out.mode !== "companion") throw new Error("expected companion");
    expect(out.turn.reply).not.toBe(V2_FALTU_COOLDOWN.latin);
  });

  it("serves a TASK chip tap during the cool-down — routed deterministically, no model needed", async () => {
    const h = makeCompanionServiceForV2({ v2: true, faltu: true, cooling: COOLING_UNTIL });
    await h.svc.message(WORKER, { text: "Naya resume" }, CTX as never, NOW);

    expect(h.v2.cooldownUntil).not.toHaveBeenCalled();
    expect(h.v2.handleCooldown).not.toHaveBeenCalled();
    expect(h.v2.handleTaskChip).toHaveBeenCalledWith(
      WORKER,
      expect.anything(),
      { text: "Naya resume" },
      "new_resume",
      CTX,
      NOW,
    );
  });

  it("a task chip routes even when no cool-down exists — the classifier is not consulted", async () => {
    const h = makeCompanionServiceForV2({ v2: true, faltu: true, cooling: null });
    await h.svc.message(WORKER, { text: "companion_task:edit_resume" }, CTX as never, NOW);

    expect(h.v2.handleTaskChip).toHaveBeenCalledWith(
      WORKER,
      expect.anything(),
      { text: "companion_task:edit_resume" },
      "edit_resume",
      CTX,
      NOW,
    );
    expect(h.v2.handleMessage).not.toHaveBeenCalled();
  });

  it("no cool-down → the normal flow, the gate consulted but idle", async () => {
    const h = makeCompanionServiceForV2({ v2: true, faltu: true, cooling: null });
    await h.svc.message(WORKER, { text: "phir se jobs dikhao" }, CTX as never, NOW);

    expect(h.v2.cooldownUntil).toHaveBeenCalled();
    expect(h.v2.handleCooldown).not.toHaveBeenCalled();
    expect(h.jobs.searchOpenPostings).toHaveBeenCalled();
  });

  it("with the FALTU flag off there is no gate at all — P1 behaviour", async () => {
    const h = makeCompanionServiceForV2({ v2: true, faltu: false, cooling: COOLING_UNTIL });
    await h.svc.message(WORKER, { text: "phir se jobs dikhao" }, CTX as never, NOW);

    expect(h.v2.cooldownUntil).not.toHaveBeenCalled();
    expect(h.jobs.searchOpenPostings).toHaveBeenCalled();
  });

  it("with v2 off, chip labels are v1's business and nothing v2 runs — byte-for-byte", async () => {
    const h = makeCompanionServiceForV2({ v2: false, cooling: COOLING_UNTIL });
    await h.svc.message(WORKER, { text: "Naya resume" }, CTX as never, NOW);

    expect(h.v2.handleTaskChip).not.toHaveBeenCalled();
    expect(h.v2.cooldownUntil).not.toHaveBeenCalled();
    expect(h.v2.handleMessage).not.toHaveBeenCalled();
  });
});

/**
 * THE COOL-DOWN SURVIVES AN APP RESTART (P2, F1). The app keeps `cooldown_until` in memory only,
 * so the open turn carries it while a cool-down runs: a cold start re-locks the composer from the
 * recap instead of from the next refused message.
 */
describe("GET /chat/companion carries a running cool-down", () => {
  const openTurn = async (h: ReturnType<typeof makeCompanionServiceForV2>) => {
    const res = await h.svc.open(WORKER, CTX as never, NOW);
    if (res.mode !== "companion") throw new Error("expected companion");
    return res;
  };

  it("v2 + FALTU on and cooling: the recap is unchanged and carries cooldown_until", async () => {
    const h = makeCompanionServiceForV2({ v2: true, faltu: true, cooling: COOLING_UNTIL });
    const turn = await openTurn(h);
    expect(h.v2.cooldownUntil).toHaveBeenCalledWith(WORKER, NOW);
    expect(turn.cooldown_until).toBe(COOLING_UNTIL);

    // Everything else is the recap a non-cooling worker gets — the field is the only addition.
    const idle = await openTurn(makeCompanionServiceForV2({ v2: true, faltu: true, cooling: null }));
    const { cooldown_until: _until, ...rest } = turn;
    expect(rest).toEqual(idle);
  });

  it("not cooling: no field at all", async () => {
    const turn = await openTurn(makeCompanionServiceForV2({ v2: true, faltu: true, cooling: null }));
    expect("cooldown_until" in turn).toBe(false);
  });

  it("FALTU off, or v2 off: the store is never read and the open is byte-for-byte as before", async () => {
    for (const opts of [
      { v2: true, faltu: false, cooling: COOLING_UNTIL },
      { v2: false, faltu: true, cooling: COOLING_UNTIL },
    ]) {
      const h = makeCompanionServiceForV2(opts);
      const turn = await openTurn(h);
      expect(h.v2.cooldownUntil).not.toHaveBeenCalled();
      expect("cooldown_until" in turn).toBe(false);
    }
  });
});
