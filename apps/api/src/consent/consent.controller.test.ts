import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { ConsentController } from "./consent.controller";
import type { ConsentService } from "./consent.service";
import type { RequestContext } from "../common/request-context";

const CTX = { correlationId: "c", requestId: "r" } as RequestContext;

function make() {
  const consent = { accept: vi.fn(async () => ({ consent_id: "c1", accepted_at: "t" })) };
  return { controller: new ConsentController(consent as unknown as ConsentService), consent };
}

describe("ConsentController (thin) — delegation", () => {
  it("accept forwards dto, ip, user-agent, ctx to the service", async () => {
    const { controller, consent } = make();
    const dto = { worker_id: "w", consent_version: "v", purposes: ["profiling"] };
    await controller.accept(dto as never, "1.2.3.4", "ua", CTX);
    expect(consent.accept).toHaveBeenCalledWith(dto, "1.2.3.4", "ua", CTX);
  });
});
