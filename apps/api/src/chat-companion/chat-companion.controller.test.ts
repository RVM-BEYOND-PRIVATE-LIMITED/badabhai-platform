import "reflect-metadata";
import { ConflictException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { ChatCompanionController } from "./chat-companion.controller";

const WORKER = { id: "11111111-1111-4111-8111-111111111111" };
const CTX = { requestId: "r", correlationId: "c" };

describe("ChatCompanionController — HTTP only", () => {
  it("GET hands the bearer's worker to the service and returns its answer untouched", async () => {
    const service = { open: vi.fn(async () => ({ mode: "interview" })), message: vi.fn() };
    const ctrl = new ChatCompanionController(service as never);
    expect(await ctrl.open(WORKER as never, CTX as never)).toEqual({ mode: "interview" });
    expect(service.open).toHaveBeenCalledWith(WORKER.id, CTX);
  });

  it("POST returns the turn in companion mode", async () => {
    const turn = { mode: "companion", reply: "x" };
    const service = { open: vi.fn(), message: vi.fn(async () => ({ mode: "companion", turn })) };
    const ctrl = new ChatCompanionController(service as never);
    expect(await ctrl.message(WORKER as never, { text: "hi" }, CTX as never)).toBe(turn);
  });

  it("POST outside companion mode is a 409 {mode:'interview'} — the app resends down today's path", async () => {
    const service = { open: vi.fn(), message: vi.fn(async () => ({ mode: "interview" })) };
    const ctrl = new ChatCompanionController(service as never);
    const err = await ctrl.message(WORKER as never, { text: "hi" }, CTX as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toEqual({ mode: "interview" });
  });

  it("marks both responses no-store — the recap is per worker and changes as they apply", () => {
    for (const handler of ["open", "message"] as const) {
      const target = (ChatCompanionController.prototype as unknown as Record<string, object>)[handler]!;
      const headers = Reflect.getMetadata("__headers__", target) as { name: string; value: string }[];
      expect(headers).toContainEqual({ name: "Cache-Control", value: "no-store" });
    }
  });
});
