import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  CUSTOMER_KIND_FILTER_ROLES,
  CUSTOMER_KIND_FILTERS,
  CUSTOMERS_HREF,
  customerHref,
  customerKindFilter,
} from "./customer";

const PAYER = "6155050c-c91b-4c6e-96a7-8da023f1d2d2";

/**
 * `customerHref` — the one place a customer cell's address is built (#2032, sweep AW-28). Since A6
 * (#2576) a Company and an Agency share one section, Directory › Companies, so every customer —
 * whatever its role, and with none known — opens `/companies/:id`; the page reads the role itself.
 */
describe("customerHref", () => {
  it("opens every customer in the one Companies section", () => {
    expect(CUSTOMERS_HREF).toBe("/companies");
    expect(customerHref(PAYER)).toBe(`/companies/${PAYER}`);
  });

  it("never builds the retired /agencies address", () => {
    expect(customerHref(PAYER)).not.toContain("/agencies");
  });

  it("keeps a legacy opaque id inside its one path segment", () => {
    expect(customerHref("legacy/../x?y")).toBe("/companies/legacy%2F..%2Fx%3Fy");
  });
});

/**
 * The Kind filter on Companies (A6): the address says what an operator reads — `kind=company`,
 * `kind=agency` — and the page asks the API for the stored role. Anything else is no filter.
 */
describe("the Kind filter", () => {
  it("maps each kind in the address to the role GET /admin/payers takes", () => {
    expect(CUSTOMER_KIND_FILTER_ROLES).toEqual({ company: "employer", agency: "agent" });
    expect(CUSTOMER_KIND_FILTERS).toEqual(["company", "agency"]);
  });

  it("reads a known kind, and treats anything else as every customer", () => {
    expect(customerKindFilter("company")).toBe("company");
    expect(customerKindFilter("agency")).toBe("agency");
    for (const v of [undefined, "", "agent", "employer", "Agency", "all", "toString", "constructor"]) {
      expect(customerKindFilter(v), String(v)).toBeUndefined();
    }
  });
});

/**
 * HAND-BUILT CUSTOMER ADDRESSES ARE FENCED. Every customer cell used to spell
 * `/companies/${payer_id}` itself, which is how an agency came to cost a redirect hop on four
 * screens at once. Read from the AST of every shipped source: a string, or a template's text,
 * that ends in a customer section's path prefix (`/companies/`, `/agencies/`) is an address
 * being built by hand, whatever follows it — a `${…}` hole or a `+ id`. The section lists and
 * their own rows (`href="/companies"`, `${basePath}/${p.id}`) end in no such prefix and pass.
 */
const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
// A UI address, never the admin API's `/admin/companies/…` path (the `/admin` prefix is not a
// customer address and must stay outside this fence).
const SECTION_PREFIX = /(?<!\/admin)\/(companies|agencies)\/$/;

function handBuiltCustomerHrefs(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node)) &&
      SECTION_PREFIX.test(node.text)
    ) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      out.push(`${line + 1}: ${node.parent.getText(sf)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function shippedSources(): Map<string, string> {
  const out = new Map<string, string>();
  (function walk(dir: string): void {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(ent.name) && !/\.(test|spec)\.(ts|tsx)$/.test(ent.name))
        out.set(relative(srcRoot, full).replace(/\\/g, "/"), readFileSync(full, "utf8"));
    }
  })(srcRoot);
  return out;
}

describe("customer address fence — the reader", () => {
  const found = (src: string) => handBuiltCustomerHrefs("t.tsx", src).length;

  it("catches a customer address built by hand, however it is spelled", () => {
    expect(found("<Link href={`/companies/${row.payer_id}`}>x</Link>")).toBe(1);
    expect(found("const h = `/agencies/${id}/timeline`;")).toBe(1);
    expect(found('const h = "/companies/" + id;')).toBe(1);
    expect(found("const h = '/agencies/' + id;")).toBe(1);
    expect(found("const h = `${origin}/companies/${id}`;")).toBe(1);
  });

  it("passes the section lists, a section's own rows, the helper's call, and comments", () => {
    expect(found('<Link href="/companies">Companies</Link>')).toBe(0);
    expect(found('<Pager basePath="/agencies" />')).toBe(0);
    expect(found("<Link href={`${basePath}/${p.id}`}>x</Link>")).toBe(0);
    expect(found("<Link href={customerHref(row.payer_id)}>x</Link>")).toBe(0);
    expect(found("// `/companies/${row.payer_id}` used to be spelled here\nconst x = 1;")).toBe(0);
  });
});

describe("customer address fence — the console", () => {
  const SOURCES = shippedSources();

  it("walks the shipped sources", () => {
    expect(SOURCES.size).toBeGreaterThan(50);
    expect(SOURCES.has("lib/customer.ts")).toBe(true);
  });

  it("no shipped file builds /companies/… or /agencies/… by hand — customerHref does", () => {
    const offenders = [...SOURCES].flatMap(([file, src]) =>
      handBuiltCustomerHrefs(file, src).map((hit) => `${file}:${hit}`),
    );
    expect(offenders).toEqual([]);
  });
});
