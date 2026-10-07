import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { WORKER_FEEDBACK_CATEGORIES } from "@badabhai/types";
import {
  AI_CALL_OUTCOMES,
  EVENT_FILTER_MAX_LENGTH,
  LEDGER_REASONS,
  ORDER_STATUSES,
  PAYER_STATUSES,
} from "./list-filter-values";
import { ADMIN_ROLES } from "./auth/capabilities";
import { AI_TASK_TYPES } from "./ai-cost";
import { adminRowSchema } from "./entities";
import { FEEDBACK_CATEGORIES } from "./feedback";

/**
 * THE FILTER VALUES A LIST TRUSTS, PINNED TO THE API (approval review of #2095).
 *
 * A list page decides whether a 400 refused a FILTER or the page cursor by asking whether each
 * filter value is one the API accepts (`lib/read-refusal.ts`). Where a shared package admin-web
 * already depends on exports those values, the page imports them (`@badabhai/types`: worker,
 * posting and verification statuses, the feedback tags). Where none does, admin-web keeps a copy
 * — and this file reads the API's own query DTO SOURCE (and, for the AI task types, the event
 * schema the DTO takes them from) and fails the day the two drift: a value the API gained would
 * otherwise read as "the server rejected that filter".
 *
 * Read as source, with the TypeScript AST, because admin-web takes no dependency on apps/api or
 * on @badabhai/event-schema. CAVEAT: turbo keys this package's test cache on this package's own
 * files, so a DTO-only change can reuse a cached pass in CI until anything here changes; a local
 * or uncached run always reads the current DTOs.
 */
const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const DTO = join(repo, "apps", "api", "src", "admin");
const parse = (path: string) =>
  ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);

/** The initializer of the variable `name` declared anywhere in `sf`. */
function declaration(sf: ts.SourceFile, name: string): ts.Node {
  let found: ts.Node | undefined;
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) {
      found = n.initializer;
    } else ts.forEachChild(n, visit);
  };
  visit(sf);
  expect(found, `${name} in ${sf.fileName}`).toBeDefined();
  return found!;
}

/** The first property `name: …` inside `node`. */
function property(node: ts.Node, name: string): ts.Node {
  let found: ts.Node | undefined;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === name) {
      found = n.initializer;
    } else ts.forEachChild(n, visit);
  };
  visit(node);
  expect(found, `property ${name}`).toBeDefined();
  return found!;
}

/** The string literals of the first `z.enum([...])` inside `node`, sorted. */
function enumValues(node: ts.Node): string[] {
  let found: string[] | undefined;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "enum" &&
      n.arguments[0] !== undefined &&
      ts.isArrayLiteralExpression(n.arguments[0])
    ) {
      found = n.arguments[0].elements.filter(ts.isStringLiteral).map((e) => e.text);
    } else ts.forEachChild(n, visit);
  };
  visit(node);
  expect(found, "a z.enum([...])").toBeDefined();
  return [...found!].sort();
}

/** The argument of the first `.max(n)` inside `node`. */
function maxOf(node: ts.Node): number {
  let found: number | undefined;
  const visit = (n: ts.Node) => {
    if (found !== undefined) return;
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "max" &&
      n.arguments[0] !== undefined &&
      ts.isNumericLiteral(n.arguments[0])
    ) {
      // The innermost call is the first in source order: visit the callee chain first.
      ts.forEachChild(n.expression, visit);
      if (found === undefined) found = Number(n.arguments[0].text);
    } else ts.forEachChild(n, visit);
  };
  visit(node);
  expect(found, "a .max(n)").toBeDefined();
  return found!;
}

const sorted = (values: readonly string[]) => [...values].sort();

describe("filter values taken from a shared package", () => {
  it("the feedback tags ARE @badabhai/types' WORKER_FEEDBACK_CATEGORIES — not a copy", () => {
    expect(FEEDBACK_CATEGORIES).toBe(WORKER_FEEDBACK_CATEGORIES);
  });
});

describe("filter values admin-web keeps a copy of, pinned to the API's query DTOs", () => {
  it("customer statuses — AdminPayersQuerySchema.status", () => {
    const dto = parse(join(DTO, "admin-entities.dto.ts"));
    expect(sorted(PAYER_STATUSES)).toEqual(
      enumValues(property(declaration(dto, "AdminPayersQuerySchema"), "status")),
    );
  });

  it("ledger reasons and order statuses — AdminLedgerQuerySchema.reason, AdminOrdersQuerySchema.status", () => {
    const dto = parse(join(DTO, "admin-finance.dto.ts"));
    expect(sorted(LEDGER_REASONS)).toEqual(
      enumValues(property(declaration(dto, "AdminLedgerQuerySchema"), "reason")),
    );
    expect(sorted(ORDER_STATUSES)).toEqual(
      enumValues(property(declaration(dto, "AdminOrdersQuerySchema"), "status")),
    );
  });

  it("admin roles and statuses — AdminDirectoryQuerySchema", () => {
    const dto = declaration(
      parse(join(DTO, "admin-directory.dto.ts")),
      "AdminDirectoryQuerySchema",
    );
    expect(sorted(ADMIN_ROLES)).toEqual(enumValues(property(dto, "role")));
    expect(sorted(adminRowSchema.shape.status.options)).toEqual(
      enumValues(property(dto, "status")),
    );
  });

  it("AI call outcomes — AdminAiTracesQuerySchema.success, as the address carries it", () => {
    const dto = parse(join(DTO, "admin-ai-traces.dto.ts"));
    expect(sorted(AI_CALL_OUTCOMES)).toEqual(
      enumValues(property(declaration(dto, "AdminAiTracesQuerySchema"), "success")),
    );
  });

  it("AI task types — every value of the event schema's aiTaskType, which the DTO takes as its enum", () => {
    // AdminAiTracesQuerySchema.taskType is `AiCostRecordedPayload.shape.task_type` — the
    // module-private `aiTaskType` of @badabhai/event-schema, so the source of truth is there.
    expect(readFileSync(join(DTO, "admin-ai-traces.dto.ts"), "utf8")).toContain(
      "AiCostRecordedPayload.shape.task_type",
    );
    const schema = parse(join(repo, "packages", "event-schema", "src", "payloads.ts"));
    expect(sorted(AI_TASK_TYPES)).toEqual(enumValues(declaration(schema, "aiTaskType")));
  });

  it("the events' free-text bounds — eventFilterShape and stringOrArray", () => {
    const dto = parse(join(DTO, "admin-events.dto.ts"));
    const shape = declaration(dto, "eventFilterShape");
    expect(EVENT_FILTER_MAX_LENGTH.actorType).toBe(maxOf(property(shape, "actorType")));
    expect(EVENT_FILTER_MAX_LENGTH.subjectType).toBe(maxOf(property(shape, "subjectType")));
    // `eventName` is `stringOrArray`: each name up to 128, at most 50 of them.
    expect(EVENT_FILTER_MAX_LENGTH.eventName).toBe(maxOf(declaration(dto, "stringOrArray")));
  });
});
