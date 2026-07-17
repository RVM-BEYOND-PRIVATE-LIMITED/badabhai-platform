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
function row(
  eventName: string,
  id: string,
  occurredAt: string,
  overrides: Partial<Record<string, unknown>> = {},
): EventRow {
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
    ...overrides,
  } as unknown as EventRow;
}

/**
 * A REAL `application.submitted` row as applications.service.ts emits it:
 * actor={worker,workerId}, subject={job,jobId}, payload={worker_id,job_id,rank,
 * source_surface}. Every payload field is a loud sentinel — none may reach the wire.
 */
function applicationRow(id: string, occurredAt: string, workerId: string): EventRow {
  return row("application.submitted", id, occurredAt, {
    actorType: "worker",
    actorId: workerId,
    subjectType: "job", // NOT "worker" — the subject leg cannot scope this event
    subjectId: "job-SENTINEL-9",
    payload: {
      worker_id: workerId,
      job_id: "job-SENTINEL-9",
      rank: 424242,
      source_surface: "SENTINEL_FEED",
    },
  });
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

describe("application.submitted → the worker's OWN apply receipt (2026-07-17 widening)", () => {
  const WORKER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  it("surfaces in the feed for its OWN worker as type `application_sent` with the exact faceless copy", async () => {
    const { svc } = setup([applicationRow("e-app-1", "2026-07-17T10:00:00.000Z", WORKER_A)]);
    const out = await svc.getForWorker(WORKER_A);

    expect(out).toEqual([
      {
        id: "e-app-1",
        type: "application_sent",
        // Copy pinned as LITERALS (not via the template map, which would be
        // tautological): a copy change must be a deliberate test change.
        title: "Application bhej di",
        body: "Aapki application aage pahunch gayi.",
        created_at: "2026-07-17T10:00:00.000Z",
      },
    ]);
  });

  it("the rendered copy matches the allowlist template exactly (no drift between map and wire)", async () => {
    const { svc } = setup([applicationRow("e-app-1", "2026-07-17T10:00:00.000Z", WORKER_A)]);
    const [note] = await svc.getForWorker(WORKER_A);
    const template = NOTIFICATION_TEMPLATES["application.submitted"]!;
    expect(note!.type).toBe(template.type);
    expect(note!.title).toBe(template.title);
    expect(note!.body).toBe(template.body);
  });

  it("the wire row carries EXACTLY {id,type,title,body,created_at} — no job_id/worker_id/rank/source_surface", async () => {
    const { svc } = setup([applicationRow("e-app-1", "2026-07-17T10:00:00.000Z", WORKER_A)]);
    const [note] = await svc.getForWorker(WORKER_A);

    // Exact key set — an added passthrough field (job_id, rank, …) fails here.
    expect(Object.keys(note!).sort()).toEqual(["body", "created_at", "id", "title", "type"]);

    // …and no payload VALUE survives the projection, under any key name.
    const json = JSON.stringify(note);
    expect(json).not.toContain("job-SENTINEL-9");
    expect(json).not.toContain("SENTINEL_FEED");
    expect(json).not.toContain("424242");
    expect(json).not.toContain(WORKER_A);
    expect(json).not.toMatch(/job_id|worker_id|rank|source_surface|payer/i);
  });

  it("does NOT surface for a DIFFERENT worker — the feed renders only what the worker-scoped read returns", async () => {
    // Worker B's read: the repository's SQL predicate (subject|actor|payload legs,
    // all bound to the CALLER) matches no row of worker A's apply, so the read is
    // empty. The service invents nothing — B's feed is empty.
    // NOTE: this pins the SERVICE half (it adds no rows of its own). The SQL half —
    // that A's apply cannot match B's predicate, which for subject_type='job' rests
    // entirely on the actor + payload legs — is pinned in notifications.repository.test.ts.
    const { svc, repo } = setup([]);
    const out = await svc.getForWorker("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");

    expect(out).toEqual([]);
    // The read is scoped by the CALLER's id — never a payload/subject id from a row.
    expect(repo.findForWorker).toHaveBeenCalledWith(
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      expect.any(Number),
    );
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

  /**
   * MEMBERSHIP SNAPSHOT — the one test in this file that is NOT derived from the map,
   * and the reason it exists: every other allowlist test above takes the map as its
   * own oracle, so they all stay green when a new entry is added. The copy sweep only
   * judges COPY, not PROVENANCE — so a demand/payer signal with innocent-looking copy
   * (e.g. `unlock.granted` → "Kisi ne aapki profile dekhi", whose payload carries
   * `worker_id` and would therefore scope + surface) sails through every one of them.
   *
   * This list is the deliberate-review gate: adding an event to the feed MUST be a
   * conscious edit here. Before adding one, check it is the WORKER's own lifecycle or
   * own act — never something an EMPLOYER did (2026-07-17 scope ruling, see
   * notifications.dto.ts + docs/registers/architecture-log.md).
   */
  it("the allowlist membership is EXACTLY these events — adding one is a deliberate, reviewed edit", () => {
    expect([...NOTIFICATION_EVENT_NAMES].sort()).toEqual([
      "application.submitted",
      "profile.confirmed",
      "resume.generated",
      "resume.regenerated",
      "voice_note.transcription_completed",
      "worker.device_registered",
      "worker.logged_out_all",
    ]);
  });

  it("no allowlisted event is a payer/demand-side signal (the half of the scope line that still holds)", () => {
    for (const name of NOTIFICATION_EVENT_NAMES) {
      expect(name, `${name} is a demand-side signal — it must never reach a worker`).not.toMatch(
        /^(unlock|contact|payment|payer|credit|boost|job_posting)\./,
      );
    }
  });
});
