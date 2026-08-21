import "reflect-metadata";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Logger } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import type { AdminRole } from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import type { EventsService } from "../events/events.service";
import type { AuthenticatedAdmin } from "./admin-auth.guard";
import { AdminIdentityService, ADMIN_IDENTITY_MAX_SUBJECTS } from "./admin-identity.service";
import { AdminEgressCapService } from "./admin-egress-cap.service";
import type { AdminIdentityCapService } from "./admin-identity-cap.service";
import type { AdminIdentityRepository, AdminIdentityRow } from "./admin-identity.repository";

/**
 * §2 PRIVACY-FIRST, on the ONE code path that holds a decrypted name in a local variable.
 *
 * WHY THIS IS A UNIT TEST AND NOT A SOURCE SCAN. Everywhere else in `admin-static-guards.test.ts`
 * the enforcement layer is a scan over source text, and for a PROJECTION that is the right layer:
 * a column either appears in a select list or it does not. Logging is different in kind. The
 * plaintext arrives as a VALUE, and there is no lexical form to forbid — a scan can ban
 * `logger.warn(name)` and be defeated by `logger.warn(\`for ${who}\`)`, by a template built two
 * lines earlier, by an object spread, by `JSON.stringify(row)`, or by a `catch (err)` whose error
 * message happens to embed the input. The only test that covers all of those is one that RUNS the
 * code and reads every string the logger was actually handed.
 *
 * So: drive the real service through every branch that can log, capture EVERY argument to EVERY
 * Logger method, and assert the plaintext (and the ciphertext, which is the name too) appears in
 * none of them. The assertion is over the concatenation of everything captured, so a leak in an
 * extra argument, a second call, or an interpolated object cannot slip past by not being the
 * first parameter.
 */

const CTX: RequestContext = { requestId: "req-1", correlationId: "cor-1" };
const ADMIN_ID = "aaaaaaaa-1111-4000-8000-00000000beef";
const W1 = "11111111-0000-4000-8000-000000000001";

/** A distinctive name + token, so a substring match cannot pass by coincidence. */
const PLAINTEXT = "Ramesh Kumar Chaudhary";
const CIPHERTEXT = "v1:ZGVhZGJlZWY=:cipher-ramesh-token";

const admin = (role: AdminRole = "support"): AuthenticatedAdmin => ({
  id: ADMIN_ID,
  role,
  sid: "sess-1",
});

/**
 * Every string any Logger method was handed this test, flattened. Nest's `Logger` writes through
 * instance methods, so spying on the PROTOTYPE catches every logger in the process — including
 * ones constructed inside a service we never touch directly.
 */
let logged: string[];

function captured(): string {
  return logged.join("\n");
}

