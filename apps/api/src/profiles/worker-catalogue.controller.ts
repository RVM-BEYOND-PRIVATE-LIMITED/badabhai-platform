import { Controller, Get, UseGuards } from "@nestjs/common";
import { WorkerAuthGuard } from "../auth/worker-auth.guard";
import { ConsentGuard } from "../auth/consent.guard";
import { machineOptions, skillOptions } from "./worker-catalogue.options";

/**
 * The correction catalogues (#1596) — the two closed vocabularies a worker picks from when
 * correcting the extracted skills/machines rows (`POST /profile/corrections`, #1593).
 *
 * WORKER-SELF + CONSENT-GATED, the same pair every sibling worker read uses. The worker id is
 * NOT read: the response is a static dictionary from `@badabhai/taxonomy`, so the guard is for
 * consistency with the write route it feeds rather than because this discloses anything. There
 * is no path or body parameter either, so there is no route shape that could address another
 * worker.
 *
 * NO WORKER DATA, NO COUNTS, NO PII. Exactly the posture `me/qualifications/options` and
 * `me/work-preferences/options` hold, and the same reason: a client that carries its own copy of
 * a closed set is the cross-language drift this codebase has paid for before — the worker taps a
 * chip the server rejects and nothing names the cause.
 */
@Controller("workers")
export class WorkerCatalogueController {
  /** Canonical `skill_*` ids + display labels, in taxonomy order. */
  @Get("me/skills/options")
  @UseGuards(WorkerAuthGuard, ConsentGuard)
  skills(): { skills: { skill_id: string; label: string }[] } {
    return {
      skills: skillOptions().map((option) => ({ skill_id: option.id, label: option.label })),
    };
  }

  /** Canonical `mach_*` ids + display labels, in taxonomy order. */
  @Get("me/machines/options")
  @UseGuards(WorkerAuthGuard, ConsentGuard)
  machines(): { machines: { machine_id: string; label: string }[] } {
    return {
      machines: machineOptions().map((option) => ({ machine_id: option.id, label: option.label })),
    };
  }
}
