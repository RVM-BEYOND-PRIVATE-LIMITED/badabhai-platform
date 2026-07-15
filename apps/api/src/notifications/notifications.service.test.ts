import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { isEventName } from "@badabhai/event-schema";
import type { EventRow } from "@badabhai/db";
import { NotificationsService } from "./notifications.service";
import type { NotificationsRepository } from "./notifications.repository";
import {
  NOTIFICATION_EVENT_NAMES,
  NOTIFICATION_TEMPLATES,
} from "./notifications.dto";

/** Minimal EventRow the service actually reads (id, eventName, occurredAt). */
function row(eventName: string, id: string, occurredAt: string): EventRow {
  return {
    id,
    eventName,
    occurredAt: new Date(occurredAt),
    // Fields the service never reads — present so the shape is a valid EventRow.
    // A worker_id/payer_id sentinel in the payload proves the projection NEVER
    // passes the payload through (it must not appear in the output).
    payload: { worker_id: "w-secret", payer_id: "p-secret", employer_name: "ACME Pvt Ltd" },
    eventVersion: 1,
    actorType: "system",
    actorId: null,
    subjectType: "worker",
    subjectId: "w-1",
    correlationId: "c-1",
    causationId: null,
    idempotencyKey: null,
    metadata: {},
    createdAt: new Date(occurredAt),
  } as unknown as EventRow;
}

function setup(rows: EventRow[]) {
  const repo = { findForWorker: vi.fn(async (_id: string, _limit: number) => rows) };
  const svc = new NotificationsService(repo as unknown as NotificationsRepository);
  return { svc, repo };
}

describe("NotificationsService.getForWorker — projection", () => {
  it("maps each allowlisted event to its faceless template row (id, type, copy, ISO time), order preserved", async () => {
    const { svc } = setup([
      row("resume.generated", "e1", "2026-07-14T10:00:00.000Z"),
      row("profile.confirmed", "e2", "2026-07-14T09:00:00.000Z"),
    ]);
    const out = await svc.getForWorker("w-1");

    expect(out).toEqual([
      {
        id: "e1",
        type: "resume_ready",
        title: NOTIFICATION_TEMPLATES["resume.generated"]!.title,
        body: NOTIFICATION_TEMPLATES["resume.generated"]!.body,
        created_at: "2026-07-14T10:00:00.000Z",
      },
      {
        id: "e2",
        type: "profile_ready",
        title: NOTIFICATION_TEMPLATES["profile.confirmed"]!.title,
        body: NOTIFICATION_TEMPLATES["profile.confirmed"]!.body,
        created_at: "2026-07-14T09:00:00.000Z",
      },
    ]);
  });

  it("NEVER passes the event payload through — no worker_id/payer_id/employer in the output", async () => {
    const { svc } = setup([row("resume.generated", "e1", "2026-07-14T10:00:00.000Z")]);
    const out = await svc.getForWorker("w-1");
    const json = JSON.stringify(out);
    // The payload sentinels must not survive the projection.
    expect(json).not.toContain("w-secret");
    expect(json).not.toContain("p-secret");
    expect(json).not.toMatch(/ACME|employer_name|payer_id|worker_id/i);
  });

  it("skips a non-allowlisted event defensively (never renders an untemplated name)", async () => {
    const { svc } = setup([
      row("chat.message_sent", "e0", "2026-07-14T11:00:00.000Z"), // not in templates
      row("resume.generated", "e1", "2026-07-14T10:00:00.000Z"),
    ]);
    const out = await svc.getForWorker("w-1");
    expect(out.map((n) => n.id)).toEqual(["e1"]);
  });

  it("passes the token worker id + a bounded limit to the repository", async () => {
    const { svc, repo } = setup([]);
    await svc.getForWorker("w-token-1");
    expect(repo.findForWorker).toHaveBeenCalledTimes(1);
    const [id, limit] = repo.findForWorker.mock.calls[0]!;
    expect(id).toBe("w-token-1");
    expect(typeof limit).toBe("number");
    expect(limit).toBeGreaterThan(0);
  });
});

describe("notifications allowlist — validity + faceless copy", () => {
  it("every allowlisted name is a REAL registered event (no typos/drift)", () => {
    for (const name of NOTIFICATION_EVENT_NAMES) {
      expect(isEventName(name), `${name} must be a registered event`).toBe(true);
    }
  });

  it("the event-name list is DERIVED from the templates (cannot drift)", () => {
    expect([...NOTIFICATION_EVENT_NAMES].sort()).toEqual(
      Object.keys(NOTIFICATION_TEMPLATES).sort(),
    );
  });

  it("all copy is faceless + PII-free — no employer/company, no ₹/pay, no phone-like digits, no email", () => {
    for (const [name, t] of Object.entries(NOTIFICATION_TEMPLATES)) {
      const text = `${t.title} ${t.body}`;
      expect(text, `${name} copy must not name an employer/company`).not.toMatch(
        /\bemployer\b|\bcompany\b|\bpayer\b/i,
      );
      expect(text, `${name} copy must not carry ₹/pay`).not.toMatch(/₹|\brs\.?\b|\bsalary\b|\bpay\b/i);
      expect(text, `${name} copy must not carry a phone-like digit run`).not.toMatch(/\d{4,}/);
      expect(text, `${name} copy must not carry an email`).not.toContain("@");
    }
  });
});
