import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { SkillsService } from "./skills.service";
import {
  NearestAliasesDtoSchema,
  RecordUnresolvedDtoSchema,
} from "./skills.dto";

describe("SkillsService (ADR-0030 / FORK-B-1 seam A)", () => {
  const makeService = () => {
    const repo = {
      nearestAliases: vi.fn().mockResolvedValue([{ skill_id: "skill_vmc_operator", score: 0.93 }]),
      recordUnresolved: vi.fn().mockResolvedValue({ id: "11111111-1111-4111-8111-111111111111", count: 3 }),
    };
    const events = { emit: vi.fn().mockResolvedValue(undefined) };
    const service = new SkillsService(repo as never, events as never);
    return { service, repo, events };
  };

  it("nearestAliases is a read-only passthrough (no event)", async () => {
    const { service, repo, events } = makeService();
    const out = await service.nearestAliases("cnc-machining", [0.1, 0.2], 5);
    expect(out).toEqual([{ skill_id: "skill_vmc_operator", score: 0.93 }]);
    expect(repo.nearestAliases).toHaveBeenCalledWith("cnc-machining", [0.1, 0.2], 5);
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("recordUnresolved upserts then emits the HASH-ONLY event (never the phrase text)", async () => {
    const { service, repo, events } = makeService();
    const phrase = "[EMPLOYER_1] ke saath polish work"; // already-pseudonymized (SG-1)
    await service.recordUnresolved(phrase, "cnc-machining", "hi");

    expect(repo.recordUnresolved).toHaveBeenCalledWith(phrase, "cnc-machining", "hi");
    expect(events.emit).toHaveBeenCalledTimes(1);
    const emitted = events.emit.mock.calls[0]?.[0];
    expect(emitted.event_name).toBe("skill.phrase_unresolved");
    expect(emitted.actor).toEqual({ actor_type: "ai_service", actor_id: null });
    expect(emitted.subject).toEqual({
      subject_type: "skill_phrase",
      subject_id: "11111111-1111-4111-8111-111111111111",
    });
    // Hash-only: sha256(phrase), and the phrase text appears NOWHERE in the event.
    const expectedHash = createHash("sha256").update(phrase, "utf8").digest("hex");
    expect(emitted.payload).toEqual({
      phrase_hash: expectedHash,
      domain_id: "cnc-machining",
      lang: "hi",
      count: 3,
    });
    expect(JSON.stringify(emitted)).not.toContain("polish work");
    // Idempotency: the same (row, count) occurrence can't double-emit on retry.
    expect(emitted.idempotencyKey).toBe(
      "skill.phrase_unresolved:11111111-1111-4111-8111-111111111111:3",
    );
  });
});

describe("skills DTOs — boundary validation", () => {
  it("nearest-aliases requires exactly a 768-dim finite vector and bounded k", () => {
    const ok = NearestAliasesDtoSchema.safeParse({
      domain_id: "cnc-machining",
      vector: Array.from({ length: 768 }, () => 0.1),
    });
    expect(ok.success).toBe(true);
    expect(ok.success && ok.data.k).toBe(5); // default

    expect(
      NearestAliasesDtoSchema.safeParse({ domain_id: "d", vector: [0.1, 0.2] }).success,
    ).toBe(false); // wrong dimension
    expect(
      NearestAliasesDtoSchema.safeParse({
        domain_id: "d",
        vector: Array.from({ length: 768 }, () => 0.1),
        k: 50,
      }).success,
    ).toBe(false); // k over cap
  });

  it("unresolved rejects a residual 7+ digit run (defense-in-depth vs unpseudonymized input)", () => {
    expect(
      RecordUnresolvedDtoSchema.safeParse({
        phrase: "call me 9876543210", // numeric PII would have BLOCKED upstream
        domain_id: "cnc-machining",
      }).success,
    ).toBe(false);
    const ok = RecordUnresolvedDtoSchema.safeParse({
      phrase: "[EMPLOYER_1] polish work",
      domain_id: "cnc-machining",
    });
    expect(ok.success).toBe(true);
    expect(ok.success && ok.data.lang).toBe("en"); // default
  });
});
