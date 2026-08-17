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
   * `domainId` IS NON-NULL, and that is an EVENT-CONTRACT constraint, not a table one.
   * The write below would accept null (the column and the repository signature both do,
   * for the occupation scope), but the emit that follows would not: the v1
   * `skill.phrase_unresolved` payload declares `domain_id: z.string().min(1)`, and
   * mutating a shipped event schema is a CLAUDE.md §3 non-negotiable. Accepting null
   * here would write the row and then throw on validation — a queued phrase with no
   * event, which is a worse failure than not queueing it. The DTO refuses it at the
   * boundary instead; see the long note on `RecordUnresolvedDtoSchema.domain_id` for the
   * migration that reopens the path.
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
