import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { ZodType } from "zod";

/**
 * The AI-call-trace data layer (migration 0083).
 *
 * Four properties are load-bearing here, and each is easy to regress with nothing visibly
 * breaking:
 *
 *  1. WHAT IS ASKED FOR. Three filters, all of them selections over columns. This module must
 *     never grow one that searches the TEXT — a substring query over `ai_call_traces` is a
 *     search over everything every worker has ever said to the platform, and it would arrive
 *     looking like a small usability win.
 *  2. WHAT ONE READ COSTS. The detail helper takes exactly ONE id. Every server-side control
 *     — the fail-closed audit row, the per-admin allowance, the single-subject shape — assumes
 *     that is the only way text leaves; a "fetch these ten" helper would go around all of them.
 *  3. WHAT IS NEVER CACHED. `adminFetch` sends `cache: "no-store"` only while `revalidate` is
 *     undefined. Passing a number writes the response — a decrypted prompt included — into
 *     Next's on-disk Data Cache, where it outlives the audited read that disclosed it and is
 *     served to the next admin with no audit row written and nothing charged to anyone.
 *  4. WHAT SURVIVES A SERVER CHANGE. `task_type` and `error_code` are closed sets on the server
 *     and OPEN strings here on purpose: pinning them would blank the whole page the day a new
 *     AI surface ships, hiding exactly the calls an operator would be looking for.
 *
 * `adminFetch` is replaced with a double that records the call and parses the body THROUGH THE
 * SCHEMA IT WAS HANDED — the real transport's contract. Reproducing that makes "which schema did
 * this call actually validate against" a checked property rather than an assumption.
 */

const transport = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; opts: Record<string, unknown> }>,
  body: { items: [], nextCursor: null } as unknown,
}));

vi.mock("./admin-http", () => ({
  adminFetch: async (path: string, opts: { schema: ZodType<unknown> }) => {
    transport.calls.push({ path, opts: opts as unknown as Record<string, unknown> });
    return opts.schema.parse(transport.body);
  },
}));

const { aiTraceDetailSchema, aiTraceListItemSchema, aiTracePageSchema, getAiTrace, listAiTraces } =
  await import("./ai-traces");

const SOURCE = readFileSync(new URL("./ai-traces.ts", import.meta.url), "utf8");

/**
 * One row, field-for-field as `AdminAiTraceListItem` projects it
 * (apps/api/src/admin/admin-ai-traces.dto.ts) — `created_at` as the ISO string a `Date` becomes
 * on the wire.
 */
const ROW = {
  id: "aa000000-0001-4a00-8000-000000000001",
  ai_call_id: "cc000000-0001-4a00-8000-000000000001",
  worker_id: "5eeded00-0001-4a00-8000-000000000001",
  session_id: "5e550000-0001-4a00-8000-000000000001",
  ai_job_id: null,
  correlation_id: "req-9fd0b09",
  task_type: "profiling_chat_turn",
  model_name: "gemini-2.5-flash",
  prompt_name: null,
  prompt_version: null,
  prompt_chars: 412,
  response_chars: 88,
  real_call: true,
  success: true,
  error_code: null,
  created_at: "2026-08-19T09:00:00.000Z",
};

/**
 * The detail row. The prompt deliberately carries a name and a phone number: this is what the
 * screen actually shows, and a fixture of lorem ipsum would let every test below pass while
 * saying nothing about the case the whole surface is gated for.
 */
const DETAIL = {
  ...ROW,
  prompt: '{"messages":[{"text":"Mera naam Ramesh hai, 98765 43210"}]}',
  response: '{"reply":"Theek hai."}',
};

beforeEach(() => {
  transport.calls.length = 0;
  transport.body = { items: [], nextCursor: null };
});

const lastCall = () => transport.calls[transport.calls.length - 1]!;

