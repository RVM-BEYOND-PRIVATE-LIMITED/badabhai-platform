import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * What one worker's DETAIL page renders after the 2026-08-18 name ruling.
 *
 * The CTO was shown the security recommendation to put names on the detail page only for v1 and
 * chose BOTH surfaces, so this page carries the name as its heading. That is the assertion this
 * file is really about: a heading is a single value with no dash convention behind it, so the
 * null case has to fall back to something rather than render an empty line — and the id it falls
 * back to must not disappear when a name IS present, because the id is the join onto the spine.
 */

const stub = vi.hoisted(() => {
  class RequestError extends Error {
    constructor(readonly status: number) {
      super(`the admin API returned ${status}`);
    }
  }
  return {
    RequestError,
    capabilities: ["read_entities", "read_identity"] as string[],
    worker: null as Record<string, unknown> | null,
  };
});

vi.mock("../../../../lib/auth", () => ({
  requireCapability: async () => ({
    adminId: "a-1",
    role: "ops_admin",
    capabilities: stub.capabilities,
  }),
}));

vi.mock("../../../../lib/admin-http", () => ({
  isAdminRequestError: (err: unknown) => err instanceof stub.RequestError,
}));

vi.mock("../../../../lib/entities", () => ({
  getWorker: async () => stub.worker,
  listApplications: async () => ({ items: [], nextCursor: null }),
}));

// The header is a Client Component using `useRouter`, which needs an app-router context this
// renderer does not provide. Stubbed to render the server-built `title` it is handed — which is
// the part of it this file is testing.
vi.mock("./worker-detail-header", () => ({
  WorkerDetailHeader: ({ title }: { title: unknown }) => title,
}));

const { default: WorkerDetailPage } = await import("./page");

const WORKER_ID = "5eeded00-0001-4a00-8000-000000000001";

const FACELESS = {
  id: WORKER_ID,
  status: "active",
  preferred_language: "hi",
  has_photo: false,
  resume_show_photo: true,
  resume_night_shift_ready: false,
  deletion_scheduled_at: null,
  created_at: "2026-08-19T09:00:00.000Z",
  updated_at: "2026-08-19T09:00:00.000Z",
  profile_status: "confirmed",
  profile_updated_at: "2026-08-19T09:30:00.000Z",
  has_resume: true,
  application_count: 3,
  unlock_count: 1,
};

beforeEach(() => {
  stub.capabilities = ["read_entities", "read_identity"];
  stub.worker = { ...FACELESS, full_name: "Ramesh Kumar" };
});

const render = async () =>
  renderToStaticMarkup(await WorkerDetailPage({ params: Promise.resolve({ id: WORKER_ID }) }));

describe("the heading, when a name was disclosed", () => {
  it("is the NAME, and is not set in the monospace id face", async () => {
    // `mono` is an opaque-identifier treatment. A person's name in it reads as a machine token.
    const out = await render();
    expect(out).toContain('<h1 class="page__title">Ramesh Kumar</h1>');
  });

  it("keeps the full id on the page — as a record row, not only in a link", async () => {
    const out = await render();
    expect(out).toContain(`<span class="mono">${WORKER_ID}</span>`);
  });

  it("adds a Name row to the record, and says the plaintext is response-scoped", async () => {
    const out = await render();
    expect(out).toContain("Name");
    expect(out).toContain("decrypted for this response only");
  });

  it("says the page now answers WHO as well as what", async () => {
    const out = await render();
    expect(out).toContain("what they did, and who they are");
  });
});

describe("the heading, when the worker never gave us a name", () => {
  beforeEach(() => {
    stub.worker = { ...FACELESS, full_name: null };
  });

  it("falls back to the short id rather than rendering an empty heading", async () => {
    // The layout-collapse case, and the reason the heading is not simply `{worker.full_name}`.
    const out = await render();
    expect(out).toContain('<h1 class="page__title mono">5eeded00…</h1>');
  });

  it("drops the WHO clause instead of claiming an identity it does not have", async () => {
    const out = await render();
    expect(out).toContain("what they did.");
    expect(out).not.toContain("who they are");
  });

  it("still shows the Name row, dashed — this read WAS disclosed", async () => {
    // The distinction that makes the dash honest: the server told us nobody recorded a name.
    // Hiding the row here would make "disclosed and empty" look like "withheld".
    const out = await render();
    expect(out).toContain('title="No name on record for this account."');
  });

  it("renders a BLANK name exactly as a null one", async () => {
    stub.worker = { ...FACELESS, full_name: "   " };
    const out = await render();
    expect(out).toContain('<h1 class="page__title mono">5eeded00…</h1>');
    expect(out).toContain('title="No name on record for this account."');
  });
});

describe("an analyst", () => {
  beforeEach(() => {
    stub.capabilities = ["read_entities"];
    stub.worker = { ...FACELESS };
  });

  it("gets the id heading and NO Name row at all", async () => {
    const out = await render();
    expect(out).toContain('<h1 class="page__title mono">5eeded00…</h1>');
    expect(out).not.toContain("No name on record");
  });

  it("is told the omission is about their role, not about this worker", async () => {
    const out = await render();
    expect(out).toContain("Names are not served to your role");
    expect(out).not.toContain("decrypted for this response only");
  });

  it("sees no withheld banner", async () => {
    const out = await render();
    expect(out).not.toContain("Names are withheld on this page");
  });

  it("keeps the rest of the record intact", async () => {
    const out = await render();
    // The timeline/journey links live inside the stubbed header, so the record and activity
    // panels are what this asserts — everything the page itself renders.
    expect(out).toContain(`<span class="mono">${WORKER_ID}</span>`);
    expect(out).toContain("Resume generated");
    expect(out).toContain("Times unlocked");
    expect(out).toContain("Night shift ready");
  });
});

describe("an entitled admin whose budget is spent", () => {
  beforeEach(() => {
    stub.capabilities = ["read_entities", "read_identity"];
    stub.worker = { ...FACELESS };
  });

  it("explains the id heading rather than leaving it looking like a regression", async () => {
    const out = await render();
    expect(out).toContain("Names are withheld on this page");
    expect(out).toContain("hourly name budget");
    expect(out).toContain('<h1 class="page__title mono">5eeded00…</h1>');
  });

  it("does NOT dash a Name row — nothing was disclosed to dash", async () => {
    const out = await render();
    expect(out).not.toContain("No name on record");
  });

  it("does not tell them their role lacks the capability", async () => {
    const out = await render();
    expect(out).not.toContain("Names are not served to your role");
  });
});

describe("the deletion banner still wins its own space", () => {
  it("renders alongside a withheld banner rather than being replaced by it", async () => {
    // Two banners can be true at once, and the deletion one is the irreversible fact on the
    // page. A withheld-names notice must never be what pushes it off the screen.
    stub.worker = { ...FACELESS, deletion_scheduled_at: "2026-09-01T00:00:00.000Z" };
    const out = await render();
    expect(out).toContain("Names are withheld on this page");
    expect(out).toContain("Deletion scheduled.");
  });
});
