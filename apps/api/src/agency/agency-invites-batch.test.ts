import "reflect-metadata";
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Logger, ServiceUnavailableException } from "@nestjs/common";
import { AgencyService } from "./agency.service";

/**
 * ADR-0022 Amendment 3 — BATCH invite minting (`POST /payer/agency/invites/batch`).
 *
 * These tests pin the conditions that make batch minting structurally NOT the DEAD
 * module-2 "bulk worker/candidate upload": N independent invites, N independent codes,
 * N independent v1 events, no code on the spine or in a log line, no delivery capability,
 * and a partial failure that never decouples a row from its event.
 *
 * The cap-accounting conditions live in agency-invites-batch-cap.test.ts; the DTO-shape
 * conditions (the actual security boundary) live in agency.dto.test.ts.
 */

const PAYER_A = "11111111-1111-4111-8111-111111111111";
const CTX = { correlationId: "66666666-6666-4666-8666-666666666666", requestId: "req-1" };

type EmittedEvent = {
  event_name: string;
  actor: { actor_type: string; actor_id: string | null };
  subject: { subject_type: string; subject_id: string };
  payload: Record<string, unknown>;
  idempotencyKey?: string;
};

/** The invite id the in-memory `create` below mints on its Nth call. */
const inviteId = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** A Postgres unique-violation as the driver raises it (the 23505 the service classifies). */
const pgUnique = (constraint: string) =>
  Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), {
    code: "23505",
  });

/**
 * Mirrors `EVENT_EMIT_RETRIES` in agency.service.ts (module-private). The value is not the
 * property under test — that the emit is retried AT ALL, rather than abandoned on the first
 * failure leaving a live row off the spine, is.
 */
const EMIT_ATTEMPTS = 3;

/**
 * A service wired to in-memory repos. `create` returns a fresh uuid per call so each
 * invite has its own identity (which is what the per-invite event keying depends on).
 *
 * `failEmitOnCall` / `failEmitFromCall` fail the Nth `events.emit` (once, or from N onward)
 * with `emitError` — the seam the row/event coupling conditions are measured through.
 */
function make(
  opts: {
    failCreateOnCall?: number;
    failEmitOnCall?: number;
    failEmitFromCall?: number;
    emitError?: unknown;
  } = {},
) {
  let emitCalls = 0;
  const emit = vi.fn().mockImplementation(() => {
    emitCalls += 1;
    const fails =
      opts.failEmitOnCall === emitCalls ||
      (opts.failEmitFromCall !== undefined && emitCalls >= opts.failEmitFromCall);
    if (fails) return Promise.reject(opts.emitError ?? new Error("events insert failed"));
    return Promise.resolve(undefined);
  });
  let createCalls = 0;

  const invitesRepo = {
    create: vi
      .fn()
      .mockImplementation((input: { code: string; inviterPayerId: string; campaign?: string }) => {
        createCalls += 1;
        if (opts.failCreateOnCall === createCalls) {
          return Promise.reject(new Error("boom: relation agency_invites, duplicate key value"));
        }
        return Promise.resolve({
          id: inviteId(createCalls),
          code: input.code,
          inviterPayerId: input.inviterPayerId,
          campaign: input.campaign ?? null,
        });
      }),
    findByCode: vi.fn(),
    setStatus: vi.fn(),
    markAccepted: vi.fn(),
    stageCountsForOwner: vi.fn(),
  };

  const svc = new AgencyService({} as never, invitesRepo as never, {} as never, { emit } as never);
  return { svc, emit, invitesRepo, createdCount: () => createCalls };
}

function emitted(emit: ReturnType<typeof vi.fn>): EmittedEvent[] {
  return emit.mock.calls.map((c) => c[0] as EmittedEvent);
}

/**
 * The payload keys that actually carry a value. An optional field the caller omitted is
 * present as `undefined` (it is spelled out in the payload literal) and is dropped by JSON
 * serialization + the registry validator, so it is not a "key on the wire".
 */
function definedKeys(payload: Record<string, unknown>): string[] {
  return Object.entries(payload)
    .filter(([, v]) => v !== undefined)
    .map(([k]) => k)
    .sort();
}

afterEach(() => vi.restoreAllMocks());

