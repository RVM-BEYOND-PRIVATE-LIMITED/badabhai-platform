import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { EVENT_REGISTRY, isEventName } from "@badabhai/event-schema";
import type { EventRow } from "@badabhai/db";
import { NotificationsService } from "./notifications.service";
import type { NotificationsRepository } from "./notifications.repository";
import {
  NOTIFICATION_EVENT_NAMES,
  NOTIFICATION_TEMPLATES,
  SECURITY_EVENT_NAMES,
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

/**
 * Mocks BOTH repository legs (TD82). The security leg EMULATES the real query rather
 * than echoing `rows`: it filters to {@link SECURITY_EVENT_NAMES} and applies its own
 * limit, exactly as the SQL does — so a test that overflows the main feed sees the same
 * union the database would produce.
 */
function setup(rows: EventRow[], securityRows?: EventRow[]) {
  const repo = {
    findForWorker: vi.fn(async (_id: string, limit: number) => rows.slice(0, limit)),
    findSecurityForWorker: vi.fn(async (_id: string, limit: number) =>
      (securityRows ?? rows)
        .filter((r) => SECURITY_EVENT_NAMES.includes(r.eventName))
        .slice(0, limit),
    ),
  };
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

describe("TD82 — security alerts get RESERVED slots and cannot be evicted by applies", () => {
  const WORKER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  /** N applies, newest first, all NEWER than `olderThan`. */
  function applyFlood(n: number, olderThan: string): EventRow[] {
    const base = new Date(olderThan).getTime();
    return Array.from({ length: n }, (_, i) =>
      // +1 minute apart, all after the tripwire → they outrank it on occurred_at.
      row("application.submitted", `e-apply-${i}`, new Date(base + (i + 1) * 60_000).toISOString()),
    ).reverse(); // newest first, as the repository returns
  }

  it("THE TD82 SCENARIO: a device-registration tripwire survives a 50-apply flood", async () => {
    // Attacker registers a device on a compromised account; the worker then swipes 50
    // distinct jobs in one session. Pre-fix, the tripwire fell out of the newest-50
    // window and the worker never saw it — silently, since there is no pagination and
    // no server-side read state.
    const TRIPWIRE = "2026-07-17T08:00:00.000Z";
    const tripwire = row("worker.device_registered", "e-tripwire", TRIPWIRE);
    const flood = applyFlood(50, TRIPWIRE);

    // The main leg is capped at 50 and every apply is newer → the tripwire is EVICTED
    // from it. Only the reserved security leg can carry it.
    const mainLeg = [...flood, tripwire];
    const { svc } = setup(mainLeg);
    const out = await svc.getForWorker(WORKER);

    const tripwireRow = out.find((n) => n.id === "e-tripwire");
    expect(tripwireRow, "the device-registration tripwire must NOT be evicted").toBeDefined();
    expect(tripwireRow!.type).toBe("security");
  });

  it("the reserved leg is queried with its OWN bound — the caller's id and the security cap", async () => {
    const { svc, repo } = setup([]);
    await svc.getForWorker(WORKER);

    // Both legs bound to the CALLER — never a payload/subject id from a row.
    expect(repo.findForWorker).toHaveBeenCalledWith(WORKER, expect.any(Number));
    expect(repo.findSecurityForWorker).toHaveBeenCalledWith(WORKER, expect.any(Number));
  });

  it("dedupes across the two legs — a security event inside the newest 50 appears ONCE", async () => {
    // The overlap case: the tripwire is recent enough to be in BOTH legs.
    const tripwire = row("worker.device_registered", "e-dup", "2026-07-17T10:00:00.000Z");
    const { svc } = setup([tripwire, row("resume.generated", "e-other", "2026-07-17T09:00:00.000Z")]);

    const out = await svc.getForWorker(WORKER);
    expect(out.filter((n) => n.id === "e-dup")).toHaveLength(1);
  });

  it("the merged feed stays newest-first across BOTH legs", async () => {
    const { svc } = setup([
      row("application.submitted", "e-new", "2026-07-17T12:00:00.000Z"),
      row("worker.device_registered", "e-mid", "2026-07-17T11:00:00.000Z"),
      row("resume.generated", "e-old", "2026-07-17T10:00:00.000Z"),
    ]);

    const out = await svc.getForWorker(WORKER);
    expect(out.map((n) => n.id)).toEqual(["e-new", "e-mid", "e-old"]);
  });

  it("the security set is DERIVED from the templates — it cannot drift from the allowlist", () => {
    // Every reserved name must be an allowlisted name with type 'security'; nothing else.
    const expected = Object.entries(NOTIFICATION_TEMPLATES)
      .filter(([, t]) => t.type === "security")
      .map(([name]) => name)
      .sort();
    expect([...SECURITY_EVENT_NAMES].sort()).toEqual(expected);

    for (const name of SECURITY_EVENT_NAMES) {
      expect(NOTIFICATION_EVENT_NAMES, `${name} must also be allowlisted`).toContain(name);
    }
  });

  it("the reserve is NON-EMPTY — an empty security set would silently disable the guarantee", () => {
    // If every security template were ever retyped/removed, the reserved leg would
    // short-circuit to [] and TD82 would regress with all tests still green.
    expect(SECURITY_EVENT_NAMES.length).toBeGreaterThan(0);
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

  /**
   * DEMAND-SIDE BAN — by PAYLOAD SHAPE, not by name (TD83(a), 2026-07-17).
   *
   * The original ban was a hand-written prefix regex, and it was false assurance: two of
   * its seven prefixes (`credit.`, `boost.`) matched NOTHING in the registry (the real
   * names are `coupon.redeemed` / `job_posting.boosted`), and it MISSED `applicant.viewed`
   * — the profile-view signal its own docstring named as must-never-surface — plus
   * `resume.disclosed`. Both carry `worker_id`, so both would SCOPE to a worker and
   * SURFACE.
   *
   * Name- and domain-matching cannot work here BY CONSTRUCTION: `resume.generated`
   * (lifecycle, allowlisted) and `resume.disclosed` (demand-side) share both a prefix AND
   * a `domain: "resume"`. Any discriminator built on either is unfixable.
   *
   * The discriminator that DOES hold: an event whose payload names a PAYER is, by
   * definition, describing something the demand side did or received. Read straight off
   * the registry's Zod schema, so it cannot drift as the registry grows.
   */
  const COUNTERPARTY_PAYLOAD_KEY = "payer_id";

  /**
   * The payload's field names, read from the registry's Zod schema.
   *
   * Duck-typed on purpose. `payload instanceof z.ZodObject` is UNRELIABLE here: this
   * package and @badabhai/event-schema resolve their own copies of zod, so the class
   * identities differ and `instanceof` is false for EVERY entry — which would make the
   * ban below pass vacuously on an empty key list. Returns null (never []) when the
   * shape cannot be read, so the caller can fail loud instead of silently passing.
   */
  function payloadShapeKeys(name: string): string[] | null {
    const payload = (EVENT_REGISTRY as Record<string, { payload?: unknown }>)[name]?.payload as
      | { shape?: unknown; _def?: { shape?: unknown } }
      | undefined;
    const shape = payload?.shape ?? payload?._def?.shape;
    const resolved = typeof shape === "function" ? (shape as () => unknown)() : shape;
    return resolved && typeof resolved === "object"
      ? Object.keys(resolved as Record<string, unknown>)
      : null;
  }

  it("EVERY registry payload's shape is readable — the ban below is never vacuous", () => {
    // The guard that guards the guard. If a payload ever stops being introspectable
    // (a zod upgrade, a z.union payload, a dual-package break), the ban silently
    // inspects nothing and passes. Fail HERE instead, loudly.
    for (const name of Object.keys(EVENT_REGISTRY)) {
      expect(payloadShapeKeys(name), `${name}: payload shape unreadable — the ban would go vacuous`)
        .not.toBeNull();
    }
  });

  it("no allowlisted event's payload names a PAYER — demand-side signals can never reach a worker", () => {
    for (const name of NOTIFICATION_EVENT_NAMES) {
      const keys = payloadShapeKeys(name);
      expect(keys, `${name}: payload shape unreadable`).not.toBeNull();
      expect(
        keys,
        `${name} carries ${COUNTERPARTY_PAYLOAD_KEY} — it describes what a PAYER did/received and must never reach a worker`,
      ).not.toContain(COUNTERPARTY_PAYLOAD_KEY);
    }
  });

  it("the ban has TEETH — it rejects every known scope-AND-surface event in the registry", () => {
    // Proven against REAL registry entries, not a hypothetical. Each of these carries
    // `worker_id` (so the repository's payload leg WOULD scope it to a worker) AND
    // `payer_id` (so it is demand-side) — i.e. allowlisting any one of them would ship a
    // payer signal to a worker. The ban above must catch all of them.
    //
    // The two marked (*) are precisely what the old prefix regex missed.
    const SCOPE_AND_SURFACE = [
      "unlock.requested",
      "unlock.granted",
      "unlock.denied",
      "unlock.cap_exceeded",
      "contact.revealed",
      "applicant.viewed", // (*) the profile-view signal
      "resume.disclosed", // (*) shares prefix AND domain with allowlisted resume.generated
    ];

    for (const name of SCOPE_AND_SURFACE) {
      const keys = payloadShapeKeys(name);
      expect(keys, `${name}: payload shape unreadable`).not.toBeNull();
      expect(keys, `${name} must carry worker_id (else it would not scope to a worker)`).toContain(
        "worker_id",
      );
      expect(keys, `${name} must carry ${COUNTERPARTY_PAYLOAD_KEY} (the ban's discriminator)`).toContain(
        COUNTERPARTY_PAYLOAD_KEY,
      );
    }
  });
});