describe("listAiTraces — the request it actually makes", () => {
  it("asks for the bare route when nothing is filtered", async () => {
    await listAiTraces();
    expect(lastCall().path).toBe("/admin/ai-traces");
  });

  it("carries every filter, the cursor and the page size", async () => {
    await listAiTraces({
      taskType: "profile_extraction",
      success: "false",
      workerId: "5eeded00-0001-4a00-8000-000000000001",
      cursor: "Y3Vyc29y",
      limit: 25,
    });
    expect(lastCall().path).toBe(
      "/admin/ai-traces?taskType=profile_extraction&success=false" +
        "&workerId=5eeded00-0001-4a00-8000-000000000001&cursor=Y3Vyc29y&limit=25",
    );
  });

  it("sends `success=false` rather than dropping it — the triage query, and falsy", async () => {
    // The one filter a truthiness bug eats silently. `?success=false` is THE question this
    // surface exists to make cheap, and dropping it serves a full unfiltered page under a URL
    // that claims to show only failures.
    await listAiTraces({ success: "false" });
    expect(lastCall().path).toBe("/admin/ai-traces?success=false");
  });

  it("OMITS an empty filter rather than sending `?taskType=`", async () => {
    // An unset `<select>` submits `""`, and the server's schema is `.strict()` — forwarding a
    // blank would 400 the whole page because a control was cleared rather than set.
    await listAiTraces({ taskType: "", success: "", workerId: "" });
    expect(lastCall().path).toBe("/admin/ai-traces");
  });

  it("FORWARDS an unknown task type instead of quietly dropping it", async () => {
    await listAiTraces({ taskType: "nope" });
    expect(lastCall().path).toBe("/admin/ai-traces?taskType=nope");
  });

  it("FORWARDS a workerId that is not a uuid instead of quietly dropping it", async () => {
    await listAiTraces({ workerId: "not-a-uuid" });
    expect(lastCall().path).toBe("/admin/ai-traces?workerId=not-a-uuid");
  });

  it("offers NO search over the text — the query surface is exactly five keys", async () => {
    // The load-bearing refusal. If a sixth parameter ever appears in a request from this
    // module, someone has to come here and say why it is not a way to grep worker speech.
    await listAiTraces({
      taskType: "profile_parse",
      success: "true",
      workerId: "w",
      cursor: "c",
      limit: 25,
    });
    const params = new URL(`https://portal.invalid${lastCall().path}`).searchParams;
    expect([...params.keys()].sort()).toEqual([
      "cursor",
      "limit",
      "success",
      "taskType",
      "workerId",
    ]);
  });

  it("returns the parsed page, not the raw body", async () => {
    transport.body = { items: [ROW], nextCursor: "bmV4dA" };
    const page = await listAiTraces();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.prompt_chars).toBe(412);
    expect(page.nextCursor).toBe("bmV4dA");
  });
});

describe("getAiTrace — one id, and only one", () => {
  it("asks for exactly that trace", async () => {
    transport.body = DETAIL;
    await getAiTrace(ROW.id);
    expect(lastCall().path).toBe(`/admin/ai-traces/${ROW.id}`);
  });

  it("percent-encodes the id it puts into the path", async () => {
    // An id reaches this helper straight from the address bar, so it is not guaranteed to be a
    // uuid. An unescaped `?` or `#` would silently address a different route than the one the
    // page believes it is reading — and this route decrypts.
    transport.body = DETAIL;
    await getAiTrace("a#b?c");
    expect(lastCall().path).toBe("/admin/ai-traces/a%23b%3Fc");
  });

  it("returns the two decrypted halves VERBATIM", async () => {
    transport.body = DETAIL;
    const trace = await getAiTrace(ROW.id);
    expect(trace.prompt).toBe(DETAIL.prompt);
    expect(trace.response).toBe(DETAIL.response);
  });

  it("accepts null on either half — the server degrades, it does not fail", async () => {
    transport.body = { ...DETAIL, prompt: null, response: null };
    const trace = await getAiTrace(ROW.id);
    expect(trace.prompt).toBeNull();
    expect(trace.response).toBeNull();
  });

  it("a body the schema rejects becomes a thrown error, never a half-rendered page", async () => {
    transport.body = { ...DETAIL, prompt: 7 };
    await expect(getAiTrace(ROW.id)).rejects.toThrow();
  });
});

describe("nothing here is ever written to Next's data cache", () => {
  it("neither helper passes `revalidate` at runtime", async () => {
    transport.body = { items: [], nextCursor: null };
    await listAiTraces();
    expect(lastCall().opts).not.toHaveProperty("revalidate");
    transport.body = DETAIL;
    await getAiTrace(ROW.id);
    expect(lastCall().opts).not.toHaveProperty("revalidate");
  });

  it("and no CODE in the module mentions it at all", () => {
    // Belt and braces on the runtime check above, so a sixth helper added to this file tomorrow
    // is covered by the rule the moment it is written rather than when someone remembers to
    // test it. Comments are stripped first: a grep cannot tell a call site from the header
    // sentence explaining why there must never be one — the trap `entities.identity.test.ts`
    // documents. (No string literal in ai-traces.ts contains `//`, so this is safe here and is
    // claimed nowhere as a general-purpose comment stripper.)
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(code, "a `revalidate` in this module is a decrypted prompt on disk").not.toContain(
      "revalidate",
    );
  });
});

