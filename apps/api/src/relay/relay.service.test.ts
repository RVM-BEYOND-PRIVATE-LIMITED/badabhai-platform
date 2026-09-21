import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { BadRequestException } from "@nestjs/common";
import type { RelayMessage } from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import { RelayService } from "./relay.service";
import type { RelayRepository } from "./relay.repository";
import type { UnlockService } from "../unlocks/unlocks.service";
import type { EventsService } from "../events/events.service";

const CTX = { correlationId: "c", requestId: "r" } as RequestContext;
const PAYER = "11111111-1111-4111-8111-111111111111";
const WORKER = "22222222-2222-4222-8222-222222222222";
const UNLOCK = "33333333-3333-4333-8333-333333333333";
const HANDLE =
  "relay_44444444-4444-4444-4444-444444444444_55555555-5555-4555-8555-555555555555";
const RESOLUTION = { unlockId: UNLOCK, workerId: WORKER };
const SENTINEL_TEXT = "SENTINEL-message-body-987654321";

function messageRow(overrides: Record<string, unknown> = {}): RelayMessage {
  return {
    id: "msg-1",
    unlockId: UNLOCK,
    direction: "payer_to_worker",
    kind: "template",
    templateId: "availability",
    body: { template_id: "availability", params: {} },
    createdAt: new Date("2026-09-21T10:00:00.000Z"),
    readAt: null,
    ...overrides,
  } as unknown as RelayMessage;
}

interface SetupOpts {
  /** `null` simulates a failed resolution (the neutral path). */
  resolvePayer?: unknown;
  resolveWorker?: unknown;
  hasReply?: boolean;
}

function setup(opts: SetupOpts = {}) {
  const relay = {
    insert: vi.fn(async (input: Record<string, unknown>) => messageRow(input)),
    listByUnlock: vi.fn(async () => [] as RelayMessage[]),
    hasWorkerReply: vi.fn(async () => opts.hasReply ?? false),
    markInboundRead: vi.fn(async () => 0),
    listThreadsForWorker: vi.fn(async () => []),
  };
  const unlocks = {
    resolveRelayForPayer: vi.fn(async () =>
      opts.resolvePayer === undefined ? RESOLUTION : opts.resolvePayer,
    ),
    resolveRelayForWorker: vi.fn(async () =>
      opts.resolveWorker === undefined ? RESOLUTION : opts.resolveWorker,
    ),
  };
  const events = { emit: vi.fn(async (p: Record<string, unknown>) => p) };
  const svc = new RelayService(
    relay as unknown as RelayRepository,
    unlocks as unknown as UnlockService,
    events as unknown as EventsService,
  );
  return { svc, relay, unlocks, events };
}

const emitted = (events: { emit: { mock: { calls: unknown[][] } } }): string[] =>
  events.emit.mock.calls.map((c) => (c[0] as { event_name: string }).event_name);

describe("RelayService — the payer's send (§B: template opening, free text after the reply)", () => {
  it("accepts a closed template, stores id+params, and emits BOTH the sent and received events", async () => {
    const { svc, relay, events } = setup();
    const out = await svc.sendFromPayer(
      PAYER,
      HANDLE,
      { kind: "template", template_id: "availability", params: {} },
      CTX,
    );
    expect(out).toMatchObject({ message_id: "msg-1" });
    expect(relay.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        unlockId: UNLOCK,
        direction: "payer_to_worker",
        kind: "template",
        templateId: "availability",
        body: { template_id: "availability", params: {} },
      }),
    );
    expect(emitted(events)).toEqual(["relay.message_sent", "relay.message_received"]);
    const received = events.emit.mock.calls[1]![0] as { payload: Record<string, unknown> };
    expect(received.payload).toEqual({
      worker_id: WORKER,
      unlock_id: UNLOCK,
      message_id: "msg-1",
    });
  });

  it("REJECTS free text while the worker has not replied — the §B shape rule", async () => {
    const { svc, relay, events } = setup({ hasReply: false });
    await expect(
      svc.sendFromPayer(PAYER, HANDLE, { kind: "text", text: SENTINEL_TEXT }, CTX),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(relay.insert).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("accepts free text once the worker has replied", async () => {
    const { svc, relay } = setup({ hasReply: true });
    await svc.sendFromPayer(PAYER, HANDLE, { kind: "text", text: SENTINEL_TEXT }, CTX);
    expect(relay.insert).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "text", templateId: null, body: { text: SENTINEL_TEXT } }),
    );
  });

  it("a failed resolution returns the ONE neutral body and writes NOTHING", async () => {
    const { svc, relay, events } = setup({ resolvePayer: null });
    const out = await svc.sendFromPayer(
      PAYER,
      HANDLE,
      { kind: "template", template_id: "rate", params: {} },
      CTX,
    );
    expect(out).toEqual({ status: "unavailable" });
    expect(relay.insert).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("never puts the message body on the event spine", async () => {
    const { svc, events } = setup({ hasReply: true });
    await svc.sendFromPayer(PAYER, HANDLE, { kind: "text", text: SENTINEL_TEXT }, CTX);
    expect(JSON.stringify(events.emit.mock.calls)).not.toContain(SENTINEL_TEXT);
  });
});

