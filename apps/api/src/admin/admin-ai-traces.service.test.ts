import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import type { AdminRole } from "@badabhai/db";

import { AdminAiTracesService } from "./admin-ai-traces.service";
import type { AuthenticatedAdmin } from "./admin-auth.guard";
import type { AdminAiTraceListRow, AdminAiTraceRow } from "./admin-ai-traces.repository";
import type { AdminAiTraceListItem, AdminAiTracesQueryDto } from "./admin-ai-traces.dto";

/**
 * `AdminAiTracesService` — the control pipeline in front of the most privileged disclosure on the
 * admin surface (migration 0083).
 *
 * ── EVERY CASE HERE IS "NOTHING WAS DISCLOSED", AND THAT IS THE POINT ───────────────────
 * The happy path is one test. The other nine are the ways this must refuse: the flag off, the
 * wrong role, an exhausted budget, a Redis outage, an unknown id, and — the one that is easiest
 * to get subtly wrong — an audit row that could not be written. In each case the assertion is not
 * only "it threw" but "the DECRYPT was never called", because a service that decrypts and then
 * throws has already computed the plaintext and put it in this process's memory and, on the wrong
 * day, in a stack trace.
 */

const TRACE = "11111111-1111-4111-8111-111111111111";
const WORKER = "22222222-2222-4222-8222-222222222222";
const ADMIN = "33333333-3333-4333-8333-333333333333";
const CTX = { correlationId: "44444444-4444-4444-8444-444444444444", requestId: "req-1" };

const admin = (role: AdminRole = "super_admin"): AuthenticatedAdmin => ({
  id: ADMIN,
  role,
  sid: "sid",
});

const scalars = (over: Partial<AdminAiTraceListItem> = {}): AdminAiTraceListItem => ({
  id: TRACE,
  ai_call_id: "55555555-5555-4555-8555-555555555555",
  worker_id: WORKER,
  session_id: null,
  ai_job_id: null,
  correlation_id: CTX.correlationId,
  task_type: "profiling_chat_turn",
  model_name: "gemini-2.5-flash",
  prompt_name: null,
  prompt_version: null,
  prompt_chars: 42,
  response_chars: 17,
  real_call: true,
  success: true,
  error_code: null,
  created_at: new Date("2026-08-20T10:00:00.000Z"),
  ...over,
});

const row = (over: Partial<AdminAiTraceRow> = {}): AdminAiTraceRow => ({
  scalars: scalars(),
  cipher: { promptEnc: "v1.aa.bb.cc", responseEnc: "v1.dd.ee.ff" },
  ...over,
});

/**
 * One list row as the REPOSITORY hands it up: the DTO item plus the full-microsecond sort key.
 *
 * The two are separate here for the same reason they are separate in the repository — the sort
 * key is what the next cursor is minted from, and it is NOT `item.created_at`. That field is a
 * JS `Date`, already millisecond-truncated by the driver, and minting a cursor from it skipped
 * every row sharing the boundary millisecond. `sortKey` defaults to a value with NON-ZERO
 * microseconds precisely so a regression to `created_at.toISOString()` is visible in the cursor.
 */
const listRow = (item: AdminAiTraceListItem, sortKey = "2026-08-20T10:00:00.000600Z"): AdminAiTraceListRow => ({
  item,
  sortKey,
});

function make(
  over: {
    enabled?: boolean;
    capOk?: boolean;
    found?: AdminAiTraceRow | undefined;
    emitThrows?: boolean;
    decryptThrows?: boolean;
    listRows?: AdminAiTraceListRow[];
  } = {},
) {
  const byId = vi.fn(async (_id: string) => ("found" in over ? over.found : row()));
  // Typed to TAKE its arguments, so the assertions below on `mock.calls[0][n]` stay type-checked
  // — a bare `vi.fn(async () => …)` infers a ZERO-ARG signature, and indexing its call tuple is
  // then a compile error rather than a silent `any`. Same convention as `llm-turn.service.test`.
  const list = vi.fn(
    async (_filter: unknown, _cursor: unknown, _limit: number) => over.listRows ?? [],
  );
  const consume = vi.fn(async () => (over.capOk === false ? { ok: false as const, window: "hour" as const } : { ok: true as const }));
  const decrypt = vi.fn((token: string) => {
    if (over.decryptThrows) throw new Error("unknown kid");
    return `plain(${token})`;
  });
  const emit = vi.fn(async (params: unknown) => {
    if (over.emitThrows) throw new Error("events insert failed");
    return params;
  });
  const svc = new AdminAiTracesService(
    { byId, list } as never,
    { consume } as never,
    { decrypt } as never,
    { emit } as never,
    { ADMIN_AI_TRACE_READ_ENABLED: over.enabled ?? true } as never,
  );
  return { svc, byId, list, consume, decrypt, emit };
}

