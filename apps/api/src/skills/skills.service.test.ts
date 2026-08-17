import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { SkillsService } from "./skills.service";
import { SkillsController } from "./skills.controller";
import {
  NearestAliasesDtoSchema,
  RecordUnresolvedDtoSchema,
  toAliasSearchScope,
  type NearestAliasesDto,
} from "./skills.dto";

/** A well-formed house-dimension query embedding. */
const VECTOR = Array.from({ length: 768 }, () => 0.1);

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
    const scope = { kind: "legacy", domainId: "cnc-machining" } as const;
    const out = await service.nearestAliases(scope, [0.1, 0.2], 5);
    expect(out).toEqual([{ skill_id: "skill_vmc_operator", score: 0.93 }]);
    expect(repo.nearestAliases).toHaveBeenCalledWith(scope, [0.1, 0.2], 5);
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("passes the CANONICAL scope through untouched — the service decides nothing", async () => {
    // The service must not translate, default, or "helpfully" widen the scope. Which id
    // space was asked for is the caller's statement of intent and the repository's SQL
    // switch; anything in between rewriting it is how a canonical request quietly becomes
    // a legacy one that returns nothing.
    const { service, repo } = makeService();
    const scope = { kind: "canonical", jobDomainId: "jd_nco_7223_0100" } as const;
    await service.nearestAliases(scope, [0.1, 0.2], 3);
    expect(repo.nearestAliases).toHaveBeenCalledWith(scope, [0.1, 0.2], 3);
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

  it("carries a non-null domain_id onto the v1 event, hash-only", async () => {
    // INVERTED with the Architect's ruling. This used to record a miss with a NULL
    // `domain_id` for a `jd_*`-scoped canonicalization — which only worked because the v1
    // `skill.phrase_unresolved` payload had been widened to accept null. That widening is
    // reverted (CLAUDE.md §3: never mutate a shipped event schema), so the signature is
    // `string` again and the canonical-scoped MISS path is closed upstream instead: the
    // ai-service skips the call rather than firing one that cannot be recorded.
    //
    // What is pinned here is the half that still runs: a legacy-scoped miss emits exactly
    // as it always did, and the phrase never reaches the spine in any form but its hash.
    const { service, repo, events } = makeService();
    const phrase = "[EMPLOYER_1] ke saath fabrication";
    await service.recordUnresolved(phrase, "cnc-machining", "hi");

    expect(repo.recordUnresolved).toHaveBeenCalledWith(phrase, "cnc-machining", "hi");
    const emitted = events.emit.mock.calls[0]?.[0];
    expect(emitted.payload.domain_id).toBe("cnc-machining");
    expect(emitted.payload.phrase_hash).toBe(
      createHash("sha256").update(phrase, "utf8").digest("hex"),
    );
    expect(JSON.stringify(emitted)).not.toContain("fabrication");
  });
});

/**
 * The HTTP boundary of the Phase 1.5 cutover.
 *
 * The controller's ONLY job here is turning a validated body into one of two scopes, and
 * the failure it must never have is the third outcome: a request with no domain falling
 * through to an unscoped ANN over the whole `skill_alias` table. That would return the
 * nearest alias in ANY trade — a tailor's phrase answered with a machinist's skill — with
 * a 200 and a plausible score. So "neither" is a 400, not a default.
 */
