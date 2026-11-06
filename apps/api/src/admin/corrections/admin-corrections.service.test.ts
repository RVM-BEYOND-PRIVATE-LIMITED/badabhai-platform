import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { RequestContext } from "../../common/request-context";
import { ADMIN_ACTION_CODES } from "../admin-action-codes";
import { AdminCorrectionService } from "./admin-corrections.service";

/**
 * #2561 — the correction layer's contract with the database and the writers faked. What is
 * pinned here is the part a DB gate cannot see: the ENVELOPE (corrected + previous), the
 * re-correction rule (previous stays the last non-admin value), the revert writer call, the
 * reason/audit/action/event set, and the locked-field 400 before any write.
 */

const TX = { tx: true } as never;
const CTX: RequestContext = { correlationId: randomUUID(), requestId: `corrections-${randomUUID()}` };
const ADMIN = { id: randomUUID(), role: "ops_admin" as const, sid: "s" };
const WORKER = randomUUID();
const REASON = {
  reason_code: "worker_request" as const,
  reason_text: "Worker called support and asked us to correct the city",
};

function harness(over: { live?: Record<string, unknown> | undefined; baseCity?: string | null; basePreferred?: string[] } = {}) {
  const repo = {
    withTransaction: vi.fn(async (work: (tx: never) => Promise<unknown>) => work(TX)),
    findLive: vi.fn(async () => over.live),
    baseCity: vi.fn(async () => over.baseCity ?? null),
    basePreferredLocations: vi.fn(async () => over.basePreferred ?? []),
    insert: vi.fn(async () => undefined),
    supersede: vi.fn(async () => undefined),
    linkSupersededBy: vi.fn(async () => undefined),
    history: vi.fn(async () => []),
  };
  const actions = { writeAuditReason: vi.fn(async () => undefined) };
  const workers = {
    findById: vi.fn(async () => ({ id: WORKER })),
    updateLocation: vi.fn(async () => ({ id: WORKER })),
  };
  const workerService = { setLocation: vi.fn(async () => undefined) };
  const preferences = { setForWorker: vi.fn(async () => ({ keys_written: 1, keys_cleared: 0 })) };
  const pii = {
    encrypt: vi.fn((plain: string) => `enc:${plain}`),
    decrypt: vi.fn((token: string) => token.replace(/^enc:/, "")),
  };
  const events = { emit: vi.fn(async () => ({})) };
  const service = new AdminCorrectionService(
    repo as never,
    actions as never,
    workers as never,
    workerService as never,
    preferences as never,
    pii as never,
    events as never,
  );
  return { repo, actions, workers, workerService, preferences, pii, events, service };
}

const emitted = (events: { emit: ReturnType<typeof vi.fn> }) =>
  events.emit.mock.calls.map(([arg]) => arg as Record<string, unknown>);

