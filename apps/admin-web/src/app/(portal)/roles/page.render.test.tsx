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
}));

vi.mock("../../../lib/auth", () => ({
  requireSession: async () => ({
    adminId: "a-1",
    role: "ops_admin",
    capabilities: ["read_entities"],
  }),
}));

vi.mock("../../../lib/entities", () => ({
  getCapabilityMatrix: async () => {
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