describe("the row schema — closed on the server, OPEN here, deliberately", () => {
  it("accepts a task type this build has never heard of", () => {
    // The column is `text` with no IN-list CHECK precisely so the AI service can gain a surface
    // without a migration landing first. An enum here would turn that routine widening into a
    // parse failure that blanks the whole page — hiding the new surface an operator is hunting.
    expect(aiTraceListItemSchema.parse({ ...ROW, task_type: "brand_new_surface" }).task_type).toBe(
      "brand_new_surface",
    );
  });

  it("accepts an error code this build has never heard of", () => {
    expect(aiTraceListItemSchema.parse({ ...ROW, error_code: "novel_code" }).error_code).toBe(
      "novel_code",
    );
  });

  it("accepts null on both character counts — nothing stored is not zero", () => {
    const row = aiTraceListItemSchema.parse({ ...ROW, prompt_chars: null, response_chars: null });
    expect(row.prompt_chars).toBeNull();
    expect(row.response_chars).toBeNull();
  });

  it("REQUIRES both counts to be present — absent is not the same claim as null", () => {
    // Null is the server saying "nothing was stored for this half". Absent is a projection that
    // stopped sending the field, and treating that as null would render an em dash on every row
    // for ever while the column quietly went missing.
    const { prompt_chars: _drop, ...rest } = ROW;
    expect(aiTraceListItemSchema.safeParse(rest).success).toBe(false);
  });

  it("requires created_at as a string — the wire form of the server's timestamp", () => {
    expect(aiTraceListItemSchema.safeParse({ ...ROW, created_at: 1_755_594_000_000 }).success).toBe(
      false,
    );
  });
});

describe("privacy — neither projection can grow a field it was not asked for", () => {
  it("the LIST row drops ciphertext and identity the server should never have sent", () => {
    // The one direction these schemas must fail in. The server's list projection selects
    // neither ciphertext column, so a token appearing here means something upstream regressed —
    // and the portal must not start rendering it.
    const parsed = aiTraceListItemSchema.parse({
      ...ROW,
      prompt_enc: "v1.aaa.bbb.ccc",
      response_enc: "v1.ddd.eee.fff",
      prompt: "Mera naam Ramesh hai",
      worker_name: "Ramesh Kumar",
      worker_phone: "+919876543210",
    });
    for (const leaked of ["prompt_enc", "response_enc", "prompt", "worker_name", "worker_phone"]) {
      expect(parsed, `the list row must not carry ${leaked}`).not.toHaveProperty(leaked);
    }
  });

  it("the DETAIL row carries the two plaintext halves and NOTHING else new", () => {
    // Exactly two keys more than the list row. A third would be a disclosure nobody reviewed.
    const listKeys = Object.keys(aiTraceListItemSchema.parse(ROW));
    const detailKeys = Object.keys(aiTraceDetailSchema.parse(DETAIL));
    expect(detailKeys.filter((k) => !listKeys.includes(k)).sort()).toEqual(["prompt", "response"]);
  });

  it("the detail row still drops the ciphertext it was decrypted from", () => {
    const parsed = aiTraceDetailSchema.parse({ ...DETAIL, prompt_enc: "v1.aaa.bbb.ccc" });
    expect(parsed).not.toHaveProperty("prompt_enc");
  });
});

describe("the page envelope", () => {
  it("is `{ items, nextCursor }` — the entity shape, not the events one", () => {
    expect(aiTracePageSchema.safeParse({ events: [ROW], nextCursor: null }).success).toBe(false);
    expect(aiTracePageSchema.parse({ items: [ROW], nextCursor: null }).items).toHaveLength(1);
  });

  it("REQUIRES nextCursor — an absent cursor is not the same claim as a null one", () => {
    expect(aiTracePageSchema.safeParse({ items: [] }).success).toBe(false);
    expect(aiTracePageSchema.safeParse({ items: [], nextCursor: null }).success).toBe(true);
  });
});
