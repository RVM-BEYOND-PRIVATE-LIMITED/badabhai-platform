import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { MODULE_METADATA } from "@nestjs/common/constants";
import { WorkerAttributesRepository } from "../profiles/worker-attributes.repository";
import { EffectiveFactsService } from "../profiles/effective-facts.service";
import { WorkersModule } from "./workers.module";
import { WorkersService } from "./workers.service";

/**
 * #2201 — `WorkersService` takes `WorkerAttributesRepository` as an `@Optional()` dependency, and
 * the profile summary silently scores the row alone without it. This repo's vitest emits no
 * `design:paramtypes`, so no unit test resolves the real graph. Without this check, dropping the
 * provider would put every form-road worker back at their pre-#2201 score with every test green.
 */
describe("WorkersModule wiring (#2201)", () => {
  it("provides the attribute repository the profile-summary strength reads", () => {
    const providers = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, WorkersModule) ??
      []) as unknown[];
    expect(providers).toContain(WorkerAttributesRepository);
    expect(providers).toContain(WorkersService);
  });

  it("WorkersService keeps its repository-plus-optionals dependency shape", () => {
    // Eight collaborators: the repository first, the queue/config/storage in the middle, and the
    // two #2201/#2561 optional collaborators last (attributes, effective facts). The length pin is
    // what makes dropping one of the trailing optionals visible in a unit run.
    expect(WorkersService.length).toBe(8);
  });

  it("provides and exports EffectiveFactsService (#2561)", () => {
    const providers = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, WorkersModule) ??
      []) as unknown[];
    const exportsList = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, WorkersModule) ??
      []) as unknown[];
    expect(providers).toContain(EffectiveFactsService);
    expect(exportsList).toContain(EffectiveFactsService);
  });
});
