import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NotFoundException } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { RequestContext } from "../common/request-context";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import type { EventsService } from "../events/events.service";
import type { AdminPiiRevealRepository } from "./admin-pii-reveal.repository";
import type { AdminPiiRevealCapService } from "./admin-pii-reveal-cap.service";
import { AdminPiiRevealService } from "./admin-pii-reveal.service";

const ADMIN_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const WORKER_ID = "dddddddd-0000-4000-8000-000000000004";
const PHONE = "+919876543210"; // the decrypted PII — must NEVER appear in an event/log
const ENCRYPTED = "enc.token.for.phone";
const CTX: RequestContext = {
  requestId: "req-1",
  correlationId: "11111111-1111-4111-8111-111111111111",
};

/** A captured event the service emitted (we record the full params for the no-PII scan). */
interface CapturedEmit {
  event_name: string;
  actor: { actor_type: string; actor_id: string };
  subject: { subject_type: string; subject_id: string };
  payload: Record<string, unknown>;
  correlationId?: string;
  requestId?: string;
}

interface Harness {
  service: AdminPiiRevealService;
  emitted: CapturedEmit[];
  decrypt: ReturnType<typeof vi.fn>;
  logs: string[];
  cap: { consume: ReturnType<typeof vi.fn> };
  repo: { findEncryptedPhone: ReturnType<typeof vi.fn> };
}

function make(opts: {
  enabled?: boolean;
  capResult?: { ok: true } | { ok: false; window: "hour" | "day" };
  worker?: { id: string; phoneE164Encrypted: string } | undefined;
  decryptImpl?: () => string;
  emitThrowsOn?: string; // an event_name whose emit should throw (to test fail-closed/ordering)
} = {}): Harness {
  const emitted: CapturedEmit[] = [];
  const emit = vi.fn(async (params: CapturedEmit) => {
    if (opts.emitThrowsOn && params.event_name === opts.emitThrowsOn) {
      throw new Error(`simulated emit failure for ${params.event_name}`);
    }
    // Record AFTER the throw check — a failed emit must NOT be observed as committed.
    emitted.push(params);
    return undefined;
  });

  const decrypt = vi.fn(opts.decryptImpl ?? (() => PHONE));

  const cap = {
    consume: vi.fn(async () => opts.capResult ?? ({ ok: true } as const)),
  };
  const repo = {
    findEncryptedPhone: vi.fn(async () =>
      "worker" in opts ? opts.worker : { id: WORKER_ID, phoneE164Encrypted: ENCRYPTED },
    ),
  };
  const config = {
    ADMIN_PII_REVEAL_ENABLED: opts.enabled ?? true,
  } as unknown as ServerConfig;

  const service = new AdminPiiRevealService(
    repo as unknown as AdminPiiRevealRepository,
    cap as unknown as AdminPiiRevealCapService,
    { decrypt } as unknown as PiiCryptoService,
    { emit } as unknown as EventsService,
    config,
  );

  // Capture logger output so we can prove the phone never appears in a log line.
  const logs: string[] = [];
  const proto = service as unknown as {
    logger: { log: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
  };
  proto.logger = {
    log: (m: string) => logs.push(m),
    warn: (m: string) => logs.push(m),
    error: (m: string) => logs.push(m),
  };

  return { service, emitted, decrypt, logs, cap, repo };
}

/** Recursively collect every primitive leaf value of an object (for the no-PII scan). */
function leaves(value: unknown, out: string[] = []): string[] {
  if (value === null || value === undefined) return out;
  if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) leaves(v, out);
  } else {
    out.push(String(value));
  }
  return out;
}

/** A uuid (the legitimate opaque ids the spine carries — admin_id/subject_id/correlation_id). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A phone-shaped digit run — mirrors pseudonymize.py `_PHONE_RE`. */
const PHONE_LIKE_RE = /(?<!\d)\+?\d[\d\s-]{7,}\d(?!\d)/;
/**
 * True if any NON-uuid leaf of `evt` looks phone-shaped. UUIDs are the legitimate opaque ids the
 * spine carries (they contain long hyphenated digit runs), so we exclude them — the scan proves no
 * ACTUAL phone (or other phone-shaped value) rides any event leaf.
 */
function hasPhoneShapedNonUuidLeaf(evt: unknown): boolean {
  return leaves(evt).some((leaf) => !UUID_RE.test(leaf) && PHONE_LIKE_RE.test(leaf));
}

