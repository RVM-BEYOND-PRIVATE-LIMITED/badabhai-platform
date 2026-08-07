import "reflect-metadata";
import { describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { SkillsInternalGuard } from "../skills/skills-internal.guard";
import { SkillsModule } from "../skills/skills.module";
import { OccupationController } from "./occupation.controller";
import { OccupationIndexService } from "./occupation-index.service";
import { OccupationModule } from "./occupation.module";
import { OccupationRepository } from "./occupation.repository";
import { OccupationService } from "./occupation.service";

/**
 * DI WIRING GUARD.
 *
 * Every failure this catches happens at BOOT and nowhere else: the unit tests in this
 * directory construct each class by hand, so a missing import or a guard that no module
 * exports produces a green suite and a dead application.
 *
 * The reuse assertions are the load-bearing ones. `SkillsModule` is imported for two things
 * this module must never grow its own copy of — the ANN query behind layer L3, and the
 * scoped credential. A second ANN query would drift from the one covered by the
 * EXPLAIN-plan test; a second token would widen the ai-service's blast radius for no gain.
 */
const getMeta = (key: string, target: unknown): unknown[] =>
  (Reflect.getMetadata(key, target as object) as unknown[] | undefined) ?? [];

describe("OccupationModule wiring", () => {
  it("imports SkillsModule rather than reimplementing the ANN query or the guard", () => {
    expect(getMeta("imports", OccupationModule)).toContain(SkillsModule);
  });

  it("provides the index, the repository and the service", () => {
    expect(getMeta("providers", OccupationModule)).toEqual([
      OccupationIndexService,
      OccupationRepository,
      OccupationService,
    ]);
  });

  it("exports the service, so the orchestrator can call it IN-PROCESS", () => {
    // If this were not exported, Phase 8 would have to reach the ladder over HTTP — an
    // avoidable network hop on the chat hot path, on the layers whose whole value is that
    // they are free.
    expect(getMeta("exports", OccupationModule)).toContain(OccupationService);
  });

  it("declares the internal controller", () => {
    expect(getMeta("controllers", OccupationModule)).toEqual([OccupationController]);
  });

  it("guards every route with the SCOPED skills credential, never the all-routes token", () => {
    // Least privilege: the ai-service's credential must not open the resume-PII or money
    // routes. Same argument SkillsController makes for itself.
    const guards = getMeta("__guards__", OccupationController);
    expect(guards).toContain(SkillsInternalGuard);
  });

  it("is registered in AppModule — an unregistered module never builds its index", () => {
    expect(getMeta("imports", AppModule)).toContain(OccupationModule);
  });

  it("SkillsModule exports the guard the occupation controller depends on", () => {
    // Resolves at boot only. Without the export, every occupation route 500s.
    expect(getMeta("exports", SkillsModule)).toContain(SkillsInternalGuard);
  });
});
