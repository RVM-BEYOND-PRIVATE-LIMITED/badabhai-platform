import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * The identity half of the entity data layer: the three-state name contract, and the ONE
 * caching rule that must hold for every read that can carry a name.
 *
 * ── WHY CACHING IS A SECURITY ASSERTION HERE, NOT A PERFORMANCE ONE ─────────────────────
 * `adminFetch` sends `cache: "no-store"` only while `revalidate` is UNDEFINED. Passing a number
 * swaps it for `next: { revalidate }`, which writes the response body into Next's on-disk Data
 * Cache under `.next/cache`. A decrypted worker name in there outlives the audited, budgeted read
 * that disclosed it and is served to the NEXT admin — including one holding no `read_identity` —
 * with no `admin.identity_viewed` row written and nothing charged against anyone's budget. It is
 * a one-word change with no visible symptom, which is exactly the kind of regression a test has
 * to hold rather than a comment.
 *
 * This file is in two halves on purpose. The behavioural half proves what today's helpers pass
 * at runtime. The source half DERIVES which helpers are identity-bearing — from the schemas they
 * parse with, not from a list somebody remembered to update — so a sixth one added tomorrow is
 * covered by the rule the moment it is written.
 */

const adminFetch = vi.hoisted(() =>
  vi.fn(async (_path: string, _opts?: Record<string, unknown>) => ({
    items: [] as unknown[],
    nextCursor: null,
  })),
);
vi.mock("./admin-http", () => ({ adminFetch }));

const entities = await import("./entities");
const SOURCE = readFileSync(new URL("./entities.ts", import.meta.url), "utf8");

/**
 * The same source with COMMENTS REMOVED, for any assertion about what the file does not
 * contain. A grep cannot tell a declaration from the prose explaining why the declaration is
 * absent — the header of `entities.ts` names `agency_kyc.account_holder_name_enc` precisely to
 * record that it is NOT a substitute for a contact person, and a naive scan reads that sentence
 * as the field it forbids. (No string literal in that file contains `//`, so this is safe here
 * and nowhere claimed to be a general-purpose comment stripper.)
 */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

beforeEach(() => {
  adminFetch.mockClear();
});

// ---------------------------------------------------------------------------
// Deriving "identity-bearing" from the schemas, never from a hand-kept list
// ---------------------------------------------------------------------------

/** The three name keys the 2026-08-18 ruling put on this surface, and no others. */
const NAME_KEYS = ["full_name", "org_name", "name"];

/** Does this schema — or anything it nests, e.g. a page's `items` — carry a name key? */
function carriesName(schema: z.ZodTypeAny): boolean {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    if (Object.keys(shape).some((key) => NAME_KEYS.includes(key))) return true;
    return Object.values(shape).some(carriesName);
  }
  if (schema instanceof z.ZodArray) return carriesName(schema.element as z.ZodTypeAny);
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return carriesName(schema.unwrap() as z.ZodTypeAny);
  }
  return false;
}

/** One exported helper's `adminFetch` call, with the schema it parses the response with. */
interface FetchCall {
  helper: string;
  schemaName: string | null;
  /** The `adminFetch(...)` call itself, from the opening paren to its terminating `);`. */
  text: string;
}

