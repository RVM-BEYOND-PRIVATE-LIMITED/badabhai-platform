import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { EventsService } from "../events/events.service";
import { SkillsRepository } from "./skills.repository";
import type { AliasCandidate, AliasSearchScope, DomainCandidate } from "./skills.dto";

/**
 * Skill-canonicalization support service (ADR-0030 / FORK-B-1 seam A).
 * The VECTOR decision (floor gate, assign-vs-unresolved) lives in the ai-service
 * (`canonicalize_skill`, SG-3) — this side only runs the authorized DB queries and
 * keeps the event spine honest.
 */
@Injectable()
export class SkillsService {
  constructor(
    private readonly repo: SkillsRepository,
    private readonly events: EventsService,
  ) {}

  /**
   * Read-only ANN lookup — no event (reads don't ride the spine).
   *
   * The scope arrives ALREADY narrowed (legacy slug vs canonical `jd_*`); choosing
   * between the two id spaces is a boundary concern, and choosing the SQL is the
   * repository's. Nothing is decided here, which is why this stays a passthrough.
   */
  async nearestAliases(
    scope: AliasSearchScope,
    vector: number[],
    k: number,
  ): Promise<AliasCandidate[]> {
    return this.repo.nearestAliases(scope, vector, k);
  }

  /**
   * Read-only job-domain shortlist for the RAG pass — no event, same as above.
   *
   * The MATCH decision (which candidate, and whether any of them clears the floor) is
   * the ai-service's, exactly as the skill floor gate is: this side only runs the
   * authorized query. Keeping the two halves split the same way means there is one
   * place to look for "how did it choose", and it is never here.
   */
  async nearestDomains(vector: number[], k: number): Promise<DomainCandidate[]> {
    return this.repo.nearestDomains(vector, k);
  }

  /**
   * Record a below-floor miss (phrase ALREADY pseudonymized, SG-1) and emit
   * `skill.phrase_unresolved` — hash-only: even the pseudonymized text never rides
   * the event spine. Idempotency key = the content triple, so an at-least-once retry
   * of the SAME miss occurrence doesn't double-emit.
   *
   * EXACTLY ONE SCOPE, and the event GENERATION follows from which one (S3-C / D-6).
   *
   * A legacy-scoped miss still emits v1, byte-identical to before this method learned the
   * second scope — no shipped consumer sees any change. A canonical-scoped miss emits
   * `skill.phrase_unresolved_v2`, which is a second registry entry rather than a relaxed
   * v1: v1's `domain_id` is `z.string().min(1)` and a canonical miss has no legacy slug to
   * put there, so the only way through v1 would be relaxing a required field on a shipped
   * schema (CLAUDE.md §3: never). The `feed.shown_v2` precedent is the same call.
   *
   * ORDER IS DELIBERATE AND UNCHANGED: the row is written first, then the event. An emit
   * that throws after a successful write leaves a queued phrase with no event, which is
   * why the scope is validated at the DTO boundary and again in the repository BEFORE the
   * insert — by the time we are here, the payload cannot fail validation on scope.
   */
  async recordUnresolved(
    phrase: string,
    domainId: string | null,
    lang: string,
    jobDomainId: string | null = null,
  ): Promise<void> {
    const { id, count } = await this.repo.recordUnresolved(
      phrase,
      domainId,
      lang,
      "skill",
      jobDomainId,
    );
    const phraseHash = createHash("sha256").update(phrase, "utf8").digest("hex");
    // The ai-service is the (guarded) caller; no user principal exists on this path.
    const actor = { actor_type: "ai_service", actor_id: null } as const;
    const subject = { subject_type: "skill_phrase", subject_id: id } as const;

    if (jobDomainId !== null) {
      await this.events.emit({
        event_name: "skill.phrase_unresolved_v2",
        actor,
        subject,
        payload: {
          phrase_hash: phraseHash,
          domain_id: null,
          job_domain_id: jobDomainId,
          lang,
          count,
        },
        // Keyed on the same (row, count) pair as v1 so an at-least-once retry of the SAME
        // miss occurrence does not double-emit. The event NAME is part of the key space,
        // so v1 and v2 keys cannot collide even for the same row id.
        idempotencyKey: `skill.phrase_unresolved_v2:${id}:${count}`,
      });
      return;
    }

    if (domainId === null) {
      throw new Error(
        "recordUnresolved: a skill-scoped miss must carry either domainId or jobDomainId",
      );
    }
    await this.events.emit({
      event_name: "skill.phrase_unresolved",
      actor,
      subject,
      payload: {
        phrase_hash: phraseHash,
        domain_id: domainId,
        lang,
        count,
      },
      idempotencyKey: `skill.phrase_unresolved:${id}:${count}`,
    });
  }
}
