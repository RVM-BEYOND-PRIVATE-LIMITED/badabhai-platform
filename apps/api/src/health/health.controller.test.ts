import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { HealthController } from "./health.controller";

describe("HealthController", () => {
  it("reports ok with environment + service", () => {
    const controller = new HealthController({ NODE_ENV: "test" } as never);
    const result = controller.check();
    expect(result.status).toBe("ok");
    expect(result.service).toBe("api");
    expect(result.environment).toBe("test");
  });
});