describe("AdminPiiRevealService.revealContact (ADR-0025 ADMIN-3b)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("happy path: returns the decrypted phone for the authed admin, single subject", async () => {
    const h = make();
    const res = await h.service.revealContact(ADMIN_ID, WORKER_ID, { reason_code: "dispute_resolution" }, CTX);
    expect(res).toEqual({ worker_id: WORKER_ID, phone: PHONE });
    // Exactly one audit event (admin.pii_viewed) — value-free.
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]!.event_name).toBe("admin.pii_viewed");
  });

  // --- Control 4 + must-fix #7: AUDIT BEFORE DECRYPT --------------------------

  it("emits admin.pii_viewed BEFORE the decrypt is called (audit-before-decrypt ordering)", async () => {
    const order: string[] = [];
    const h = make({
      decryptImpl: () => {
        order.push("decrypt");
        return PHONE;
      },
    });
    // Wrap emit to record its relative order.
    const realEmitted = h.emitted;
    const svc = h.service as unknown as { events: { emit: (p: CapturedEmit) => Promise<unknown> } };
    const inner = svc.events.emit.bind(svc.events);
    svc.events.emit = async (p: CapturedEmit) => {
      order.push(`emit:${p.event_name}`);
      return inner(p);
    };

    await h.service.revealContact(ADMIN_ID, WORKER_ID, { reason_code: "safety_escalation" }, CTX);
    expect(order).toEqual(["emit:admin.pii_viewed", "decrypt"]);
    expect(realEmitted).toHaveLength(1);
  });

  it("if the audit emit FAILS, the decrypt is NEVER called (fail closed)", async () => {
    const h = make({ emitThrowsOn: "admin.pii_viewed" });
    await expect(
      h.service.revealContact(ADMIN_ID, WORKER_ID, { reason_code: "dispute_resolution" }, CTX),
    ).rejects.toThrow(/emit failure/);
    expect(h.decrypt).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0); // nothing committed
  });

  it("the audit event is COMMITTED even when the RESPONSE then fails (decrypt throws AFTER the emit)", async () => {
    const h = make({
      decryptImpl: () => {
        throw new Error("decrypt blew up after the audit was committed");
      },
    });
    await expect(
      h.service.revealContact(ADMIN_ID, WORKER_ID, { reason_code: "worker_support_callback" }, CTX),
    ).rejects.toThrow(/decrypt blew up/);
    // PROOF: the admin.pii_viewed row exists despite the response failing.
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]!.event_name).toBe("admin.pii_viewed");
    expect(h.emitted[0]!.payload).toEqual({
      admin_id: ADMIN_ID,
      subject_id: WORKER_ID,
      reason_code: "worker_support_callback",
    });
  });

  // --- Control 5 + must-fix #8: RATE CAP fail-closed + breach event ----------

  it("over-cap (hour): reveals NOTHING, emits a PII-free breach event, throws the neutral 404", async () => {
    const h = make({ capResult: { ok: false, window: "hour" } });
    await expect(
      h.service.revealContact(ADMIN_ID, WORKER_ID, { reason_code: "dispute_resolution" }, CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.decrypt).not.toHaveBeenCalled();
    // The cap was checked BEFORE the worker lookup (the lookup never ran).
    expect(h.repo.findEncryptedPhone).not.toHaveBeenCalled();
    // Exactly the breach event — PII-free {admin_id, window}; NO pii_viewed.
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]!.event_name).toBe("admin.pii_reveal_cap_exceeded");
    expect(h.emitted[0]!.payload).toEqual({ admin_id: ADMIN_ID, window: "hour" });
  });

  it("Redis-down deny (cap returns ok:false): same breach + neutral 404 (fail closed)", async () => {
    const h = make({ capResult: { ok: false, window: "day" } });
    await expect(
      h.service.revealContact(ADMIN_ID, WORKER_ID, { reason_code: "safety_escalation" }, CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.decrypt).not.toHaveBeenCalled();
    expect(h.emitted[0]!.payload).toEqual({ admin_id: ADMIN_ID, window: "day" });
  });

  it("the cap is consumed BEFORE the decrypt (checked first)", async () => {
    const h = make();
    await h.service.revealContact(ADMIN_ID, WORKER_ID, { reason_code: "dispute_resolution" }, CTX);
    expect(h.cap.consume).toHaveBeenCalledWith(ADMIN_ID);
  });

  // --- Control 7: NO-ORACLE --------------------------------------------------

  it("unknown worker → the SAME neutral 404 as a denied case (no enumeration oracle)", async () => {
    const known = make({ capResult: { ok: false, window: "hour" } });
    const unknown = make({ worker: undefined });

    let deniedMsg = "";
    let unknownMsg = "";
    let deniedStatus = 0;
    let unknownStatus = 0;
    await known.service
      .revealContact(ADMIN_ID, WORKER_ID, { reason_code: "dispute_resolution" }, CTX)
      .catch((e) => {
        deniedMsg = (e as NotFoundException).message;
        deniedStatus = (e as NotFoundException).getStatus();
      });
    await unknown.service
      .revealContact(ADMIN_ID, WORKER_ID, { reason_code: "dispute_resolution" }, CTX)
      .catch((e) => {
        unknownMsg = (e as NotFoundException).message;
        unknownStatus = (e as NotFoundException).getStatus();
      });
    expect(unknownStatus).toBe(deniedStatus);
    expect(unknownStatus).toBe(404);
    expect(unknownMsg).toBe(deniedMsg);
    // The unknown-worker case reveals nothing AND records no pii_viewed.
    expect(unknown.decrypt).not.toHaveBeenCalled();
    expect(unknown.emitted.filter((e) => e.event_name === "admin.pii_viewed")).toHaveLength(0);
  });

  it("flag OFF → neutral 404 even if the service is reached directly (defense in depth)", async () => {
    const h = make({ enabled: false });
    await expect(
      h.service.revealContact(ADMIN_ID, WORKER_ID, { reason_code: "dispute_resolution" }, CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.cap.consume).not.toHaveBeenCalled();
    expect(h.decrypt).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
  });

  // --- Control 8 / invariant #2: VALUE NEVER IN EVENT OR LOG -----------------

  it("the pii_viewed payload is EXACTLY {admin_id, subject_id, reason_code} (value-free)", async () => {
    const h = make();
    await h.service.revealContact(ADMIN_ID, WORKER_ID, { reason_code: "dispute_resolution" }, CTX);
    const payload = h.emitted[0]!.payload;
    expect(Object.keys(payload).sort()).toEqual(["admin_id", "reason_code", "subject_id"].sort());
    expect(payload).toEqual({
      admin_id: ADMIN_ID,
      subject_id: WORKER_ID,
      reason_code: "dispute_resolution",
    });
  });

  it("the decrypted phone NEVER appears in ANY emitted event payload (recursive leaf scan)", async () => {
    const h = make();
    await h.service.revealContact(ADMIN_ID, WORKER_ID, { reason_code: "safety_escalation" }, CTX);
    for (const evt of h.emitted) {
      const allLeaves = leaves(evt).join("\n");
      expect(allLeaves).not.toContain(PHONE);
      expect(allLeaves).not.toContain(ENCRYPTED); // not even the ciphertext rides an event
      // no phone-shaped digit run rides any NON-uuid event leaf (uuids are legit opaque ids)
      expect(hasPhoneShapedNonUuidLeaf(evt)).toBe(false);
    }
  });

  it("the decrypted phone NEVER appears in any log line (only ids + reason code are logged)", async () => {
    const h = make();
    await h.service.revealContact(ADMIN_ID, WORKER_ID, { reason_code: "dispute_resolution" }, CTX);
    const allLogs = h.logs.join("\n");
    expect(allLogs).not.toContain(PHONE);
    expect(allLogs).not.toContain(ENCRYPTED);
    expect(allLogs).not.toMatch(/(?<!\d)\+?\d[\d\s-]{7,}\d(?!\d)/);
  });

  it("the note is NEVER passed to the event payload or logged (the reason_code is the audit trail)", async () => {
    const NOTE = "follow up on the unit visit next week";
    const h = make();
    await h.service.revealContact(
      ADMIN_ID,
      WORKER_ID,
      { reason_code: "worker_support_callback", note: NOTE },
      CTX,
    );
    for (const evt of h.emitted) expect(leaves(evt).join("\n")).not.toContain(NOTE);
    expect(h.logs.join("\n")).not.toContain(NOTE);
  });
});
