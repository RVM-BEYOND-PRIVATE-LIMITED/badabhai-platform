import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";

import {
  WorkerAuthGuard,
  CurrentWorker,
  type AuthenticatedWorker,
} from "../auth/worker-auth.guard";
import { ConsentGuard } from "../auth/consent.guard";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import {
  MatchSkillIdParamSchema,
  SetMatchSkillWantsSchema,
  type SetMatchSkillWantsDto,
} from "./worker-match-skills.dto";
import { WorkerSkillsService, type WorkerMatchSkillView } from "./worker-skills.service";

/**
 * E4 — the worker's own EXIT from matching: the read the page renders and the two writes that
 * turn supply off. CLAUDE.md §6: the screen itself is the mobile owner's work; this is its
 * server half only.
 *
 * WHY ITS OWN CONTROLLER AND NOT A ROUTE ON `MatchSkillsController`: that class is the PAYER
 * posting form under `PayerAuthGuard`. These routes are the worker's own rows and take the
 * worker-self pair every other `/workers/me/*` write takes — one class carrying both guard
 * sets is how a route later ends up under the wrong one. Class-level guards, so a route added
 * tomorrow cannot ship unguarded by omission.
 *
 * THE WORKER ID COMES FROM `@CurrentWorker`, NEVER from the body or the path. The skill id is
 * the only client-supplied value that names a row: shape-checked by the Zod pipe here,
 * closed-set-checked in the service, and ownership proved inside the UPDATE. There is no route
 * shape here that could address another worker's supply.
 *
 * THE READ IS PART OF THE EXIT, not garnish. `worker_skill` had no worker-facing read at all,
 * so per-skill toggles had nothing to render from — and a toggle list is only an exit if the
 * worker can see what he is turning off. `no-store`, because it is worker data.
 *
 * EVERY RESPONSE IS PII-FREE: closed-vocabulary ids, checked-in labels and booleans. No counts
 * of who can see him, ever.
 */
@Controller("workers")
@UseGuards(WorkerAuthGuard, ConsentGuard)
export class WorkerMatchSkillsController {
  constructor(private readonly skills: WorkerSkillsService) {}

  /**
   * The caller's match skills and their on/off state — the page's prefill.
   *
   * A RESPONSE WITH `wants: false` ROWS IN IT is the point: a worker who turned a skill off
   * must be able to find it again and turn it back on. `no-store` because this is worker data;
   * no event, because a read changes nothing.
   */
  @Get("me/match-skills")
  @Header("Cache-Control", "no-store")
  async listMyMatchSkills(
    @CurrentWorker() worker: AuthenticatedWorker,
  ): Promise<{ skills: WorkerMatchSkillView[] }> {
    return { skills: await this.skills.listMatchSkillsForWorker(worker.id) };
  }

  /**
   * Turn ONE kind of work on or off. Consent-gated like every other worker write.
   *
   * The response echoes the id and the state that now holds; it never reports how many open
   * postings the change moved — that is supply information the worker did not ask for.
   */
  @Put("me/match-skills/:skillId/wants")
  @HttpCode(200)
  async setMySkillWants(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Param("skillId", new ZodValidationPipe(MatchSkillIdParamSchema)) skillId: string,
    @Body(new ZodValidationPipe(SetMatchSkillWantsSchema)) dto: SetMatchSkillWantsDto,
    @Ctx() ctx: RequestContext,
  ): Promise<{ ok: true; skill_id: string; wants: boolean }> {
    const result = await this.skills.setWants(worker.id, skillId, dto.wants, ctx);
    return { ok: true, skill_id: result.skill_id, wants: result.wants };
  }

  /**
   * Turn EVERYTHING off in one call — the exit R-E3's reason needs.
   *
   * POST because it is an action on a collection with no resource to name in the path. `200`,
   * not `201`: it creates nothing. `cleared` counts the worker's own rows (0 on a repeat
   * call), which is a fact about his request rather than about anyone who could see him.
   */
  @Post("me/match-skills/clear-all")
  @HttpCode(200)
  async clearAllMyMatchSkills(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Ctx() ctx: RequestContext,
  ): Promise<{ ok: true; cleared: number }> {
    const result = await this.skills.clearAllWants(worker.id, ctx);
    return { ok: true, cleared: result.cleared };
  }
}
