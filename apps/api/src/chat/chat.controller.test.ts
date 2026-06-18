import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { ChatController } from "./chat.controller";
import type { ChatService } from "./chat.service";
import type { AuthenticatedWorker } from "../auth/worker-auth.guard";
import type { RequestContext } from "../common/request-context";

const CTX = { correlationId: "c", requestId: "r" } as RequestContext;
const WORKER: AuthenticatedWorker = { id: "11111111-1111-4111-8111-111111111111", sid: "sid" };

function make() {
  const chat = {
    startSession: vi.fn(async () => ({ session_id: "s", status: "active" })),
    postMessage: vi.fn(async () => ({ session_id: "s", reply: "hi" })),
  };
  return { controller: new ChatController(chat as unknown as ChatService), chat };
}

describe("ChatController (thin) — worker from token, never the body", () => {
  it("startSession passes the authenticated worker id (ignores any body)", async () => {
    const { controller, chat } = make();
    await controller.startSession(WORKER, {} as never, CTX);
    expect(chat.startSession).toHaveBeenCalledWith(WORKER.id, CTX);
  });

  it("postMessage passes the authenticated worker id + dto", async () => {
    const { controller, chat } = make();
    const dto = { session_id: "s", text: "hello" };
    await controller.postMessage(WORKER, dto as never, CTX);
    expect(chat.postMessage).toHaveBeenCalledWith(WORKER.id, dto, CTX);
  });
});