describe("createInviteBatch — N invites, N codes, N events (C4, C11)", () => {
  it("mints exactly `count` invites with DISTINCT opaque codes and matching links", async () => {
    const { svc } = make();
    const { invites } = await svc.createInviteBatch(PAYER_A, 50, {}, CTX as never);

    expect(invites).toHaveLength(50);
    const codes = invites.map((i) => i.code);
    expect(new Set(codes).size).toBe(50);
    for (const inv of invites) {
      expect(inv.code).toMatch(/^[0-9a-f]{12}$/);
      expect(inv.link).toBe(`/i/${inv.code}`);
      expect(inv.agency_invite_id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  /**
   * C11 — every code is INDEPENDENTLY randomUUID-derived. A batch-derived scheme
   * (`<batchId>-01..50`, a counter, a timestamp, a shared prefix) would make 49 codes
   * guessable from ONE leaked code — a risk batching introduces that single mint has not.
   * A shared/derived prefix collapses the leading-4-hex space; independent randomness
   * keeps ~50 distinct prefixes out of 65536.
   */
  it("codes are INDEPENDENTLY random — no shared/derived prefix across the batch", async () => {
    const { svc } = make();
    const { invites } = await svc.createInviteBatch(PAYER_A, 50, {}, CTX as never);
    const prefixes = invites.map((i) => i.code.slice(0, 4));
    expect(new Set(prefixes).size).toBeGreaterThanOrEqual(45);
  });

  it("codes do not repeat ACROSS batches either", async () => {
    const { svc } = make();
    const a = await svc.createInviteBatch(PAYER_A, 25, {}, CTX as never);
    const b = await svc.createInviteBatch(PAYER_A, 25, {}, CTX as never);
    const all = [...a.invites, ...b.invites].map((i) => i.code);
    expect(new Set(all).size).toBe(50);
  });

  /**
   * C4 — ONE `agency_invite.created` v1 event PER INVITE ROW, each with its own
   * idempotency key. No batch event, no batch id, no count, no `codes[]`: each invite is an
   * independent state change with its own created → clicked → accepted lifecycle, and the
   * funnel arithmetic `referralsSummary` depends on would break under an aggregate event.
   */
  it("emits exactly N agency_invite.created events with N DISTINCT idempotency keys", async () => {
    const { svc, emit } = make();
    await svc.createInviteBatch(PAYER_A, 7, {}, CTX as never);

    const evts = emitted(emit);
    expect(evts).toHaveLength(7);
    expect(evts.every((e) => e.event_name === "agency_invite.created")).toBe(true);

    const keys = evts.map((e) => e.idempotencyKey);
    expect(new Set(keys).size).toBe(7);
    for (const k of keys) expect(k).toMatch(/^agency_invite\.created:[0-9a-f-]{36}$/);
    // The key is derived from the INVITE id — the same identity the subject carries.
    for (const e of evts)
      expect(e.idempotencyKey).toBe(`agency_invite.created:${e.subject.subject_id}`);
  });

  it("uses the UNMODIFIED v1 payload — exact keys, no batch field, NO code (C4, C13)", async () => {
    const { svc, emit } = make();
    const { invites } = await svc.createInviteBatch(PAYER_A, 5, {}, CTX as never);

    for (const e of emitted(emit)) {
      expect(definedKeys(e.payload)).toEqual(
        ["agency_invite_id", "channel", "inviter_payer_id"].sort(),
      );
      // No batch id, no count, no index, no codes[] — nothing batch-shaped on the spine.
      for (const forbidden of ["batch_id", "batchId", "count", "index", "codes", "code"]) {
        expect(e.payload).not.toHaveProperty(forbidden);
      }
      expect(e.actor).toEqual({ actor_type: "payer", actor_id: PAYER_A });
      expect(e.subject.subject_type).toBe("agency_invite");
    }
    // The code is a BEARER TOKEN — it must never enter the permanent audit spine.
    const serialized = JSON.stringify(emit.mock.calls);
    for (const inv of invites) expect(serialized).not.toContain(inv.code);
  });

  it("stamps inviter_payer_id from the SESSION payer on ALL N rows and ALL N events (C7/XB-A)", async () => {
    const { svc, emit, invitesRepo } = make();
    await svc.createInviteBatch(PAYER_A, 6, {}, CTX as never);

    for (const call of invitesRepo.create.mock.calls) {
      expect((call[0] as { inviterPayerId: string }).inviterPayerId).toBe(PAYER_A);
    }
    for (const e of emitted(emit)) expect(e.payload.inviter_payer_id).toBe(PAYER_A);
  });
});

describe("createInviteBatch — campaign is ONE scalar for the whole batch (C9)", () => {
  it("applies the IDENTICAL campaign to every row and every emitted payload", async () => {
    const { svc, emit, invitesRepo } = make();
    await svc.createInviteBatch(PAYER_A, 5, { campaign: "diwali-drive" }, CTX as never);

    expect(invitesRepo.create).toHaveBeenCalledTimes(5);
    for (const call of invitesRepo.create.mock.calls) {
      expect((call[0] as { campaign?: string }).campaign).toBe("diwali-drive");
    }
    const evts = emitted(emit);
    expect(evts).toHaveLength(5);
    for (const e of evts) expect(e.payload.campaign).toBe("diwali-drive");
    // Proof it is a batch-SCALAR, not a per-invite label: exactly one distinct value.
    expect(new Set(evts.map((e) => e.payload.campaign)).size).toBe(1);
  });

  it("carries NO campaign value when not supplied (payload stays the v1 three on the wire)", async () => {
    const { svc, emit } = make();
    await svc.createInviteBatch(PAYER_A, 2, {}, CTX as never);
    for (const e of emitted(emit)) {
      expect(e.payload.campaign).toBeUndefined();
      expect(JSON.parse(JSON.stringify(e.payload))).not.toHaveProperty("campaign");
    }
  });
});

describe("createInviteBatch — row/event coupling under partial failure (C5)", () => {
  /**
   * Never an event without a durably written row, never a row without its event. There is
   * no wrapping transaction on purpose: rolling back after events were emitted would leave
   * the spine referencing invite ids that no longer exist.
   */
  it("a mid-batch repository failure returns the minted SUBSET, with rows == events == codes", async () => {
    const { svc, emit, invitesRepo } = make({ failCreateOnCall: 27 });
    const { invites } = await svc.createInviteBatch(PAYER_A, 50, {}, CTX as never);

    expect(invites).toHaveLength(26);
    expect(invitesRepo.create).toHaveBeenCalledTimes(27); // 26 successes + the throwing one
    expect(emit).toHaveBeenCalledTimes(26); // no event for the row that failed
    expect(new Set(invites.map((i) => i.code)).size).toBe(26);
  });

  it("does NOT leak the DB error surface (no table/constraint name, no stack) on partial failure", async () => {
    const { svc } = make({ failCreateOnCall: 3 });
    const res = await svc.createInviteBatch(PAYER_A, 10, {}, CTX as never);
    const body = JSON.stringify(res);
    expect(body).not.toContain("agency_invites");
    expect(body).not.toContain("duplicate key");
    expect(body).not.toContain("at ");
  });

  /**
   * FINDING 1 (measured): the row insert and the event emit used to share one try block, so
   * an emit failure returned the already-minted subset and walked away from a durably
   * written row holding a LIVE 12-hex bearer code with NOTHING on the audit spine
   * (invariant #1) — while the surrounding comment claimed "never a row without its event".
   *
   * The emit is idempotency-keyed, so it is now RETRIED; if it still cannot be persisted the
   * row is named in an explicit, code-free reconciliation marker instead of vanishing. The
   * row survives (the invites repository exposes no void) — but it is discoverable, and its
   * code is returned to nobody.
   */
  it("an event-emit failure RETRIES the keyed emit and then names the orphan row — it is never silent", async () => {
    const logged: string[] = [];
    for (const level of ["log", "error", "warn", "debug", "verbose"] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation(((...args: unknown[]) => {
        logged.push(args.map((a) => String(a)).join(" "));
      }) as never);
    }

    const { svc, emit, invitesRepo } = make({ failEmitFromCall: 3 });
    const { invites } = await svc.createInviteBatch(PAYER_A, 5, {}, CTX as never);

    // The returned subset is EXACTLY the rows that made it onto the spine.
    expect(invites).toHaveLength(2);
    expect(invitesRepo.create).toHaveBeenCalledTimes(3);
    // 2 successful emits + the 3rd invite's emit RETRIED to exhaustion (not abandoned once).
    expect(emit).toHaveBeenCalledTimes(2 + EMIT_ATTEMPTS);
    const retried = emitted(emit).slice(2);
    expect(retried).toHaveLength(EMIT_ATTEMPTS);
    // Every retry carries the SAME idempotency key, so a landed-then-failed attempt cannot
    // double-write the event.
    expect(new Set(retried.map((e) => e.idempotencyKey)).size).toBe(1);
    expect(retried[0]?.idempotencyKey).toBe(`agency_invite.created:${inviteId(3)}`);

    // The orphan is FLAGGED, by invite id, so it can be reconciled.
    const blob = logged.join("\n");
    expect(blob).toContain("AUDIT ORPHAN");
    expect(blob).toContain(inviteId(3));
    // …and the marker is still PII/secret-free: no bearer code, no full payer id.
    for (const call of invitesRepo.create.mock.calls) {
      expect(blob).not.toContain((call[0] as { code: string }).code);
    }
    expect(blob).not.toContain(PAYER_A);
  });

  /**
   * FINDING 2 (measured): `if (!isUniqueViolation(err)) throw err` sat inside a try that also
   * wrapped `events.emit`, so a 23505 raised by the EVENTS idempotency-key unique index was
   * misread as an invite-code collision and re-ran the WHOLE iteration — a second
   * `invitesRepo.create`. Measured before the fix: count=1 gave ROWS CREATED 2, RETURNED 1.
   * The caller was charged one cap unit and got one code, while two rows existed and the
   * extra one held a live bearer code.
   */
  it("a 23505 from the EVENT insert retries the EMIT, never the ROW insert (no duplicate live code)", async () => {
    const { svc, emit, invitesRepo } = make({
      failEmitOnCall: 1,
      emitError: pgUnique("events_idempotency_key_uq"),
    });
    const { invites } = await svc.createInviteBatch(PAYER_A, 1, {}, CTX as never);

    expect(invites).toHaveLength(1);
    // THE assertion: one requested invite == one row. Before the fix this was 2.
    expect(invitesRepo.create).toHaveBeenCalledTimes(1);
    // The retry was of the EMIT, under the one invite's key — not a fresh mint.
    expect(emit).toHaveBeenCalledTimes(2);
    const keys = emitted(emit).map((e) => e.idempotencyKey);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe(`agency_invite.created:${inviteId(1)}`);
    expect(invites[0]?.agency_invite_id).toBe(inviteId(1));
    // The single returned code is the single row's code.
    expect(invites[0]?.code).toBe((invitesRepo.create.mock.calls[0]![0] as { code: string }).code);
  });

  it("a TOTAL failure surfaces a NEUTRAL 503 — no rows, no events, no DB error text", async () => {
    const { svc, emit } = make({ failCreateOnCall: 1 });
    await expect(
      svc.createInviteBatch(PAYER_A, 10, {}, CTX as never),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(emit).not.toHaveBeenCalled();

    // A FRESH fixture (the failure counter is per-instance) to inspect the surfaced error.
    const fresh = make({ failCreateOnCall: 1 });
    const err = (await fresh.svc
      .createInviteBatch(PAYER_A, 10, {}, CTX as never)
      .catch((e: Error) => e)) as Error;
    expect(err.message).toBe("This is temporarily unavailable; please retry shortly");
    expect(err.message).not.toContain("agency_invites");
    expect(err.message).not.toContain("duplicate key");
    expect(fresh.emit).not.toHaveBeenCalled();
  });
});

describe("createInviteBatch — code collision is bounded-retried, never a 500 (C11)", () => {
  it("retries a 23505 unique violation with a FRESH code and succeeds", async () => {
    const codes: string[] = [];
    const emit = vi.fn().mockResolvedValue(undefined);
    let calls = 0;
    const invitesRepo = {
      create: vi.fn().mockImplementation((input: { code: string }) => {
        calls += 1;
        codes.push(input.code);
        if (calls === 1) return Promise.reject(Object.assign(new Error("dup"), { code: "23505" }));
        return Promise.resolve({ id: "aaaaaaaa-0000-4000-8000-000000000001", code: input.code });
      }),
    };
    const svc = new AgencyService(
      {} as never,
      invitesRepo as never,
      {} as never,
      { emit } as never,
    );
    const res = await svc.createInvite(PAYER_A, {}, CTX as never);

    expect(calls).toBe(2);
    expect(codes[0]).not.toBe(codes[1]); // a FRESH code, not the colliding one
    expect(res.code).toBe(codes[1]);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("exhausted collision retries surface a NEUTRAL error — no constraint name, no stack", async () => {
    const emit = vi.fn();
    const invitesRepo = {
      create: vi.fn().mockRejectedValue(
        Object.assign(
          new Error('duplicate key value violates unique constraint "agency_invites_code_uq"'),
          {
            code: "23505",
          },
        ),
      ),
    };
    const svc = new AgencyService(
      {} as never,
      invitesRepo as never,
      {} as never,
      { emit } as never,
    );

    const err = (await svc
      .createInvite(PAYER_A, {}, CTX as never)
      .catch((e: Error) => e)) as Error;
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err.message).toBe("This is temporarily unavailable; please retry shortly");
    expect(err.message).not.toContain("agency_invites_code_uq");
    expect(err.message).not.toContain("duplicate key");
    expect(invitesRepo.create).toHaveBeenCalledTimes(3); // bounded — it does not spin
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("createInviteBatch — codes are NEVER logged (C13)", () => {
  it("no minted code appears in ANY log line, on the happy path or on partial failure", async () => {
    const logged: string[] = [];
    for (const level of ["log", "error", "warn", "debug", "verbose"] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation(((...args: unknown[]) => {
        logged.push(args.map((a) => String(a)).join(" "));
      }) as never);
    }

    const { svc, invitesRepo } = make({ failCreateOnCall: 40 });
    const { invites } = await svc.createInviteBatch(PAYER_A, 50, {}, CTX as never);

    expect(invites).toHaveLength(39);
    const blob = logged.join("\n");
    for (const inv of invites) expect(blob).not.toContain(inv.code);
    // Every code we ever GENERATED (including the one whose insert failed) stays unlogged.
    for (const call of invitesRepo.create.mock.calls) {
      expect(blob).not.toContain((call[0] as { code: string }).code);
    }
    // …and the full payer id is never logged either (truncated-prefix convention only).
    expect(blob).not.toContain(PAYER_A);
  });
});

describe("Batch mint has NO delivery capability (C8)", () => {
  /**
   * The most likely scope-creep path is "we minted 50 links, now let's WhatsApp them out".
   * The moment the platform delivers, it must be told WHERE — i.e. the agency supplies 50
   * phone numbers of non-consented people, which IS module 2. Keeping mint and send
   * structurally separate is what keeps the request body cardinality-shaped.
   */
  const SEND_LIKE = /messag|notif|whatsapp|sms|mail|dispatch|deliver|telephon/i;
  const read = (f: string) => readFileSync(join(__dirname, f), "utf8");

  /**
   * Source-level: adding a send capability requires IMPORTING a provider that can send.
   * Asserting on the import graph is what makes this a regression net rather than a comment.
   */
  it("the invite service/controller import NO messaging, notification or telephony provider", () => {
    for (const file of ["agency.service.ts", "agency-invites.controller.ts"]) {
      const src = read(file);
      const imports = src.split("\n").filter((l) => /^\s*import\b/.test(l));
      expect(imports.length).toBeGreaterThan(0);
      for (const line of imports) {
        expect(line, `${file}: ${line}`).not.toMatch(SEND_LIKE);
      }
    }
  });

  it("the batch controller handler accepts no recipient-shaped argument", () => {
    const src = read("agency-invites.controller.ts");
    const handler = src.slice(src.indexOf("async createInviteBatch("));
    const signature = handler.slice(0, handler.indexOf(") {"));
    for (const forbidden of ["phone", "msisdn", "email", "recipient", "@Param", "@Query"]) {
      expect(signature.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(signature).toContain("@CurrentPayer()"); // tenancy from the SESSION only
  });

  it("a 50-invite batch touches ONLY the invites repository and the events emitter", async () => {
    const { svc, emit, invitesRepo } = make();
    await svc.createInviteBatch(PAYER_A, 50, {}, CTX as never);
    expect(invitesRepo.create).toHaveBeenCalledTimes(50);
    expect(emit).toHaveBeenCalledTimes(50);
    // No read of an invite, no status write, no attribution — a mint denotes nobody.
    expect(invitesRepo.findByCode).not.toHaveBeenCalled();
    expect(invitesRepo.setStatus).not.toHaveBeenCalled();
    expect(invitesRepo.markAccepted).not.toHaveBeenCalled();
  });
});

describe("The singular mint is UNCHANGED by the batch refactor", () => {
  it("still returns one invite and emits exactly one keyed agency_invite.created", async () => {
    const { svc, emit } = make();
    const res = await svc.createInvite(PAYER_A, { campaign: "spring_drive" }, CTX as never);

    expect(res.code).toMatch(/^[0-9a-f]{12}$/);
    expect(res.link).toBe(`/i/${res.code}`);
    const evts = emitted(emit);
    expect(evts).toHaveLength(1);
    expect(evts[0]?.event_name).toBe("agency_invite.created");
    expect(evts[0]?.idempotencyKey).toBe(`agency_invite.created:${res.agency_invite_id}`);
    // ON THE WIRE, not on the object: `medium`/`payload_keys` are present-but-undefined on
    // the constructed payload when the agency supplied neither, and JSON drops them. That is
    // the same convention the "carries NO campaign value" test above asserts, and it is the
    // one that matters — the spine stores the serialized form.
    expect(Object.keys(JSON.parse(JSON.stringify(evts[0]?.payload ?? {}))).sort()).toEqual(
      ["agency_invite_id", "campaign", "channel", "inviter_payer_id"].sort(),
    );
  });
});

describe("W1 link metadata rides the SAME one-scalar-per-batch rule as campaign", () => {
  it("stamps medium + context on every row, and emits medium + KEY NAMES ONLY", async () => {
    const { svc, emit, invitesRepo } = make();
    await svc.createInviteBatch(
      PAYER_A,
      4,
      { medium: "paid", context: { role: "welder", city: "pune" } },
      CTX as never,
    );

    expect(invitesRepo.create).toHaveBeenCalledTimes(4);
    for (const call of invitesRepo.create.mock.calls) {
      const arg = call[0] as { medium?: string; payload?: Record<string, unknown> };
      expect(arg.medium).toBe("paid");
      expect(arg.payload).toEqual({ role: "welder", city: "pune" });
    }

    const evts = emitted(emit);
    expect(evts).toHaveLength(4);
    for (const e of evts) {
      expect(e.payload.medium).toBe("paid");
      // KEY NAMES, sorted — never the slug VALUES. This is the privacy property of the
      // asymmetry with `campaign`; if the values ever appear here it is a regression.
      expect(e.payload.payload_keys).toEqual(["city", "role"]);
      const wire = JSON.stringify(e.payload);
      expect(wire).not.toContain("welder");
      expect(wire).not.toContain("pune");
    }
    // One scalar for the whole batch, exactly like campaign.
    expect(new Set(evts.map((e) => e.payload.medium)).size).toBe(1);
  });

  it("omits payload_keys entirely when no context was supplied (not an empty array)", async () => {
    const { svc, emit } = make();
    await svc.createInviteBatch(PAYER_A, 2, { medium: "organic" }, CTX as never);
    for (const e of emitted(emit)) {
      expect(JSON.parse(JSON.stringify(e.payload))).not.toHaveProperty("payload_keys");
    }
  });

  it("defaults the row to organic/{} when the agency supplies no metadata at all", async () => {
    const { svc, invitesRepo } = make();
    await svc.createInvite(PAYER_A, {}, CTX as never);
    const arg = invitesRepo.create.mock.calls[0]?.[0] as {
      medium?: string;
      payload?: Record<string, unknown>;
    };
    // The repository — not the caller — supplies the fallbacks, so a pre-W1 caller writes
    // exactly what it always wrote.
    expect(arg.medium).toBeUndefined();
    expect(arg.payload).toBeUndefined();
  });
});
