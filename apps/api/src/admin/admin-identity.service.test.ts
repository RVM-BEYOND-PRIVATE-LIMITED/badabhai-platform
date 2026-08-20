import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import type { AdminRole } from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import type { EventsService } from "../events/events.service";
import type { AuthenticatedAdmin } from "./admin-auth.guard";
import { AdminIdentityService, ADMIN_IDENTITY_MAX_SUBJECTS } from "./admin-identity.service";
import type { AdminIdentityCapService } from "./admin-identity-cap.service";
import type { AdminIdentityRepository, AdminIdentityRow } from "./admin-identity.repository";

const CTX: RequestContext = { requestId: "req-1", correlationId: "cor-1" };
const ADMIN_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const W1 = "11111111-0000-4000-8000-000000000001";
const W2 = "22222222-0000-4000-8000-000000000002";

const admin = (role: AdminRole): AuthenticatedAdmin => ({ id: ADMIN_ID, role, sid: "s" });

interface Harness {
  svc: AdminIdentityService;
  emit: ReturnType<typeof vi.fn>;
  decrypt: ReturnType<typeof vi.fn>;
  consume: ReturnType<typeof vi.fn>;
  workerNames: ReturnType<typeof vi.fn>;
  payerOrgNames: ReturnType<typeof vi.fn>;
  adminNames: ReturnType<typeof vi.fn>;
  /** Every control step, in the order it actually ran. */
  trace: string[];
}

function harness(opts: {
  rows?: AdminIdentityRow[];
  cap?: { ok: true } | { ok: false; window: "hour" | "day" };
  emitRejects?: boolean;
  decryptThrows?: boolean;
} = {}): Harness {
  const trace: string[] = [];
  const rows = opts.rows ?? [{ id: W1, nameCipher: "v1.cipher-a" }];

  const workerNames = vi.fn(async () => {
    trace.push("fetch");
    return rows;
  });
  const payerOrgNames = vi.fn(async () => {
    trace.push("fetch");
    return rows;
  });
  const adminNames = vi.fn(async () => {
    trace.push("fetch");
    return rows;
  });
  const consume = vi.fn(async () => {
    trace.push("cap");
    return opts.cap ?? { ok: true as const };
  });
  const emit = vi.fn(async () => {
    trace.push("emit");
    if (opts.emitRejects) throw new Error("events insert failed");
    return undefined;
  });
  const decrypt = vi.fn((token: string) => {
    trace.push("decrypt");
    if (opts.decryptThrows) throw new Error("unknown kid");
    return `plain(${token})`;
  });

  const svc = new AdminIdentityService(
    { workerNames, payerOrgNames, adminNames } as unknown as AdminIdentityRepository,
    { consume } as unknown as AdminIdentityCapService,
    { decrypt } as unknown as PiiCryptoService,
    { emit } as unknown as EventsService,
  );
  return { svc, emit, decrypt, consume, workerNames, payerOrgNames, adminNames, trace };
}

// ---------------------------------------------------------------------------
// 1. The capability — what it BLOCKS and, just as importantly, what it PERMITS.
// ---------------------------------------------------------------------------