function fetchCalls(): FetchCall[] {
  const starts: Array<[string, number]> = [];
  const re = /export function (\w+)\(/g;
  for (let m = re.exec(SOURCE); m !== null; m = re.exec(SOURCE)) {
    starts.push([m[1]!, m.index]);
  }
  const out: FetchCall[] = [];
  starts.forEach(([helper, at], i) => {
    const body = SOURCE.slice(at, i + 1 < starts.length ? starts[i + 1]![1] : SOURCE.length);
    const call = body.indexOf("adminFetch(");
    if (call === -1) return;
    // Bounded at the call's own `);` rather than run to the next export: a prose comment two
    // helpers below that happened to mention caching would otherwise fail the sweep.
    const text = body.slice(call, body.indexOf(");", call) + 2);
    out.push({ helper, schemaName: text.match(/schema:\s*(\w+)/)?.[1] ?? null, text });
  });
  return out;
}

const CALLS = fetchCalls();
const SCHEMAS = entities as unknown as Record<string, z.ZodTypeAny | undefined>;
const IDENTITY_CALLS = CALLS.filter((c) => {
  const schema = c.schemaName === null ? undefined : SCHEMAS[c.schemaName];
  return schema !== undefined && carriesName(schema);
});

describe("which reads are identity-bearing, derived", () => {
  it("is exactly the five the server puts `Cache-Control: no-store` on", () => {
    // Pinned as a literal against a DERIVED set, so the two ways of knowing have to agree. A
    // sixth name-bearing helper fails here and its author has to decide what the screen does
    // with a name, rather than the read quietly joining the surface untested.
    expect(IDENTITY_CALLS.map((c) => c.helper).sort()).toEqual([
      "getPayer",
      "getWorker",
      "listAdmins",
      "listPayers",
      "listWorkers",
    ]);
  });

  it("the derivation actually DISCRIMINATES — most reads here carry no name", () => {
    // Anti-vacuity. A `carriesName` that returned true for everything would satisfy nothing
    // above but would make the no-revalidate sweep below look far broader than it is; one that
    // returned false for everything would make the sweep vacuous.
    expect(CALLS.length).toBeGreaterThan(IDENTITY_CALLS.length);
    expect(carriesName(entities.jobPostingListItemSchema)).toBe(false);
    expect(carriesName(entities.creditsViewSchema)).toBe(false);
    expect(carriesName(entities.ledgerPageSchema)).toBe(false);
  });

  it("sees THROUGH a page envelope to the row shape", () => {
    // `listWorkers` parses `{ items, nextCursor }`; the name is one level down. A derivation
    // that only looked at top-level keys would classify every LIST as faceless — i.e. exactly
    // the reads that disclose fifty names at a time.
    expect(carriesName(entities.workersPageSchema)).toBe(true);
    expect(carriesName(entities.workerListItemSchema)).toBe(true);
  });
});

describe("no identity-bearing read may be cached", () => {
  const CALLABLE: Record<string, () => Promise<unknown>> = {
    listWorkers: () => entities.listWorkers(),
    getWorker: () => entities.getWorker("w1"),
    listPayers: () => entities.listPayers(),
    getPayer: () => entities.getPayer("p1"),
    listAdmins: () => entities.listAdmins(),
  };

  it.each(IDENTITY_CALLS.map((c) => c.helper))("%s passes NO revalidate at runtime", async (h) => {
    await CALLABLE[h]!();
    // Anti-vacuity: a helper that stopped calling the transport would otherwise pass by never
    // producing an options object to inspect.
    expect(adminFetch).toHaveBeenCalledTimes(1);
    const opts = adminFetch.mock.calls[0]![1];
    // The KEY, not the value. `{ revalidate: undefined }` reads as absent to `opts.revalidate`
    // while sitting one character away from `{ revalidate: 60 }` in a diff.
    expect(opts !== undefined && "revalidate" in opts).toBe(false);
  });

  it.each(IDENTITY_CALLS.map((c) => c.helper))("%s says nothing about revalidate in source", (h) => {
    // The source half catches what the runtime half cannot: a `revalidate` reached through a
    // spread, a variable, or a branch the test's arguments never take.
    const call = IDENTITY_CALLS.find((c) => c.helper === h)!;
    expect(call.text).not.toContain("revalidate");
  });

  it("the harness WOULD see a revalidate — the two assertions above are not vacuous", async () => {
    // Proves the mock records its second argument at all. Without this, a mock declared with no
    // parameters would make every "no revalidate" assertion unfailable.
    await adminFetch("/admin/anything", { revalidate: 60 });
    expect("revalidate" in adminFetch.mock.calls.at(-1)![1]!).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The three states, through the real schemas
// ---------------------------------------------------------------------------

const WORKER_ROW = {
  id: "5eeded00-0001-4a00-8000-000000000001",
  status: "active",
  preferred_language: "hi",
  has_photo: false,
  resume_show_photo: true,
  resume_night_shift_ready: false,
  deletion_scheduled_at: null,
  created_at: "2026-08-20T11:29:59.036Z",
  updated_at: "2026-08-20T11:29:59.036Z",
};

const PAYER_ROW = {
  id: "6155050c-c91b-4c6e-96a7-8da023f1d2d2",
  role: "employer",
  status: "pending",
  previous_status: null,
  created_at: "2026-08-20T11:30:00.000Z",
  updated_at: "2026-08-20T11:30:00.000Z",
};

const ADMIN_ROW = {
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  role: "super_admin",
  status: "active",
  mfa_enrolled: true,
  last_login_at: "2026-08-20T12:00:00.000Z",
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-20T12:00:00.000Z",
  is_self: true,
};

/** The three name-bearing row shapes and their keys, so each assertion runs against all three. */
const SHAPES = [
  ["worker", entities.workerListItemSchema, WORKER_ROW, "full_name"],
  ["payer", entities.payerListItemSchema, PAYER_ROW, "org_name"],
  ["admin", entities.adminRowSchema, ADMIN_ROW, "name"],
] as const;

describe("the name field survives parsing as THREE distinct states", () => {
  it.each(SHAPES)("%s: an absent key stays ABSENT on the parsed object", (_l, schema, row, key) => {
    // The load-bearing property of the whole feature, and a fact about Zod 3 this portal now
    // depends on: an optional key missing from the input is not added to the output. If that
    // ever changed — to `undefined`, or to `null` — "not disclosed" and "no name on record"
    // would become the same value and every capped page would start printing the lie.
    expect(Object.hasOwn(schema.parse(row) as object, key)).toBe(false);
  });

  it.each(SHAPES)("%s: an explicit NULL is KEPT, not dropped", (_l, schema, row, key) => {
    const parsed = schema.parse({ ...row, [key]: null }) as Record<string, unknown>;
    expect(Object.hasOwn(parsed, key)).toBe(true);
    expect(parsed[key]).toBeNull();
  });

  it.each(SHAPES)("%s: a string name parses through", (_l, schema, row, key) => {
    const parsed = schema.parse({ ...row, [key]: "Ramesh Kumar" }) as Record<string, unknown>;
    expect(parsed[key]).toBe("Ramesh Kumar");
  });

  it.each(SHAPES)("%s: a NON-string name is rejected, never rendered", (_l, schema, row, key) => {
    // A number or an object reaching the markup renders as "42" or "[object Object]" beside
    // real names, which is worse than an error state because it looks like a name.
    expect(schema.safeParse({ ...row, [key]: 42 }).success).toBe(false);
    expect(schema.safeParse({ ...row, [key]: { first: "Ramesh" } }).success).toBe(false);
  });
});

describe("the detail schemas inherit the name, and the page envelopes carry it", () => {
  it("a worker DETAIL carries full_name — the ruling covers the detail page too", () => {
    const detail = entities.workerDetailSchema.parse({
      ...WORKER_ROW,
      full_name: "Ramesh Kumar",
      profile_status: "confirmed",
      profile_updated_at: "2026-08-20T11:30:00.000Z",
      has_resume: true,
      application_count: 3,
      unlock_count: 1,
    });
    expect(detail.full_name).toBe("Ramesh Kumar");
  });

  it("a payer DETAIL carries org_name", () => {
    const detail = entities.payerDetailSchema.parse({
      ...PAYER_ROW,
      org_name: "Acme Fabrication",
      credit_balance: 10,
      posting_count: 2,
      open_posting_count: 1,
      unlock_count: 0,
    });
    expect(detail.org_name).toBe("Acme Fabrication");
  });

  it("a named page envelope keeps both states, row by row", () => {
    const page = entities.workersPageSchema.parse({
      items: [{ ...WORKER_ROW, full_name: "Ramesh Kumar" }, { ...WORKER_ROW, full_name: null }],
      nextCursor: null,
    });
    expect(page.items[0]!.full_name).toBe("Ramesh Kumar");
    expect(page.items[1]!.full_name).toBeNull();
  });
});

describe("what the row shapes still refuse", () => {
  it("an EMAIL on an admin row is dropped, never carried to the screen", () => {
    // The half of the 2026-08-18 ruling that did NOT reverse: names yes, emails no. Zod strips
    // unknown keys by default; this asserts the strip actually happens rather than assuming it.
    const parsed = entities.adminRowSchema.parse({
      ...ADMIN_ROW,
      name: "Prakash",
      email: "prakash@example.com",
      mfa_secret_enc: "v1:deadbeef",
    }) as object;
    expect(Object.hasOwn(parsed, "email")).toBe(false);
    expect(Object.hasOwn(parsed, "mfa_secret_enc")).toBe(false);
    expect(Object.hasOwn(parsed, "name")).toBe(true);
  });

  it("a phone on a worker row is dropped the same way", () => {
    const parsed = entities.workerListItemSchema.parse({
      ...WORKER_ROW,
      full_name: "Ramesh Kumar",
      phone_e164: "+919876543210",
      phone_hash: "abc123",
    }) as object;
    expect(Object.hasOwn(parsed, "phone_e164")).toBe(false);
    expect(Object.hasOwn(parsed, "phone_hash")).toBe(false);
  });

  it("no shape here has a contact-PERSON field — that column does not exist", () => {
    // Scoped out explicitly by the ruling. Neither `payers.email_enc` nor
    // `agency_kyc.account_holder_name_enc` (an ADR-0022 money/legal gate) is a substitute, and
    // a schema is how a UI grows a field the server will never send.
    expect(CODE).not.toMatch(/contact_name|contact_person|account_holder/);
    // …and the stripper did not simply empty the file, which would make the line above pass
    // for the wrong reason.
    expect(CODE).toContain("org_name");
  });
});