beforeEach(() => {
  logged = [];
  for (const level of ["log", "error", "warn", "debug", "verbose", "fatal"] as const) {
    const method = (Logger.prototype as unknown as Record<string, unknown>)[level];
    if (typeof method !== "function") continue;
    vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      for (const a of args) {
        // Stringify rather than filter to strings: an object argument is a real leak vector
        // (`logger.warn({ row })`), and the transport would serialize it for the console.
        logged.push(typeof a === "string" ? a : safeStringify(a));
      }
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function service(opts: {
  rows?: AdminIdentityRow[];
  cap?: { ok: true } | { ok: false; window: "hour" | "day" };
  decryptThrows?: boolean;
} = {}): AdminIdentityService {
  const rows = opts.rows ?? [{ id: W1, nameCipher: CIPHERTEXT }];
  return new AdminIdentityService(
    {
      workerNames: vi.fn(async () => rows),
      payerOrgNames: vi.fn(async () => rows),
      adminNames: vi.fn(async () => rows),
    } as unknown as AdminIdentityRepository,
    {
      consume: vi.fn(async () => opts.cap ?? { ok: true as const }),
    } as unknown as AdminIdentityCapService,
    {
      decrypt: vi.fn(() => {
        if (opts.decryptThrows) {
          // A real crypto failure often embeds its INPUT in the message. That is the subtle
          // leak this whole file exists to catch: `catch (err) { logger.warn(err.message) }`
          // would then print the ciphertext of somebody's name into the log stream.
          throw new Error(`unknown kid for token ${CIPHERTEXT}`);
        }
        return PLAINTEXT;
      }),
    } as unknown as PiiCryptoService,
    { emit: vi.fn(async () => undefined) } as unknown as EventsService,
  );
}

describe("no decrypted name ever reaches the logger", () => {
  it("the SUCCESS path: a name is returned to the caller and logged nowhere", async () => {
    const svc = service();
    const names = await svc.resolve(admin(), "workers", [W1], W1, CTX);

    // The name really was disclosed — otherwise this test would pass vacuously by never
    // decrypting anything at all.
    expect(names!.get(W1)).toBe(PLAINTEXT);
    expect(captured()).not.toContain(PLAINTEXT);
    expect(captured()).not.toContain("Ramesh");
    expect(captured()).not.toContain(CIPHERTEXT);
    // A clean read is not an event worth a log line either way.
    expect(logged).toEqual([]);
  });

  it("the DECRYPT-FAILURE path logs — and leaks neither the ciphertext nor the error's text", async () => {
    // This branch is the only one that logs while holding a name-bearing value, and the caught
    // error's own message embeds the token. Re-raising `err.message` into the warn is the
    // natural, helpful-looking thing to write; it is also the leak.
    const svc = service({ decryptThrows: true });
    const names = await svc.resolve(admin(), "workers", [W1], W1, CTX);

    expect(names!.get(W1)).toBeNull(); // degraded, not thrown
    expect(logged.length, "the failure must be observable at all").toBeGreaterThan(0);
    expect(captured()).not.toContain(CIPHERTEXT);
    expect(captured()).not.toContain("cipher-ramesh-token");
    expect(captured()).not.toContain("unknown kid");
    expect(captured()).not.toContain(PLAINTEXT);
    // What it MAY say: the surface, and a truncated opaque id — enough to find the row.
    expect(captured()).toContain("workers");
    expect(captured()).toContain(W1.slice(0, 8));
    // ...and not the whole subject id, which is the join key to everything else about them.
    expect(captured()).not.toContain(W1);
  });

  it("the CAP-BREACH path logs a window and an admin PREFIX, never a subject or a name", async () => {
    const svc = service({ cap: { ok: false, window: "day" } });
    await svc.resolve(admin(), "workers", [W1], W1, CTX);

    expect(logged.length).toBeGreaterThan(0);
    expect(captured()).not.toContain(PLAINTEXT);
    expect(captured()).not.toContain(CIPHERTEXT);
    // A breach is about an ACCOUNT's velocity. Naming the worker being looked at would make the
    // alert stream a browsing history of exactly the people the cap exists to protect.
    expect(captured()).not.toContain(W1);
    expect(captured()).not.toContain(ADMIN_ID); // prefix only
    expect(captured()).toContain(ADMIN_ID.slice(0, 8));
    expect(captured()).toContain("day");
  });

  it("the OVER-BOUND path names a count and a surface, never the ids it refused", async () => {
    // The refusal log is written while holding the caller's whole id set — the one place a
    // `${ids}` interpolation would dump every subject on the page into the log stream.
    const ids = Array.from(
      { length: ADMIN_IDENTITY_MAX_SUBJECTS + 1 },
      (_, i) => `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`,
    );
    const svc = service({ rows: [] });
    await expect(svc.resolve(admin(), "workers", ids, null, CTX)).resolves.toBeNull();

    expect(logged.length).toBeGreaterThan(0);
    expect(captured()).toContain(String(ids.length));
    for (const id of ids) expect(captured(), `refused id ${id} leaked`).not.toContain(id);
  });

  it("the un-entitled path logs NOTHING — only the bound is a bug worth an ERROR", async () => {
    // The two silent denials that look identical to the caller are told apart HERE. An analyst
    // hitting the workers list is ordinary, permitted traffic; logging it would turn a normal
    // page view into an error-rate signal and, over time, into a record of which admins opened
    // which screens.
    const ids = Array.from(
      { length: ADMIN_IDENTITY_MAX_SUBJECTS + 1 },
      (_, i) => `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`,
    );
    const svc = service({ rows: [] });
    await expect(svc.resolve(admin("analyst"), "workers", ids, null, CTX)).resolves.toBeNull();
    expect(logged).toEqual([]);
  });

  it("the EGRESS CAP's own logger leaks no admin id and no disclosure count", async () => {
    // The cap service logs on two branches of its own (a Redis outage, a bad increment) and is
    // shared with the reveal path, so it is covered here rather than trusted.
    const cap = new AdminEgressCapService(
      {
        ADMIN_IDENTITY_MAX_PER_HOUR: 300,
        ADMIN_IDENTITY_MAX_PER_DAY: 1000,
      } as unknown as ServerConfig,
      // The Redis error message itself embeds the full admin id — so the assertion below also
      // proves the raw `err.message` is not being echoed wholesale into the log.
      { client: Promise.reject(new Error(`ECONNREFUSED for ${ADMIN_ID}`)) } as unknown as Queue,
      "admin_identity",
      "ADMIN_IDENTITY_MAX_PER_HOUR",
      "ADMIN_IDENTITY_MAX_PER_DAY",
    );

    await expect(cap.consume(ADMIN_ID, 7)).resolves.toEqual({ ok: false, window: "hour" });
    expect(logged.length).toBeGreaterThan(0);
    expect(captured()).not.toContain(ADMIN_ID);
    expect(captured()).toContain(ADMIN_ID.slice(0, 8));
  });

  it("the logger SPY is real — a deliberate leak on the same path is caught", async () => {
    // The mutation bar: every assertion above is `not.toContain`, and a capture harness that
    // silently recorded nothing would satisfy all of them. Prove the harness sees a name when
    // one is genuinely logged, so the passing tests above are evidence rather than a no-op.
    new Logger("probe").warn(`resolved ${PLAINTEXT} for ${W1}`);
    expect(captured()).toContain(PLAINTEXT);
    expect(captured()).toContain(W1);
  });
});
