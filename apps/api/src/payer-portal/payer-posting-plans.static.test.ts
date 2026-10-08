import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * ADR-0053 (PAY-DB-01) P2c — who may call the scope-taking purchases (review of PR #2174, L-2).
 *
 * `PostingPlansService.{buyPlanInScope, buyBoostInScope, topUpQuotaInScope}` take a scope and
 * TRUST it: they check no posting ownership. On the payer surface that check is
 * `PayerPostingPlansService.forOwnedPosting`, which resolves once, checks ownership in that scope
 * and only then hands the scope to these methods. A second caller — a controller, another
 * service — could pair some other scope with some other posting and buy past the check.
 *
 * So the callers are pinned, by enclosing method: the payer seam's `forOwnedPosting`, and
 * `PostingPlansService`'s own ops wrappers `buyPlan` / `buyBoost` (InternalServiceGuard; the ops
 * route has never checked ownership, and resolves its body `payer_id` itself). A new caller
 * fails here and needs a reviewer's look. Parsed with the TypeScript compiler (syntax only).
 */

const SRC = join(__dirname, "..");
const IN_SCOPE_PURCHASES = new Set(["buyPlanInScope", "buyBoostInScope", "topUpQuotaInScope"]);

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")
      ? [full]
      : [];
  });
}

const rel = (file: string): string => relative(SRC, file).replace(/\\/g, "/");

/**
 * The enclosing `Class.member` of `node` (a method, or a class field such as an arrow property),
 * else the enclosing top-level function / const. A local variable inside a method does not
 * rename the caller: the method is what a reviewer reads.
 */
function enclosingName(node: ts.Node): string {
  let member: string | null = null;
  let topLevel: string | null = null;
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if (
      member === null &&
      (ts.isMethodDeclaration(at) || ts.isPropertyDeclaration(at)) &&
      ts.isIdentifier(at.name)
    ) {
      member = at.name.text;
    }
    if (
      topLevel === null &&
      (ts.isFunctionDeclaration(at) || ts.isVariableDeclaration(at)) &&
      at.name !== undefined &&
      ts.isIdentifier(at.name)
    ) {
      topLevel = at.name.text;
    }
    if (ts.isClassDeclaration(at)) return `${at.name?.text ?? "<anonymous>"}.${member ?? "<field>"}`;
  }
  return topLevel ?? "<top level>";
}

/** `path Class.method -> purchase` for every call (or reference) to an `*InScope` purchase. */
function inScopeCallers(sources: readonly ts.SourceFile[]): string[] {
  const out: string[] = [];
  for (const sf of sources) {
    const visit = (node: ts.Node): void => {
      // Any property access of the name counts — a call, a `.bind`, a destructure-by-access.
      if (ts.isPropertyAccessExpression(node) && IN_SCOPE_PURCHASES.has(node.name.text)) {
        out.push(`${rel(sf.fileName)} ${enclosingName(node)} -> ${node.name.text}`);
      }
      // Destructuring (`const { buyPlanInScope } = plans`) and element access by literal.
      if (
        ts.isBindingElement(node) &&
        IN_SCOPE_PURCHASES.has((node.propertyName ?? node.name).getText(sf))
      ) {
        out.push(`${rel(sf.fileName)} ${enclosingName(node)} -> destructured`);
      }
      if (
        ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        IN_SCOPE_PURCHASES.has(node.argumentExpression.text)
      ) {
        out.push(`${rel(sf.fileName)} ${enclosingName(node)} -> ${node.argumentExpression.text}`);
      }
      node.forEachChild(visit);
    };
    visit(sf);
  }
  return out.sort();
}

const parsed = (file: string, text = readFileSync(file, "utf8")): ts.SourceFile =>
  ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

describe("PostingPlansService.*InScope purchases — only the ownership-checking seam and the ops wrappers call them", () => {
  it("the callers are exactly PayerPostingPlansService.forOwnedPosting and PostingPlansService.buyPlan / buyBoost", () => {
    expect(inScopeCallers(tsFiles(SRC).map((f) => parsed(f)))).toEqual([
      "payer-portal/payer-posting-plans.service.ts PayerPostingPlansService.forOwnedPosting -> buyBoostInScope",
      "payer-portal/payer-posting-plans.service.ts PayerPostingPlansService.forOwnedPosting -> buyPlanInScope",
      "payer-portal/payer-posting-plans.service.ts PayerPostingPlansService.forOwnedPosting -> topUpQuotaInScope",
      "posting-plans/posting-plans.service.ts PostingPlansService.buyBoost -> buyBoostInScope",
      "posting-plans/posting-plans.service.ts PostingPlansService.buyPlan -> buyPlanInScope",
    ]);
  });

  it("the screen is not vacuous: a call, a bound reference, a destructure and an element access all count", () => {
    const found = inScopeCallers([
      parsed(
        join(SRC, "fx/caller.controller.ts"),
        `export class FxController {
          buy(id, scope) { return this.plans.buyPlanInScope(id, scope, {}, {}); }
          bound = this.plans.topUpQuotaInScope.bind(this.plans);
          grab() { const { buyBoostInScope } = this.plans; return buyBoostInScope; }
          byName() { return this.plans["buyPlanInScope"]; }
          other() { return this.plans.buyPlan("id", {}, {}); }
        }`,
      ),
    ]);
    expect(found).toEqual([
      "fx/caller.controller.ts FxController.bound -> topUpQuotaInScope",
      "fx/caller.controller.ts FxController.buy -> buyPlanInScope",
      "fx/caller.controller.ts FxController.byName -> buyPlanInScope",
      "fx/caller.controller.ts FxController.grab -> destructured",
    ]);
  });
});