describe("SkillsController — exactly-one-of scope (Phase 1.5)", () => {
  const makeController = () => {
    const skills = {
      nearestAliases: vi.fn().mockResolvedValue([{ skill_id: "skill_vmc_operator", score: 0.9 }]),
      nearestDomains: vi.fn().mockResolvedValue([]),
      recordUnresolved: vi.fn().mockResolvedValue(undefined),
    };
    return { controller: new SkillsController(skills as never), skills };
  };

  it("LEGACY body reaches the repository as a legacy scope (unchanged behaviour)", async () => {
    const { controller, skills } = makeController();
    const dto = NearestAliasesDtoSchema.parse({ domain_id: "cnc-machining", vector: VECTOR });
    const out = await controller.nearestAliases(dto);

    expect(skills.nearestAliases).toHaveBeenCalledWith(
      { kind: "legacy", domainId: "cnc-machining" },
      VECTOR,
      5,
    );
    // The response shape is UNCHANGED — the ai-service parses exactly this.
    expect(out).toEqual({ candidates: [{ skill_id: "skill_vmc_operator", score: 0.9 }] });
  });

  it("CANONICAL body reaches the repository as a canonical scope", async () => {
    const { controller, skills } = makeController();
    const dto = NearestAliasesDtoSchema.parse({
      job_domain_id: "jd_nco_7223_0100",
      vector: VECTOR,
      k: 3,
    });
    await controller.nearestAliases(dto);

    expect(skills.nearestAliases).toHaveBeenCalledWith(
      { kind: "canonical", jobDomainId: "jd_nco_7223_0100" },
      VECTOR,
      3,
    );
  });

  it("400s rather than searching everything when the schema is bypassed", async () => {
    // Belt-and-braces on the one outcome that must not exist. The refine already rejects
    // this body, so this asserts the controller's own fallback — reached only if someone
    // later swaps the pipe, relaxes the schema, or calls the method directly.
    const { controller, skills } = makeController();
    const bypassed = { vector: VECTOR, k: 5 } as unknown as NearestAliasesDto;

    await expect(controller.nearestAliases(bypassed)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(skills.nearestAliases).not.toHaveBeenCalled();
  });

  it("refuses a NULL domain_id at the boundary — the v1 event payload requires a string", () => {
    // INVERTED with the Architect's ruling. This used to assert the controller forwarded a
    // null through. It cannot: `SkillsService.recordUnresolved` emits `skill.phrase_unresolved`,
    // whose v1 payload declares `domain_id: z.string().min(1)`, and mutating a shipped event
    // schema is a CLAUDE.md §3 non-negotiable. Accepting null here would write the queue row
    // and THEN throw on event validation — a queued phrase with no event, which is a worse
    // outcome than refusing the write. So the refusal happens before anything is written.
    expect(
      RecordUnresolvedDtoSchema.safeParse({
        phrase: "[EMPLOYER_1] fabrication",
        domain_id: null,
        lang: "hi",
      }).success,
    ).toBe(false);
  });

  it("still forwards a legacy domain_id unchanged", async () => {
    // The regression pin for the path that actually runs in production today.
    const { controller, skills } = makeController();
    const dto = RecordUnresolvedDtoSchema.parse({
      phrase: "[EMPLOYER_1] fabrication",
      domain_id: "cnc-machining",
      lang: "hi",
    });
    await controller.recordUnresolved(dto);
    expect(skills.recordUnresolved).toHaveBeenCalledWith(
      "[EMPLOYER_1] fabrication",
      "cnc-machining",
      "hi",
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

  it("nearest-aliases accepts EITHER domain id, and the legacy body is unchanged", () => {
    const legacy = NearestAliasesDtoSchema.safeParse({
      domain_id: "cnc-machining",
      vector: VECTOR,
    });
    expect(legacy.success).toBe(true);
    expect(legacy.success && legacy.data.job_domain_id).toBeUndefined();
    expect(toAliasSearchScope(legacy.success ? legacy.data : ({} as never))).toEqual({
      kind: "legacy",
      domainId: "cnc-machining",
    });

    const canonical = NearestAliasesDtoSchema.safeParse({
      job_domain_id: "jd_nco_7223_0100",
      vector: VECTOR,
    });
    expect(canonical.success).toBe(true);
    expect(canonical.success && canonical.data.domain_id).toBeUndefined();
    expect(toAliasSearchScope(canonical.success ? canonical.data : ({} as never))).toEqual({
      kind: "canonical",
      jobDomainId: "jd_nco_7223_0100",
    });
  });

  it("nearest-aliases rejects NEITHER id — a missing domain never means 'search all'", () => {
    // The single most important rejection on this route. An unscoped ANN over
    // `skill_alias` answers a cook's phrase with a machinist's skill, at a plausible
    // score, with a 200. There is no safe default domain, so the request fails.
    const neither = NearestAliasesDtoSchema.safeParse({ vector: VECTOR });
    expect(neither.success).toBe(false);
    expect(neither.success === false && JSON.stringify(neither.error.issues)).toContain(
      "exactly one of domain_id",
    );
    // An explicit undefined is the same as absent — not a third state.
    expect(
      NearestAliasesDtoSchema.safeParse({
        domain_id: undefined,
        job_domain_id: undefined,
        vector: VECTOR,
      }).success,
    ).toBe(false);
  });

  it("toAliasSearchScope: canonical wins if a both-present body ever gets past the schema", () => {
    // Unreachable through the pipe (the refine rejects both-present), so this pins the
    // ONE thing that would matter if it ever became reachable: the cutover direction. A
    // legacy-first tie-break would make an ai-service that sends both — the natural shape
    // of a half-finished rollout — silently keep using the blind pre-filter, which is
    // exactly the bug this phase exists to remove. Fail forward, not backward.
    expect(
      toAliasSearchScope({
        domain_id: "cnc-machining",
        job_domain_id: "jd_nco_7223_0100",
        vector: VECTOR,
        k: 5,
      }),
    ).toEqual({ kind: "canonical", jobDomainId: "jd_nco_7223_0100" });

    // ...and neither present is null, never an invented scope.
    expect(toAliasSearchScope({ vector: VECTOR, k: 5 })).toBeNull();
  });

  it("nearest-aliases rejects BOTH ids — the two id spaces are disjoint", () => {
    // Silently preferring one would make the caller's intent unknowable from the wire and
    // would hide a caller bug behind a plausible answer from the wrong vocabulary.
    const both = NearestAliasesDtoSchema.safeParse({
      domain_id: "cnc-machining",
      job_domain_id: "jd_nco_7223_0100",
      vector: VECTOR,
    });
    expect(both.success).toBe(false);
    expect(both.success === false && JSON.stringify(both.error.issues)).toContain(
      "exactly one of domain_id",
    );
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

  it("unresolved REQUIRES a non-null domain_id — the v1 event payload is not negotiable", () => {
    // INVERTED with the Architect's ruling: keep `skill.phrase_unresolved` at v1 with
    // `domain_id: z.string().min(1)`, and close the canonical-scoped MISS path rather than
    // widen a shipped event schema (CLAUDE.md §3). A `job_domain_id`-scoped miss therefore
    // has nowhere to be queued until `unresolved_phrase` grows a `job_domain_id` column —
    // the ai-service skips the call rather than firing a doomed one.
    const ok = RecordUnresolvedDtoSchema.safeParse({
      phrase: "[EMPLOYER_1] polish work",
      domain_id: "cnc-machining",
    });
    expect(ok.success).toBe(true);
    expect(ok.success && ok.data.domain_id).toBe("cnc-machining");

    // null is refused...
    expect(
      RecordUnresolvedDtoSchema.safeParse({
        phrase: "[EMPLOYER_1] polish work",
        domain_id: null,
      }).success,
    ).toBe(false);
    // ...and so is absent, so a caller cannot route around the refusal by omitting the key.
    expect(
      RecordUnresolvedDtoSchema.safeParse({ phrase: "[EMPLOYER_1] polish work" }).success,
    ).toBe(false);
    // An empty string was never a domain either.
    expect(
      RecordUnresolvedDtoSchema.safeParse({ phrase: "polish work", domain_id: "" }).success,
    ).toBe(false);
    // The residual-digit gate is independent of the domain and still fires.
    expect(
      RecordUnresolvedDtoSchema.safeParse({
        phrase: "call me 9876543210",
        domain_id: "cnc-machining",
      }).success,
    ).toBe(false);
  });
});