const query = (over: Partial<AdminAiTracesQueryDto> = {}): AdminAiTracesQueryDto =>
  ({ limit: 25, ...over }) as AdminAiTracesQueryDto;

// ---------------------------------------------------------------------------
describe("the LIST is PII-free — no ciphertext, no decrypt, no audit", () => {
  it("returns only the scalars, and never a prompt/response/ciphertext field", async () => {
    // The claim the whole two-route split rests on. Asserted on the SERIALISED page rather than
    // by naming the fields, so a column added to the projection later — under any name — fails
    // here instead of shipping on a route the read floor can reach.
    const { svc, decrypt } = make({ listRows: [listRow(scalars()), listRow(scalars({ id: "b" }))] });
    const page = await svc.list(query());
    expect(page.items).toHaveLength(2);
    const serialised = JSON.stringify(page);
    for (const forbidden of ["prompt_enc", "response_enc", "\"prompt\"", "\"response\"", "v1."]) {
      expect(serialised, `the list must not carry ${forbidden}`).not.toContain(forbidden);
    }
    // ...and the lengths ARE there, because a size question wants a size.
    expect(page.items[0]!.prompt_chars).toBe(42);
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("emits NO audit event — the decrypt is what discloses, so the decrypt is what is audited", async () => {
    const { svc, emit } = make({ listRows: [listRow(scalars())] });
    await svc.list(query());
    expect(emit).not.toHaveBeenCalled();
  });

  it("charges NO egress budget — routine ops reads must not spend the decrypt allowance", async () => {
    const { svc, consume } = make({ listRows: [listRow(scalars())] });
    await svc.list(query());
    expect(consume).not.toHaveBeenCalled();
  });

  it("over-fetches by one and reports an HONEST nextCursor", async () => {
    // A page derived from "we returned exactly `limit` rows" produces a phantom next page on an
    // exact multiple, and the operator clicks Next onto an empty screen.
    const rows = Array.from({ length: 3 }, (_, i) =>
      listRow(scalars({ id: `0000000${i}-0000-4000-8000-000000000000` }), `2026-08-20T10:00:00.00050${i}Z`),
    );
    const { svc, list } = make({ listRows: rows });
    const page = await svc.list(query({ limit: 2 }));
    expect(list.mock.calls[0]![2]).toBe(3); // limit + 1
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();

    // AND THE CURSOR CARRIES THE MICROSECONDS. `created_at` is `timestamptz` (microsecond
    // precision) and the driver hands it back as a millisecond JS `Date`, so a cursor minted
    // from `item.created_at.toISOString()` is strictly BELOW the row it describes — and every
    // row inside that millisecond then fails both halves of the keyset predicate and is skipped
    // forever, with a healthy-looking nextCursor. Measured against a live Postgres before this
    // was fixed: 6 rows in one millisecond, page size 2 → 4 permanently invisible.
    const decoded = JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString("utf8"));
    expect(decoded.c).toBe("2026-08-20T10:00:00.000501Z");
    expect(decoded.c).not.toBe(rows[1]!.item.created_at.toISOString());
  });

  it("a malformed cursor serves the FIRST page rather than 500ing", async () => {
    const { svc, list } = make({ listRows: [] });
    await svc.list(query({ cursor: "not-base64-at-all" }));
    expect(list.mock.calls[0]![1]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("the DETAIL refuses — and never computes plaintext when it does", () => {
  const expectNeutral = async (p: Promise<unknown>) => {
    await expect(p).rejects.toBeInstanceOf(NotFoundException);
  };

  it("404s with the FLAG OFF — never a 403, which would confirm the feature exists", async () => {
    const { svc, decrypt, byId } = make({ enabled: false });
    await expectNeutral(svc.readOne(admin(), TRACE, CTX));
    expect(byId).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("refuses every role except super_admin, even with the flag ON", async () => {
    // The route decorator produces the 403 in production (asserted in the authz suite); this is
    // the service's own deny-by-default check, which is what stands between a future second
    // caller and an ungated decrypt.
    for (const role of ["ops_admin", "support", "analyst"] as AdminRole[]) {
      const { svc, decrypt, emit } = make();
      await expectNeutral(svc.readOne(admin(role), TRACE, CTX));
      expect(decrypt, `${role} must not reach the decrypt`).not.toHaveBeenCalled();
      expect(emit, `${role} must not write an audit row`).not.toHaveBeenCalled();
    }
  });

  it("refuses an UNKNOWN role — a stale token or a widened enum fails closed", async () => {
    const { svc, decrypt } = make();
    await expectNeutral(svc.readOne({ id: ADMIN, role: "root" as AdminRole, sid: "s" }, TRACE, CTX));
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("404s when the budget is exhausted, BEFORE the row is even fetched", async () => {
    // Charged before the lookup so an over-cap caller cannot use response timing as an existence
    // oracle for a trace id either.
    const { svc, byId, decrypt, emit } = make({ capOk: false });
    await expectNeutral(svc.readOne(admin(), TRACE, CTX));
    expect(byId).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("404s on an unknown id with the SAME shape as every denial (no enumeration oracle)", async () => {
    const { svc, decrypt, emit } = make({ found: undefined });
    await expectNeutral(svc.readOne(admin(), TRACE, CTX));
    expect(decrypt).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("RETURNS NOTHING when the audit write fails — and never decrypts (fail closed)", async () => {
    // THE ASSERTION THIS FILE EXISTS FOR. `admin.ai_trace_viewed` is not a log line; it is the
    // condition on the disclosure. If it cannot be written, the plaintext must not be computed —
    // otherwise a spine outage silently converts an audited surface into an unaudited one, and
    // nothing about the response would say so.
    const { svc, decrypt } = make({ emitThrows: true });
    await expect(svc.readOne(admin(), TRACE, CTX)).rejects.toThrow("events insert failed");
    expect(decrypt).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("the DETAIL discloses — once, audited, with lengths on the spine and text only in the reply", () => {
  it("audits BEFORE it decrypts, carrying the LENGTHS and never the text", async () => {
    const order: string[] = [];
    const { svc, emit, decrypt } = make();
    emit.mockImplementation(async (params: unknown) => {
      order.push("emit");
      return params;
    });
    decrypt.mockImplementation((token: string) => {
      order.push("decrypt");
      return `plain(${token})`;
    });

    const detail = await svc.readOne(admin(), TRACE, CTX);

    expect(order[0]).toBe("emit");
    expect(order).toContain("decrypt");

    const payload = (emit.mock.calls[0]![0] as { payload: Record<string, unknown>; event_name: string });
    expect(payload.event_name).toBe("admin.ai_trace_viewed");
    expect(payload.payload).toEqual({
      admin_id: ADMIN,
      trace_id: TRACE,
      worker_id: WORKER,
      task_type: "profiling_chat_turn",
      prompt_chars: 42,
      response_chars: 17,
    });
    // The §2 line, asserted structurally: nothing on the spine carries the words.
    const emitted = JSON.stringify(emit.mock.calls[0]![0]);
    expect(emitted).not.toContain("plain(");
    expect(emitted).not.toContain("v1.aa.bb.cc");

    // ...and the text IS in the response, which is the only place it exists.
    expect(detail.prompt).toBe("plain(v1.aa.bb.cc)");
    expect(detail.response).toBe("plain(v1.dd.ee.ff)");
  });

  it("charges exactly ONE unit — the route is single-subject by construction", async () => {
    const { svc, consume } = make();
    await svc.readOne(admin(), TRACE, CTX);
    expect(consume).toHaveBeenCalledWith(ADMIN, 1);
  });

  it("serves the metadata and NULL text when a token cannot be decrypted", async () => {
    // A rotated or tampered token must not 500 the screen: after a key retirement that would
    // take out every trace at once and the operator would lose the metadata they are still
    // entitled to. The failure is in the log, never in the response.
    const { svc } = make({ decryptThrows: true });
    const detail = await svc.readOne(admin(), TRACE, CTX);
    expect(detail.prompt).toBeNull();
    expect(detail.response).toBeNull();
    expect(detail.task_type).toBe("profiling_chat_turn");
    expect(detail.prompt_chars).toBe(42);
  });

  it("serves NULL text for a trace that genuinely stored none", async () => {
    const { svc, decrypt } = make({
      found: { scalars: scalars({ prompt_chars: null, response_chars: null }), cipher: { promptEnc: null, responseEnc: null } },
    });
    const detail = await svc.readOne(admin(), TRACE, CTX);
    expect(detail.prompt).toBeNull();
    expect(detail.response).toBeNull();
    expect(decrypt).not.toHaveBeenCalled();
  });
});
