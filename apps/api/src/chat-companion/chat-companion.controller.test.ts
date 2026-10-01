import "reflect-metadata";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { AllExceptionsFilter } from "../common/filters/all-exceptions.filter";
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

  it("on the WIRE the 409 is the global error envelope, with the mode under `error`", async () => {
    const service = { open: vi.fn(), message: vi.fn(async () => ({ mode: "interview" })) };
    const ctrl = new ChatCompanionController(service as never);
    const err = await ctrl.message(WORKER as never, { text: "hi" }, CTX as never).catch((e: unknown) => e);
    const sent: { status?: number; body?: Record<string, unknown> } = {};
    const res = {
      status: (code: number) => {
        sent.status = code;
        return res;
      },
      json: (body: Record<string, unknown>) => {
        sent.body = body;
      },
    };
    const host = {
      switchToHttp: () => ({
        getResponse: () => res,
        getRequest: () => ({ requestId: "r", url: "/chat/companion/message", method: "POST" }),
      }),
    };
    new AllExceptionsFilter().catch(err, host as never);
    expect(sent.status).toBe(409);
    expect(sent.body).toMatchObject({ statusCode: 409, error: { mode: "interview" } });
    expect(sent.body).not.toHaveProperty("mode");
  });

  it("marks every response no-store — the recap and the card are per worker and change as they apply", () => {
    for (const handler of ["open", "message", "confirmEdit", "cancelEdit"] as const) {
      const target = (ChatCompanionController.prototype as unknown as Record<string, object>)[handler]!;
      const headers = Reflect.getMetadata("__headers__", target) as { name: string; value: string }[];
      expect(headers).toContainEqual({ name: "Cache-Control", value: "no-store" });
    }
  });

  // ── the edit-card routes (ADR-0046 T8, contracts §5.2) ─────────────────────────────────────

  const PROPOSAL = "99999999-9999-4999-8999-999999999999";

  it("confirm returns the turn on 200", async () => {
    const turn = { mode: "companion", reply: "Badlav ho gaya." };
    const service = {
      open: vi.fn(),
      message: vi.fn(),
      confirmEdit: vi.fn(async () => ({ mode: "companion", turn })),
      cancelEdit: vi.fn(),
    };
    const ctrl = new ChatCompanionController(service as never);
    expect(await ctrl.confirmEdit(WORKER as never, PROPOSAL, { row_ids: [PROPOSAL] }, CTX as never)).toBe(turn);
    expect(service.confirmEdit).toHaveBeenCalledWith(WORKER.id, PROPOSAL, { row_ids: [PROPOSAL] }, CTX);
  });

  it("confirm outside companion mode is a 409 {mode:'interview'}", async () => {
    const service = {
      open: vi.fn(),
      message: vi.fn(),
      confirmEdit: vi.fn(async () => ({ mode: "interview" })),
      cancelEdit: vi.fn(),
    };
    const ctrl = new ChatCompanionController(service as never);
    const err = await ctrl
      .confirmEdit(WORKER as never, PROPOSAL, { row_ids: [PROPOSAL] }, CTX as never)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toEqual({ mode: "interview" });
  });

  it("a STALE card is a 409 {reason:'stale', turn} — the reviewed line rides the body (CON-5.2b)", async () => {
    const turn = { mode: "companion", reply: "Profile beech mein badal gaya." };
    const service = {
      open: vi.fn(),
      message: vi.fn(),
      confirmEdit: vi.fn(async () => ({ mode: "stale", turn })),
      cancelEdit: vi.fn(),
    };
    const ctrl = new ChatCompanionController(service as never);
    const err = await ctrl
      .confirmEdit(WORKER as never, PROPOSAL, { row_ids: [PROPOSAL] }, CTX as never)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    // `reason` is unchanged (a shipped app routes on it); `turn` is additive.
    expect((err as ConflictException).getResponse()).toEqual({ reason: "stale", turn });
  });

  it("an unknown/expired/other worker's proposal is a 404 — no cross-worker oracle", async () => {
    const service = {
      open: vi.fn(),
      message: vi.fn(),
      confirmEdit: vi.fn(async () => ({ mode: "not_found" })),
      cancelEdit: vi.fn(async () => ({ mode: "not_found" })),
    };
    const ctrl = new ChatCompanionController(service as never);
    await expect(
      ctrl.confirmEdit(WORKER as never, PROPOSAL, { row_ids: [PROPOSAL] }, CTX as never),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(ctrl.cancelEdit(WORKER as never, PROPOSAL, {}, CTX as never)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("cancel returns the turn on 200", async () => {
    const turn = { mode: "companion", reply: "Theek hai, kuch nahi badla." };
    const service = {
      open: vi.fn(),
      message: vi.fn(),
      confirmEdit: vi.fn(),
      cancelEdit: vi.fn(async () => ({ mode: "companion", turn })),
    };
    const ctrl = new ChatCompanionController(service as never);
    expect(await ctrl.cancelEdit(WORKER as never, PROPOSAL, {}, CTX as never)).toBe(turn);
  });
});
