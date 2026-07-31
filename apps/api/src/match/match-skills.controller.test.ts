import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { PATH_METADATA, METHOD_METADATA } from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";
import { PayerAuthGuard } from "../payers/payer-auth.guard";
import { MatchSkillsController } from "./match-skills.controller";

/**
 * The Matching V1 POSTING FORM surface (ADR-0036 Part 2).
 *
 * Two things are worth pinning about this controller and neither is its body, which is
 * two one-line delegations:
 *
 *   1. IT IS GUARDED. `GET /payer/match/skills` returns the closed vocabulary and
 *      `POST /payer/match/reach-preview` returns LIVE WORKER SUPPLY COUNTS. Those counts
 *      are commercial information about the platform — how many CNC turners BadaBhai can
 *      actually reach in a trade is exactly what a competitor would pay for, and an
 *      unauthenticated reach-preview hands it over a skill id at a time. Losing the
 *      class-level guard changes nothing visible in any other test.
 *   2. IT TAKES NO `payer_id`, ANYWHERE. The reach counter is a property of worker
 *      supply and is identical for every payer, so there is nothing to scope — and
 *      therefore no tenancy surface to get wrong (XB-A). A `payer_id` appearing in
 *      either signature would be a body-trusted identifier on a payer-facing route,
 *      which is the shape of the bug the house rule exists to prevent.
 */

const meta = (key: string, target: unknown): unknown =>
  Reflect.getMetadata(key, target as object);

describe("MatchSkillsController — the supply counter is behind PayerAuthGuard", () => {
  it("guards the WHOLE controller, so a new route cannot ship unguarded by omission", () => {
    // Class-level `@UseGuards` means a route added tomorrow inherits it. Per-route
    // guards would make "someone forgot" a live possibility on a surface that leaks
    // supply data.
    expect(meta("__guards__", MatchSkillsController)).toEqual([PayerAuthGuard]);
  });

  it("mounts under payer/match with the two documented routes", () => {
    expect(meta(PATH_METADATA, MatchSkillsController)).toBe("payer/match");
    expect(meta(PATH_METADATA, MatchSkillsController.prototype.listSkills)).toBe("skills");
    expect(meta(METHOD_METADATA, MatchSkillsController.prototype.listSkills)).toBe(
      RequestMethod.GET,
    );
    expect(meta(PATH_METADATA, MatchSkillsController.prototype.reachPreview)).toBe(
      "reach-preview",
    );
    expect(meta(METHOD_METADATA, MatchSkillsController.prototype.reachPreview)).toBe(
      RequestMethod.POST,
    );
  });

  it("answers the preview with 200, not 201 — it creates nothing", () => {
    // It is a POST only because the skill list is a body (an unbounded query string as
    // a GET). A 201 would tell every client, and every proxy, that it wrote something.
    expect(meta("__httpCode__", MatchSkillsController.prototype.reachPreview)).toBe(200);
  });

  it("neither handler accepts a payer_id — identity is the guard's, not the body's", () => {
    // Arity is the check that survives a refactor: adding a `@Body() payer_id` or a
    // `@Param('payerId')` changes it, and this fails before the route ships.
    expect(MatchSkillsController.prototype.listSkills.length).toBe(0);
    expect(MatchSkillsController.prototype.reachPreview.length).toBe(1);
  });
});

describe("MatchSkillsController — delegation", () => {
  function makeCtrl() {
    const skills = {
      listSkills: vi.fn(() => ({ skills: [{ skill_id: "mskill_vmc_operator" }] })),
      reachPreview: vi.fn(async () => ({ reach_total: 5, zero_reach: false })),
    };
    return { ctrl: new MatchSkillsController(skills as never), skills };
  }

  it("returns the vocabulary the service produced, unwrapped and unmodified", () => {
    const { ctrl, skills } = makeCtrl();
    // The picker reads this directly; re-shaping it here would put a second, untested
    // definition of the vocabulary between the taxonomy and the form.
    expect(ctrl.listSkills()).toEqual({ skills: [{ skill_id: "mskill_vmc_operator" }] });
    expect(skills.listSkills).toHaveBeenCalledOnce();
  });

  it("passes the validated body straight through to the resolver", async () => {
    const { ctrl, skills } = makeCtrl();
    const dto = { match_skill_ids: ["mskill_vmc_operator"], unticked_related_ids: ["mskill_hmc_operator"] };

    await expect(ctrl.reachPreview(dto)).resolves.toEqual({ reach_total: 5, zero_reach: false });
    // Including the unticks: dropping them here would silently ignore every untick a
    // company made on the form, and the preview would show a wider reach than publish
    // will actually store.
    expect(skills.reachPreview).toHaveBeenCalledWith(dto);
  });
});
