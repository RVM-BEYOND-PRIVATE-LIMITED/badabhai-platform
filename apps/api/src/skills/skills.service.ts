import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { EventsService } from "../events/events.service";
import { SkillsRepository } from "./skills.repository";
import type { AliasCandidate } from "./skills.dto";

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

  /** Read-only ANN lookup — no event (reads don't ride the spine). */
  async nearestAliases(
    domainId: string,
    vector: number[],
    k: number,
  ): Promise<AliasCandidate[]> {
    return this.repo.nearestAliases(domainId, vector, k);
  }

  /**
   * Record a below-floor miss (phrase ALREADY pseudonymized, SG-1) and emit
   * `skill.phrase_unresolved` — hash-only: even the pseudonymized text never rides
   * the event spine. Idempotency key = the content triple, so an at-least-once retry
   * of the SAME miss occurrence doesn't double-emit.
   */
  async recordUnresolved(phrase: string, domainId: string, lang: string): Promise<void> {
    const { id, count } = await this.repo.recordUnresolved(phrase, domainId, lang);
    const phraseHash = createHash("sha256").update(phrase, "utf8").digest("hex");
    await this.events.emit({
      event_name: "skill.phrase_unresolved",
      // The ai-service is the (guarded) caller; no user principal exists on this path.
      actor: { actor_type: "ai_service", actor_id: null },
      subject: { subject_type: "skill_phrase", subject_id: id },
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