describe("#2561 correction create", () => {
  it("writes the envelope, the domain value, the reason and the events in one transaction", async () => {
    const h = harness({ baseCity: "Mumbai" });
    const result = await h.service.correct(
      ADMIN as never,
      WORKER,
      { fact_key: "current_city", value: "Pune", ...REASON },
      CTX,
    );

    expect(result.changed).toBe(true);
    const inserted = (
      h.repo.insert.mock.calls[0] as unknown as [unknown, { valueEnc: string; factKey: string }]
    )[1];
    expect(inserted.factKey).toBe("current_city");
    expect(JSON.parse(inserted.valueEnc.replace(/^enc:/, ""))).toEqual({
      corrected: "Pune",
      previous: "Mumbai",
    });
    expect(h.workerService.setLocation).toHaveBeenCalledWith(
      WORKER,
      { city: "Pune" },
      CTX,
      expect.objectContaining({ tx: TX, source: "admin_correction" }),
    );
    expect(h.actions.writeAuditReason).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({
        workerId: WORKER,
        action: ADMIN_ACTION_CODES.candidate_field_corrected,
        reasonText: REASON.reason_text,
      }),
    );
    const names = emitted(h.events).map((e) => e.event_name);
    expect(names).toEqual([
      "admin.candidate_field_corrected",
      "admin.action_performed",
    ]);
    expect(emitted(h.events)[0]!.payload).toEqual({
      admin_id: ADMIN.id,
      worker_id: WORKER,
      fact_key: "current_city",
      override_id: result.override_id,
    });
  });

  it("re-correcting keeps the ORIGINAL previous and links the old row to the new one", async () => {
    const h = harness({
      live: {
        id: "old-override",
        valueEnc: `enc:${JSON.stringify({ corrected: "Pune", previous: "Mumbai" })}`,
      },
    });
    const result = await h.service.correct(
      ADMIN as never,
      WORKER,
      { fact_key: "current_city", value: "Nashik", ...REASON },
      CTX,
    );
    const inserted = (
      h.repo.insert.mock.calls[0] as unknown as [unknown, { valueEnc: string }]
    )[1];
    expect(JSON.parse(inserted.valueEnc.replace(/^enc:/, ""))).toEqual({
      corrected: "Nashik",
      // NOT "Pune": a later correction must not make revert restore another admin's value.
      previous: "Mumbai",
    });
    // Free the live slot first (unique index), then link the replacement after it exists (FK).
    expect(h.repo.supersede).toHaveBeenCalledWith(TX, "old-override", null);
    expect(h.repo.linkSupersededBy).toHaveBeenCalledWith(
      TX,
      "old-override",
      result.override_id,
    );
  });

  it("a preferred-locations correction writes the list through the preferences writer", async () => {
    const h = harness({ basePreferred: ["Pune"] });
    await h.service.correct(
      ADMIN as never,
      WORKER,
      { fact_key: "preferred_locations", value: ["Pune", "Nashik"], ...REASON },
      CTX,
    );
    expect(h.preferences.setForWorker).toHaveBeenCalledWith(
      WORKER,
      { preferred_cities: ["Pune", "Nashik"], touched_only: true },
      CTX,
      expect.objectContaining({ tx: TX, source: "admin_correction" }),
    );
  });

  it.each(["full_name", "phone_e164", "whatsapp_enc", "resume_show_photo"])(
    "refuses the LOCKED field %s with a 400 before any write",
    async (field) => {
      const h = harness();
      await expect(
        h.service.correct(
          ADMIN as never,
          WORKER,
          { fact_key: field as never, value: "x", ...REASON },
          CTX,
        ),
      ).rejects.toThrow("cannot be edited through the correction layer");
      expect(h.repo.withTransaction).not.toHaveBeenCalled();
      expect(h.events.emit).not.toHaveBeenCalled();
    },
  );
});

describe("#2561 correction revert", () => {
  it("writes previous back through the same writer and marks the row superseded by NONE", async () => {
    const h = harness({
      live: {
        id: "override-1",
        valueEnc: `enc:${JSON.stringify({ corrected: "Pune", previous: "Mumbai" })}`,
      },
    });
    const result = await h.service.revert(
      ADMIN as never,
      WORKER,
      "current_city",
      { reason_code: "verification_error", reason_text: "The correction was based on a wrong address" },
      CTX,
    );
    expect(result.changed).toBe(true);
    expect(h.workerService.setLocation).toHaveBeenCalledWith(
      WORKER,
      { city: "Mumbai" },
      CTX,
      expect.objectContaining({ tx: TX, source: "admin_correction" }),
    );
    expect(h.repo.supersede).toHaveBeenCalledWith(TX, "override-1", null);
    const names = emitted(h.events).map((e) => e.event_name);
    expect(names).toEqual(["admin.candidate_field_reverted", "admin.action_performed"]);
    expect(emitted(h.events)[0]!.payload).toEqual({
      admin_id: ADMIN.id,
      worker_id: WORKER,
      fact_key: "current_city",
      override_id: "override-1",
    });
  });

  it("a revert with no live correction is a 409 and writes nothing", async () => {
    const h = harness();
    await expect(
      h.service.revert(
        ADMIN as never,
        WORKER,
        "current_city",
        { reason_code: "other", reason_text: "Nothing to revert but the admin asked anyway" },
        CTX,
      ),
    ).rejects.toThrow("No live correction to revert");
    expect(h.repo.insert).not.toHaveBeenCalled();
    expect(h.events.emit).not.toHaveBeenCalled();
  });
});
