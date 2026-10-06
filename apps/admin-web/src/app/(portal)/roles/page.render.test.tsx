import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The roles matrix's MARKUP hooks for its pinned capability column (#1856). The CSS
 * (`.table--matrix .table__rowhead`, `.table--matrix thead th:first-child`, fenced in
 * table-rowhead.css.test.ts) only reaches the right cells if the page keeps rendering them:
 * the modifier on THIS table, every row header a `th scope="row"` with the hook class, and the
 * Capability column header FIRST (the corner the CSS pins on both axes).
 */
const stub = vi.hoisted(() => ({
  matrix: null as unknown,
  failure: null as unknown,
  capabilities: ["read_entities"] as string[],
  reads: 0,
}));

vi.mock("../../../lib/auth", () => ({
  requireSession: async () => ({
    adminId: "a-1",
    role: "ops_admin",
    capabilities: stub.capabilities,
  }),
}));

vi.mock("../../../lib/entities", () => ({
  getCapabilityMatrix: async () => {
    stub.reads++;
    if (stub.failure) throw stub.failure;
    return stub.matrix;
  },
}));

const { default: RolesPage } = await import("./page");

const MATRIX = {
  roles: ["super_admin", "ops_admin", "support", "analyst"],
  matrix: [
    { capability: "read_events", roles: ["super_admin", "ops_admin", "support", "analyst"] },
    { capability: "read_ai_traces", roles: ["super_admin"] },
    { capability: "manage_admins", roles: ["super_admin"] },
    // One the portal has not been taught about — still a row, still a row header.
    { capability: "a_new_capability", roles: ["super_admin"] },
  ],
};

beforeEach(() => {
  stub.matrix = MATRIX;
  stub.failure = null;
  stub.capabilities = ["read_entities"];
  stub.reads = 0;
});

const render = async () => renderToStaticMarkup(await RolesPage());

describe("the capability matrix", () => {
  it("carries the matrix modifier — the pinned column is scoped to THIS table", async () => {
    const out = await render();
    expect(out).toContain('<table class="table table--matrix">');
    expect(out.match(/class="table[ "]/g)).toHaveLength(1);
  });

  it("renders every capability as a row header with the hook class", async () => {
    const out = await render();
    const heads = out.match(/<th scope="row" class="table__rowhead">/g) ?? [];
    expect(heads).toHaveLength(MATRIX.matrix.length);
    expect(out).toContain('<th scope="row" class="table__rowhead">Read events</th>');
    expect(out).toContain('<th scope="row" class="table__rowhead">a new capability</th>');
  });

  it("puts the Capability column header first — the corner cell the CSS pins both ways", async () => {
    const out = await render();
    const thead = out.slice(out.indexOf("<thead>"), out.indexOf("</thead>"));
    expect(thead.startsWith('<thead><tr><th scope="col">Capability</th>')).toBe(true);
  });

  it("a failed read renders the error state, and no table", async () => {
    stub.failure = new Error("boom");
    const out = await render();
    expect(out).toContain("The capability matrix could not be loaded");
    expect(out).not.toContain("table--matrix");
  });
});

describe("the copy says where a role is changed (owner brief 2026-10-01)", () => {
  it("no longer claims it cannot be done here — Change role exists on Admin users", async () => {
    stub.failure = null;
    stub.matrix = MATRIX;
    const out = await render();
    expect(out).not.toContain("cannot be done from this portal");
    expect(out).toContain("Change role");
    expect(out).toContain("Admin users");
    // An ops admin cannot open /admins (manage_admins), so it is named, not linked.
    expect(out).not.toContain('href="/admins"');
  });
});

describe("the matrix marks are named glyphs, not characters (owner brief 2026-10-01)", () => {
  it("draws check / minus from the icon font, each with a name assistive tech reads", async () => {
    stub.failure = null;
    stub.matrix = MATRIX;
    const out = await render();
    expect(out).toContain('<i class="ph-fill ph-check" role="img" aria-label="Permitted"></i>');
    expect(out).toContain('<i class="ph-fill ph-minus" role="img" aria-label="Not granted"></i>');
    expect(out).not.toContain("\u2713");
    expect(out).not.toContain(">\u00b7<");
  });
});

/**
 * #1900: the matrix is served on `read_entities`, the page only needs a session. A role without
 * `read_entities` keeps "Your access" and is told the matrix is withheld — it is never sent the
 * read that would 403, and never shown the error state that read would produce.
 */
describe("a role without read_entities (#1900)", () => {
  it("does not request the matrix, and shows a clean withheld state instead of an error", async () => {
    stub.capabilities = ["read_events"];
    const out = await render();
    expect(stub.reads).toBe(0);
    expect(out).toContain("The full matrix is not available to your role");
    expect(out).not.toContain("state--error");
    expect(out).not.toContain("could not be loaded");
    expect(out).not.toContain("table--matrix");
  });

  it("still lists its own access, from the session", async () => {
    stub.capabilities = ["read_events"];
    const out = await render();
    expect(out).toContain('<li class="chip">Read events</li>');
  });

  it("a role holding it still reads the matrix", async () => {
    const out = await render();
    expect(stub.reads).toBe(1);
    expect(out).toContain("table--matrix");
  });
});