describe("RelayService — the worker's read/reply", () => {
  it("reply stores free text, emits message_sent ONLY (never message_received)", async () => {
    const { svc, relay, events } = setup();
    await svc.replyFromWorker(WORKER, UNLOCK, { text: SENTINEL_TEXT }, CTX);
    expect(relay.insert).toHaveBeenCalledWith(
      expect.objectContaining({ direction: "worker_to_payer", kind: "text", body: { text: SENTINEL_TEXT } }),
    );
    expect(emitted(events)).toEqual(["relay.message_sent"]);
    expect(JSON.stringify(events.emit.mock.calls)).not.toContain(SENTINEL_TEXT);
  });

  it("reply fails closed (neutral, no write) when the resolution fails", async () => {
    const { svc, relay, events } = setup({ resolveWorker: null });
    expect(await svc.replyFromWorker(WORKER, UNLOCK, { text: SENTINEL_TEXT }, CTX)).toEqual({
      status: "unavailable",
    });
    expect(relay.insert).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("read renders a template row from the CLOSED catalogue and never exposes the body column", async () => {
    const { svc, relay } = setup();
    relay.listByUnlock.mockResolvedValueOnce([
      messageRow({ templateId: "visit_day", body: { template_id: "visit_day", params: { day: "tomorrow" } } }),
      messageRow({
        id: "msg-2",
        direction: "worker_to_payer",
        kind: "text",
        templateId: null,
        body: { text: "Haan ji" },
      }),
    ]);
    const out = await svc.readThread(WORKER, UNLOCK);
    expect(out).toMatchObject({
      messages: [
        { message_id: "msg-1", direction: "payer_to_worker", text: "Aap kal aa sakte hain?" },
        { message_id: "msg-2", direction: "worker_to_payer", text: "Haan ji" },
      ],
    });
    // The stored body object never reaches the wire as-is.
    expect(JSON.stringify(out)).not.toContain("params");
  });

  it("read fails closed (neutral, no read) when the resolution fails", async () => {
    const { svc, relay } = setup({ resolveWorker: null });
    expect(await svc.readThread(WORKER, UNLOCK)).toEqual({ status: "unavailable" });
    expect(relay.listByUnlock).not.toHaveBeenCalled();
  });

  it("mark-read emits the audit event with the moved count, and NOTHING when zero moved", async () => {
    const moved = setup();
    moved.relay.markInboundRead.mockResolvedValueOnce(2);
    expect(await moved.svc.markThreadRead(WORKER, UNLOCK, CTX)).toEqual({ marked: 2 });
    const evt = moved.events.emit.mock.calls[0]![0] as { event_name: string; payload: Record<string, unknown> };
    expect(evt.event_name).toBe("relay.message_read");
    expect(evt.payload).toEqual({ unlock_id: UNLOCK, reader: "worker", count: 2 });

    const none = setup();
    expect(await none.svc.markThreadRead(WORKER, UNLOCK, CTX)).toEqual({ marked: 0 });
    expect(none.events.emit).not.toHaveBeenCalled();
  });
});

describe("RelayService — the payer's thread read (#1636)", () => {
  it("renders the thread for the payer's own handle, template rows included", async () => {
    const { svc, relay } = setup();
    relay.listByUnlock.mockResolvedValueOnce([
      messageRow(),
      messageRow({
        id: "msg-2",
        direction: "worker_to_payer",
        kind: "text",
        templateId: null,
        body: { text: "Haan ji" },
      }),
    ]);
    const out = await svc.readThreadForPayer(PAYER, HANDLE);
    expect(out).toMatchObject({
      messages: [
        { message_id: "msg-1", direction: "payer_to_worker", text: "Aap kaam ke liye available hain?" },
        { message_id: "msg-2", direction: "worker_to_payer", text: "Haan ji" },
      ],
    });
  });

  it("a failed resolution returns the ONE neutral body and reads nothing", async () => {
    const { svc, relay } = setup({ resolvePayer: null });
    expect(await svc.readThreadForPayer(PAYER, HANDLE)).toEqual({ status: "unavailable" });
    expect(relay.listByUnlock).not.toHaveBeenCalled();
  });

  it("carries no counterparty identity and never the raw body column", async () => {
    const { svc, relay } = setup();
    relay.listByUnlock.mockResolvedValueOnce([
      messageRow({ templateId: "visit_day", body: { template_id: "visit_day", params: { day: "tomorrow" } } }),
    ]);
    const out = await svc.readThreadForPayer(PAYER, HANDLE);
    const json = JSON.stringify(out);
    expect(json).not.toContain("params");
    expect(json).not.toMatch(/worker_id|payer_id|phone/i);
  });
});

describe("RelayService — the template catalogue", () => {  it("serves the closed set with its closed parameter vocabulary", () => {
    const { svc } = setup();
    const { templates } = svc.listTemplates();
    expect(templates.map((t) => t.template_id)).toEqual(["availability", "visit_day", "rate"]);
    const visitDay = templates.find((t) => t.template_id === "visit_day")!;
    expect(visitDay.params).toEqual([
      {
        name: "day",
        options: [
          { value: "today", label: "aaj" },
          { value: "tomorrow", label: "kal" },
          { value: "this_week", label: "is hafte" },
          { value: "next_week", label: "agle hafte" },
        ],
      },
    ]);
  });
});
