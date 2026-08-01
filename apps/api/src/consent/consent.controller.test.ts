import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { ConsentController } from "./consent.controller";
import type { ConsentService } from "./consent.service";
import type { RequestContext } from "../common/request-context";

const CTX = { correlationId: "c", requestId: "r" } as RequestContext;

function make() {
  const consent = {
    // Typed with its real first parameter so the forgery-guard test below can read
    // `mock.calls[0][0]` — an untyped `vi.fn(async () => …)` records a zero-length
    // tuple, and the assertion would not compile.
    accept: vi.fn(async (_workerId: string, ..._rest: unknown[]) => ({
      consent_id: "c1",
      accepted_at: "t",
    })),
    withdraw: vi.fn(async () => ({ ok: true as const })),
  };
  return { controller: new ConsentController(consent as unknown as ConsentService), consent };
}

describe("ConsentController (thin) — delegation", () => {
  it("accept forwards the SESSION worker (not a body id), dto, ip, user-agent, ctx", async () => {
    const { controller, consent } = make();
    // The body deliberately carries a worker_id: an older client still sends one.
    // It must be IGNORED — the subject is the session worker. (The DTO schema also
    // strips the key, so this is belt and braces on the same rule.)
    const dto = { consent_version: "v", purposes: ["profiling"] };
    await controller.accept({ workerId: "session-worker" }, dto as never, "1.2.3.4", "ua", CTX);
    expect(consent.accept).toHaveBeenCalledWith("session-worker", dto, "1.2.3.4", "ua", CTX);
  });

  it("a body worker_id can NEVER become the consent subject (forgery guard)", async () => {
    const { controller, consent } = make();
    const dto = { consent_version: "v", purposes: ["profiling"], worker_id: "victim" };
    await controller.accept({ workerId: "attacker" }, dto as never, "1.2.3.4", "ua", CTX);
    expect(consent.accept.mock.calls[0]![0]).toBe("attacker");
  });

  it("withdraw forwards workerId + ctx to the service", async () => {
    const { controller, consent } = make();
    const worker = { workerId: "w" } as { workerId: string };
    await controller.withdraw(worker, CTX);
    expect(consent.withdraw).toHaveBeenCalledWith("w", CTX);
  });
});
