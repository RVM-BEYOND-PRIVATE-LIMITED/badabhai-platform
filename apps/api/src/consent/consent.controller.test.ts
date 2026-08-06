import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { ConsentController } from "./consent.controller";
import type { ConsentService } from "./consent.service";
import type { AuthenticatedWorker } from "../auth/worker-auth.guard";
import type { RequestContext } from "../common/request-context";

const CTX = { correlationId: "c", requestId: "r" } as RequestContext;

/**
 * The worker object EXACTLY as `WorkerAuthGuard` builds it —
 * `req.worker = { id, sid, deviceId }`. Typed as {@link AuthenticatedWorker} on
 * purpose.
 *
 * THIS IS THE WHOLE POINT OF THIS FILE NOW. These tests used to hand-write
 * `{ workerId: "session-worker" }`, which is not a shape the guard ever produces
 * — and the controller declared the same invented shape, so the test AGREED WITH
 * THE BUG and passed while `POST /consent/accept` and `/consent/withdraw` 500'd
 * for every real caller (`worker.workerId` was `undefined`, and the service ran
 * `select … from workers where id = $1` with an empty param).
 *
 * A fixture that mirrors the producer rather than the consumer is what would
 * have caught it. Do not replace this with a literal that merely satisfies the
 * handler's current parameter list.
 */
const sessionWorker = (id: string): AuthenticatedWorker => ({ id, sid: "sid-1" });

function make() {
  const consent = {
    // Typed with its real first parameter so the forgery-guard test below can read
    // `mock.calls[0][0]` — an untyped `vi.fn(async () => …)` records a zero-length
    // tuple, and the assertion would not compile.
    accept: vi.fn(async (_workerId: string, ..._rest: unknown[]) => ({
      consent_id: "c1",
      accepted_at: "t",
    })),
    // Typed with its real first parameter for the same reason as `accept` above:
    // an untyped `vi.fn(async () => …)` records a zero-length tuple, so
    // `mock.calls[0][0]` does not compile.
    withdraw: vi.fn(async (_workerId: string, ..._rest: unknown[]) => ({ ok: true as const })),
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
    await controller.accept(sessionWorker("session-worker"), dto as never, "1.2.3.4", "ua", CTX);
    expect(consent.accept).toHaveBeenCalledWith("session-worker", dto, "1.2.3.4", "ua", CTX);
  });

  it("passes a DEFINED worker id — the regression that 500'd both routes", async () => {
    const { controller, consent } = make();
    const dto = { consent_version: "v", purposes: ["profiling"] };
    await controller.accept(sessionWorker("w-1"), dto as never, "1.2.3.4", "ua", CTX);

    const passed = consent.accept.mock.calls[0]![0];
    // Stated as its own assertion because "undefined" is precisely what shipped:
    // `toHaveBeenCalledWith` above would also catch it, but this names the failure.
    expect(passed).toBeDefined();
    expect(passed).not.toBe("");
    expect(passed).toBe("w-1");
  });

  it("a body worker_id can NEVER become the consent subject (forgery guard)", async () => {
    const { controller, consent } = make();
    const dto = { consent_version: "v", purposes: ["profiling"], worker_id: "victim" };
    await controller.accept(sessionWorker("attacker"), dto as never, "1.2.3.4", "ua", CTX);
    expect(consent.accept.mock.calls[0]![0]).toBe("attacker");
  });

  it("withdraw forwards the session worker id + ctx to the service", async () => {
    const { controller, consent } = make();
    await controller.withdraw(sessionWorker("w"), CTX);
    expect(consent.withdraw).toHaveBeenCalledWith("w", CTX);
    expect(consent.withdraw.mock.calls[0]![0]).toBeDefined();
  });
});
