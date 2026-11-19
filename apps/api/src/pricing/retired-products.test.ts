import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { productKindSchema } from "@badabhai/pricing";
import {
  isProductKindOffSale,
  KINDS_SOLD_AFTER_RETIREMENT,
  retiredProductNotFound,
  retiredProductsOffSale,
} from "./retired-products";

/**
 * #2749 item 11 (ADR-0065) — the dropped products' switch, pinned.
 *
 *  - the rule: with `RETIRED_PRODUCTS_OFF_SALE` on, every catalogue kind but the credit pack is off
 *    sale; with it off, nothing is;
 *  - the switch has ONE reader (`retired-products.ts`), so the catalogue and the purchase routes
 *    cannot disagree about what is on sale;
 *  - every purchase `PostingPlansService` sells refuses FIRST, before any read: a new purchase
 *    method there must be added to {@link PURCHASE_METHODS}, which this test then checks.
 */

const ALL_KINDS = productKindSchema.options;

describe("isProductKindOffSale — the rule", () => {
  it("switch off (the default): every kind stays on sale", () => {
    for (const kind of ALL_KINDS) {
      expect(isProductKindOffSale({ RETIRED_PRODUCTS_OFF_SALE: false }, kind), kind).toBe(false);
    }
    expect(retiredProductsOffSale({ RETIRED_PRODUCTS_OFF_SALE: false })).toBe(false);
  });

  it("switch on: only the credit pack and Managed Hiring stay on sale; plans, boosts, capacity and top-ups go", () => {
    const sold = ALL_KINDS.filter(
      (kind) => !isProductKindOffSale({ RETIRED_PRODUCTS_OFF_SALE: true }, kind),
    );
    expect(sold).toEqual(["credit_pack", "managed_hiring"]);
    for (const kind of ["posting", "boost", "capacity", "quota_topup"] as const) {
      expect(isProductKindOffSale({ RETIRED_PRODUCTS_OFF_SALE: true }, kind), kind).toBe(true);
    }
  });

  it("is an ALLOW-list: only the credit pack and Managed Hiring survive, so a kind added later is off sale by default", () => {
    expect([...KINDS_SOLD_AFTER_RETIREMENT]).toEqual(["credit_pack", "managed_hiring"]);
  });

  it("the refusal is the bare 404 of a route that does not exist", () => {
    expect(retiredProductNotFound().getResponse()).toEqual({
      statusCode: 404,
      message: "Not Found",
    });
  });
});

const SRC = join(__dirname, "..");

function prodSources(dir: string = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return prodSources(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")
      ? [path]
      : [];
  });
}

/** Source without comments, so prose that names the switch is not a read. */
const codeOf = (path: string): string =>
  readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");

describe("RETIRED_PRODUCTS_OFF_SALE has one reader", () => {
  it("is named in apps/api/src only by retired-products.ts", () => {
    const readers = prodSources()
      .filter((path) => codeOf(path).includes("RETIRED_PRODUCTS_OFF_SALE"))
      .map((path) => relative(SRC, path).replace(/\\/g, "/"));
    // pricing.service.ts and posting-plans.service.ts hold the config but ask through the helper.
    expect(readers.filter((r) => !/\.service\.ts$/.test(r))).toEqual([
      "pricing/retired-products.ts",
    ]);
    for (const service of readers.filter((r) => /\.service\.ts$/.test(r))) {
      // A service may name the field only in its injected config's type, never read it.
      expect(codeOf(join(SRC, service)), service).not.toMatch(/\.RETIRED_PRODUCTS_OFF_SALE\b/);
    }
    // A whole-tree read: CI runs every suite at once, so this sweep gets its own generous timeout.
  }, 120_000);
});

/** Every purchase PostingPlansService sells, and the kind each refuses first. */
const PURCHASE_METHODS: Readonly<Record<string, string>> = {
  buyPlan: "posting",
  buyPlanInScope: "posting",
  buyBoost: "boost",
  buyBoostInScope: "boost",
  topUpQuotaInScope: "quota_topup",
  buyCapacity: "capacity",
};

describe("every PostingPlansService purchase refuses FIRST while the switch is on", () => {
  const file = join(SRC, "posting-plans", "posting-plans.service.ts");
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const methods = new Map<string, ts.MethodDeclaration>();
  source.forEachChild(function visit(node) {
    if (ts.isClassDeclaration(node) && node.name?.text === "PostingPlansService") {
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name)) {
          methods.set(member.name.text, member);
        }
      }
    }
  });

  it("finds the class (canary: guards the parse, not the rule)", () => {
    expect(methods.size).toBeGreaterThan(Object.keys(PURCHASE_METHODS).length);
  });

  it("every public buy* / topUp* method is listed here (a new purchase must be reviewed in)", () => {
    const purchases = [...methods.entries()]
      .filter(([name, m]) => {
        const isPrivate = m.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.PrivateKeyword);
        return !isPrivate && /^(buy|topUp)/.test(name);
      })
      .map(([name]) => name)
      .sort();
    expect(purchases).toEqual(Object.keys(PURCHASE_METHODS).sort());
  });

  it.each(Object.entries(PURCHASE_METHODS))(
    "%s's first statement is this.assertOnSale(%s)",
    (name, kind) => {
      const first = methods.get(name)?.body?.statements[0];
      expect(first, `${name} has no body`).toBeDefined();
      expect(first!.getText(source)).toBe(`this.assertOnSale("${kind}");`);
    },
  );

  it("the private resolve() — the one price path — also refuses (the backstop)", () => {
    const resolve = methods.get("resolve")?.body?.getText(source) ?? "";
    expect(resolve).toContain("this.assertOnSale(result.quote.kind);");
  });
});
