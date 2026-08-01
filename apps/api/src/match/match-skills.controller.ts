import { Body, Controller, Get, HttpCode, Post, UseGuards } from "@nestjs/common";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { PayerAuthGuard } from "../payers/payer-auth.guard";
import { MatchSkillsService } from "./match-skills.service";
import { ReachPreviewSchema, type ReachPreviewDto } from "./match.dto";

/**
 * The Matching V1 POSTING FORM surface (spec Part 2 / ADR-0036).
 *
 * Both routes ride {@link PayerAuthGuard}. Neither takes a `payer_id` — not from the
 * body, not from a param, not from a query: the reach counter is a property of the
 * WORKER SUPPLY, identical for every payer, so there is nothing to scope and therefore
 * no tenancy surface to get wrong. The guard is here because the vocabulary and the
 * live supply counts are commercial information about the platform, not public data.
 *
 * READ-ONLY, so NEITHER EMITS AN EVENT. That is deliberate and worth stating, because
 * the house rule is "every important endpoint emits an event": these two change no
 * state. `GET /payer/match/skills` returns a checked-in constant, and
 * `POST /payer/match/reach-preview` is a POST only because the skill list is a body
 * (it would be an unbounded query string as a GET) — it writes nothing. The decision
 * a payer makes with them IS evented, at publish, by `job_posting.reach_materialized`
 * (which carries the unticks) and by `job_posting.reach_alert` on a zero-reach publish.
 * Emitting a per-keystroke preview event would flood the spine with drafts of a
 * decision that has not been taken.
 *
 * PII-free: closed-set ids, checked-in labels, integer counts.
 */
@Controller("payer/match")
@UseGuards(PayerAuthGuard)
export class MatchSkillsController {
  constructor(private readonly skills: MatchSkillsService) {}

  /** The closed vocabulary + the curated related map + labels, for the picker. */
  @Get("skills")
  listSkills() {
    return this.skills.listSkills();
  }

  /**
   * Per-skill related lists with PRE-TICKED flags and LIVE reach counts, plus the
   * total and the E13 zero-reach warning. 200 (not 201) — it creates nothing.
   */
  @Post("reach-preview")
  @HttpCode(200)
  reachPreview(@Body(new ZodValidationPipe(ReachPreviewSchema)) dto: ReachPreviewDto) {
    return this.skills.reachPreview(dto);
  }
}
