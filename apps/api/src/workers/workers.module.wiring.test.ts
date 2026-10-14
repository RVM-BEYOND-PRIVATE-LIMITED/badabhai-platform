import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { MODULE_METADATA } from "@nestjs/common/constants";
import { WorkerAttributesRepository } from "../profiles/worker-attributes.repository";
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

  it("WorkersService still declares the repository as its last constructor dependency", () => {
    // Seven collaborators; the seventh is the optional attribute repository.
    expect(WorkersService.length).toBe(7);
  });
});