describe("read_identity — the gate, in both directions", () => {
  it("PERMITS super_admin, ops_admin and support: names resolve, and the pipeline really runs", async () => {
    // The half that gets forgotten. A guard nobody proved PERMISSIVE passes every "does it
    // block X" test and then gets deleted the first time it blocks legitimate work.
    for (const role of ["super_admin", "ops_admin", "support"] as AdminRole[]) {
      const h = harness();
      const names = await h.svc.resolve(admin(role), "workers", [W1], null, CTX);
      expect(names, role).not.toBeNull();
      expect(names!.get(W1), role).toBe("plain(v1.cipher-a)");
      expect(h.emit, role).toHaveBeenCalledTimes(1);
      expect(h.consume, role).toHaveBeenCalledTimes(1);
      expect(h.svc.isPermitted(admin(role)), role).toBe(true);
    }
  });

  it("DENIES analyst — and denies it SILENTLY: no lookup, no budget, no event", async () => {
    const h = harness();
    await expect(h.svc.resolve(admin("analyst"), "workers", [W1], null, CTX)).resolves.toBeNull();
    // Not merely "returns null": the read must cost nothing and leave no trail, because for an
    // analyst nothing happened — they got today's faceless page.
    expect(h.workerNames).not.toHaveBeenCalled();
    expect(h.consume).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
    expect(h.decrypt).not.toHaveBeenCalled();
    expect(h.svc.isPermitted(admin("analyst"))).toBe(false);
  });

  it("DENIES an unknown role (deny-by-default, never defaulted to a privileged one)", async () => {
    const h = harness();
    const rogue = { id: ADMIN_ID, role: "root" as AdminRole, sid: "s" };
    await expect(h.svc.resolve(rogue, "workers", [W1], null, CTX)).resolves.toBeNull();
    expect(h.decrypt).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. The ORDERING — the property the whole design rests on.
// ---------------------------------------------------------------------------

describe("audit-before-decrypt", () => {
  it("runs fetch → cap → emit → decrypt, in that order", async () => {
    const h = harness();
    await h.svc.resolve(admin("support"), "workers", [W1], W1, CTX);
    expect(h.trace).toEqual(["fetch", "cap", "emit", "decrypt"]);
  });

  it("an emit FAILURE means no names: the exception propagates and decrypt never runs", async () => {
    // Fail closed. A trail that is best-effort is not a control; it is a log line. The caller
    // gets an error rather than a page of names the spine has no record of.
    const h = harness({ emitRejects: true });
    await expect(h.svc.resolve(admin("support"), "workers", [W1], null, CTX)).rejects.toThrow(
      "events insert failed",
    );
    expect(h.decrypt).not.toHaveBeenCalled();
    expect(h.trace).toEqual(["fetch", "cap", "emit"]);
  });

  it("the emit is AWAITED — decrypt cannot start while the audit row is still in flight", async () => {
    // The ordering above would also hold if the emit were fired and not awaited, because the
    // trace records the CALL. This pins the await: the emit's promise is resolved by hand, and
    // nothing may have decrypted before that.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const decrypt = vi.fn(() => "plain");
    const emit = vi.fn(async () => gate);
    const svc = new AdminIdentityService(
      {
        workerNames: vi.fn(async () => [{ id: W1, nameCipher: "v1.a" }]),
      } as unknown as AdminIdentityRepository,
      { consume: vi.fn(async () => ({ ok: true as const })) } as unknown as AdminIdentityCapService,
      { decrypt } as unknown as PiiCryptoService,
      { emit } as unknown as EventsService,
    );

    const pending = svc.resolve(admin("support"), "workers", [W1], null, CTX);
    await Promise.resolve();
    await Promise.resolve();
    expect(decrypt).not.toHaveBeenCalled();
    release();
    await pending;
    expect(decrypt).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 3. The audit payload + envelope.
// ---------------------------------------------------------------------------

describe("admin.identity_viewed — what the spine records", () => {
  it("counts NAMES ACTUALLY DISCLOSED, from the ciphertext — never the row count", async () => {
    // Three rows, one of which has no name on record. Counting rows would claim a disclosure
    // that did not happen, in the audit AND in the budget it charges.
    const h = harness({
      rows: [
        { id: W1, nameCipher: "v1.a" },
        { id: W2, nameCipher: null },
        { id: "33333333-0000-4000-8000-000000000003", nameCipher: "v1.c" },
      ],
    });
    await h.svc.resolve(admin("ops_admin"), "workers", [W1, W2], null, CTX);
    expect(h.emit.mock.calls[0]![0].payload.result_count).toBe(2);
    expect(h.consume).toHaveBeenCalledWith(ADMIN_ID, 2);
  });

  it("a page where NOBODY has a name is zero disclosures and costs zero budget", async () => {
    const h = harness({ rows: [{ id: W1, nameCipher: null }, { id: W2, nameCipher: null }] });
    await h.svc.resolve(admin("ops_admin"), "workers", [W1, W2], null, CTX);
    expect(h.consume).toHaveBeenCalledWith(ADMIN_ID, 0);
    expect(h.emit.mock.calls[0]![0].payload.result_count).toBe(0);
    // Still audited: "this admin opened the list and was shown no names" is a fact worth having.
    expect(h.emit).toHaveBeenCalledTimes(1);
  });

  it("carries the surface, the subject on a DETAIL read, and null on a LIST read", async () => {
    const h = harness();
    await h.svc.resolve(admin("support"), "workers", [W1], W1, CTX);
    expect(h.emit.mock.calls[0]![0].payload).toEqual({
      admin_id: ADMIN_ID,
      surface: "workers",
      subject_id: W1,
      result_count: 1,
    });

    const h2 = harness();
    await h2.svc.resolve(admin("support"), "payers", [W1], null, CTX);
    expect(h2.emit.mock.calls[0]![0].payload).toMatchObject({
      surface: "payers",
      subject_id: null,
    });
  });

  it("the envelope subject is the ADMIN SESSION, uniformly — list and detail alike", async () => {
    // Filing the detail reads under `worker` would make the spine query "who read worker W's
    // name?" look complete while silently omitting every LIST page that contained W. A
    // uniformly honest subject beats one that is precise on half the calls.
    for (const subjectId of [W1, null]) {
      const h = harness();
      await h.svc.resolve(admin("support"), "workers", [W1], subjectId, CTX);
      const evt = h.emit.mock.calls[0]![0];
      expect(evt.event_name).toBe("admin.identity_viewed");
      expect(evt.subject).toEqual({ subject_type: "admin_session", subject_id: ADMIN_ID });
      expect(evt.actor).toEqual({ actor_type: "admin", actor_id: ADMIN_ID });
      expect(evt.correlationId).toBe(CTX.correlationId);
      expect(evt.requestId).toBe(CTX.requestId);
    }
  });

  it("ONE event per response, never one per subject", async () => {
    // Fifty rows per page view would be write amplification AND would turn the spine into a
    // queryable index of which workers anyone has looked at — a new inference surface built out
    // of the control meant to constrain one.
    const rows = Array.from({ length: 50 }, (_, i) => ({
      id: `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`,
      nameCipher: "v1.x",
    }));
    const h = harness({ rows });
    await h.svc.resolve(admin("support"), "workers", rows.map((r) => r.id), null, CTX);
    expect(h.emit).toHaveBeenCalledTimes(1);
    expect(h.emit.mock.calls[0]![0].payload.result_count).toBe(50);
  });

  it("no NAME, plaintext or ciphertext, is anywhere in the payload", async () => {
    const h = harness({ rows: [{ id: W1, nameCipher: "v1.ramesh-token" }] });
    await h.svc.resolve(admin("support"), "workers", [W1], W1, CTX);
    const serialized = JSON.stringify(h.emit.mock.calls[0]![0]);
    expect(serialized).not.toContain("ramesh");
    expect(serialized).not.toContain("plain(");
    expect(Object.keys(h.emit.mock.calls[0]![0].payload).sort()).toEqual([
      "admin_id",
      "result_count",
      "subject_id",
      "surface",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 4. The egress cap.
// ---------------------------------------------------------------------------

describe("the name-egress cap", () => {
  it("an over-cap read discloses NOTHING and never decrypts", async () => {
    const h = harness({ cap: { ok: false, window: "hour" } });
    await expect(h.svc.resolve(admin("support"), "workers", [W1], null, CTX)).resolves.toBeNull();
    expect(h.decrypt).not.toHaveBeenCalled();
  });

  it("...and emits the PII-free breach INSTEAD of the viewed event", async () => {
    const h = harness({ cap: { ok: false, window: "day" } });
    await h.svc.resolve(admin("support"), "workers", [W1], W1, CTX);
    expect(h.emit).toHaveBeenCalledTimes(1);
    const evt = h.emit.mock.calls[0]![0];
    expect(evt.event_name).toBe("admin.identity_cap_exceeded");
    // Never a subject id, never a surface — a breach is about an ACCOUNT's velocity, and naming
    // the screen would let the alert stream be read as a coarse browsing history.
    expect(evt.payload).toEqual({ admin_id: ADMIN_ID, window: "day" });
    expect(evt.subject).toEqual({ subject_type: "admin_session", subject_id: ADMIN_ID });
  });

  it("a Redis outage DENIES (the cap service fails closed) and the read still serves faceless", async () => {
    // Degrading rather than throwing is the deliberate call: this same request is serving the
    // `read_entities` floor all four roles hold, and an identity control must not take out the
    // faceless read beside it — that would re-couple exactly what splitting the capability off
    // `read_entities` exists to separate.
    const h = harness({ cap: { ok: false, window: "hour" } });
    await expect(h.svc.resolve(admin("ops_admin"), "payers", [W1], null, CTX)).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. The per-RESPONSE bound — the control the callers' page sizes cannot be trusted with.
// ---------------------------------------------------------------------------

describe("the 50-name response bound", () => {
  /** `n` rows, all named — the worst case the bound exists for. */
  const namedRows = (n: number): AdminIdentityRow[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`,
      nameCipher: `v1.token-${i}`,
    }));

  it("PERMITS exactly the bound: 50 subjects resolve, all 50 names, one event", async () => {
    // The permissive half first. A bound that was never proven to allow its own limit is one
    // off-by-one away from capping the console at 49 and nobody noticing for a release.
    const rows = namedRows(ADMIN_IDENTITY_MAX_SUBJECTS);
    const h = harness({ rows });
    const names = await h.svc.resolve(
      admin("ops_admin"),
      "workers",
      rows.map((r) => r.id),
      null,
      CTX,
    );
    expect(names).not.toBeNull();
    expect(names!.size).toBe(ADMIN_IDENTITY_MAX_SUBJECTS);
    expect(h.consume).toHaveBeenCalledWith(ADMIN_ID, ADMIN_IDENTITY_MAX_SUBJECTS);
    expect(h.emit).toHaveBeenCalledTimes(1);
  });

  it("REFUSES one over the bound — no query, no budget, no audit row, nothing decrypted", async () => {
    // Fail closed BEFORE the lookup: a refused read must not even touch the name columns, or
    // the bound would still be a database read of 51 people's names that we then threw away.
    const rows = namedRows(ADMIN_IDENTITY_MAX_SUBJECTS + 1);
    const h = harness({ rows });
    const names = await h.svc.resolve(
      admin("super_admin"),
      "workers",
      rows.map((r) => r.id),
      null,
      CTX,
    );
    expect(names).toBeNull();
    expect(h.workerNames).not.toHaveBeenCalled();
    expect(h.consume).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
    expect(h.decrypt).not.toHaveBeenCalled();
  });

  it("refuses ALL of them, never the first fifty", async () => {
    // The alternative that looks kinder and is worse: a partial page reports rows 51+ as
    // `name: null`, which on this contract MEANS "disclosed, no name on record". Silently
    // wrong data beats loudly absent data on exactly no screen.
    const rows = namedRows(ADMIN_IDENTITY_MAX_SUBJECTS + 1);
    const h = harness({ rows });
    await expect(
      h.svc.resolve(admin("super_admin"), "admins", rows.map((r) => r.id), null, CTX),
    ).resolves.toBeNull();
    expect(h.adminNames).not.toHaveBeenCalled();
  });

  it("the bound is NOT an `identity_cap_exceeded` breach — the alert stream stays clean", async () => {
    // A velocity breach means "this ACCOUNT is reading too many names". A caller that forgot to
    // clamp is a code bug on our side. Filing the second under the first would put noise into
    // the one stream a reviewer is meant to read as an alert.
    const rows = namedRows(ADMIN_IDENTITY_MAX_SUBJECTS + 1);
    const h = harness({ rows });
    await h.svc.resolve(admin("support"), "workers", rows.map((r) => r.id), null, CTX);
    expect(h.emit).not.toHaveBeenCalled();
  });

  it("an over-bound ANALYST read costs nothing either — the capability is still checked FIRST", async () => {
    // The two denials are indistinguishable to the CALLER by design (both serve the faceless
    // page), so what is pinned here is that the ordering does not make the un-entitled path
    // any more expensive: no query, no budget, no trail, whatever the id count. The two are
    // told apart in the LOGS, and that is asserted in `admin-identity.logging.test.ts` — only
    // the bound logs, because only the bound is a bug on our side.
    const rows = namedRows(ADMIN_IDENTITY_MAX_SUBJECTS + 1);
    const h = harness({ rows });
    await expect(
      h.svc.resolve(admin("analyst"), "workers", rows.map((r) => r.id), null, CTX),
    ).resolves.toBeNull();
    expect(h.workerNames).not.toHaveBeenCalled();
    expect(h.consume).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. Surfaces + decrypt behaviour.
// ---------------------------------------------------------------------------

describe("surfaces route to exactly one projection each", () => {
  it("workers → workerNames, payers → payerOrgNames, admins → adminNames", async () => {
    const h = harness();
    await h.svc.resolve(admin("super_admin"), "workers", [W1], null, CTX);
    expect(h.workerNames).toHaveBeenCalledWith([W1]);
    expect(h.payerOrgNames).not.toHaveBeenCalled();
    expect(h.adminNames).not.toHaveBeenCalled();

    const h2 = harness();
    await h2.svc.resolve(admin("super_admin"), "payers", [W1], null, CTX);
    expect(h2.payerOrgNames).toHaveBeenCalledWith([W1]);
    expect(h2.workerNames).not.toHaveBeenCalled();

    const h3 = harness();
    await h3.svc.resolve(admin("super_admin"), "admins", [W1], null, CTX);
    expect(h3.adminNames).toHaveBeenCalledWith([W1]);
    expect(h3.workerNames).not.toHaveBeenCalled();
  });
});

describe("decrypt at the boundary", () => {
  it("a null ciphertext is a null NAME, and is never handed to the crypto boundary", async () => {
    const h = harness({ rows: [{ id: W1, nameCipher: null }] });
    const names = await h.svc.resolve(admin("support"), "workers", [W1], null, CTX);
    expect(names!.get(W1)).toBeNull();
    expect(h.decrypt).not.toHaveBeenCalled();
  });

  it("an undecryptable token degrades that ROW to null, never 500s the whole read", async () => {
    // After a key rotation a hard failure would take out every row on the screen at once — and
    // the faceless data with it. Same degradation the resume and disclosure paths already use.
    const h = harness({ decryptThrows: true });
    const names = await h.svc.resolve(admin("support"), "workers", [W1], null, CTX);
    expect(names).not.toBeNull();
    expect(names!.get(W1)).toBeNull();
  });

  it("an empty id set is still audited, and never queries or charges for a name", async () => {
    const h = harness({ rows: [] });
    const names = await h.svc.resolve(admin("support"), "workers", [], null, CTX);
    expect(names!.size).toBe(0);
    expect(h.consume).toHaveBeenCalledWith(ADMIN_ID, 0);
    expect(h.emit.mock.calls[0]![0].payload.result_count).toBe(0);
  });
});
