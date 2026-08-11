/**
 * Build-time validation of an authored `ask_if` / `skip_if`, against the ONE definition of what a
 * predicate is.
 *
 * WHAT THIS FILE USED TO BE, AND WHY THAT WAS THE BUG (#776). It carried a second, complete
 * predicate implementation — its own `PREDICATE_OPS`, its own arity table, its own operand rules
 * and its own `evaluatePredicate` — built around an `{ op, args: [...] }` AST. The engine that
 * actually runs a live interview (`apps/api/src/profiling/predicate.ts`) reads the CONTRACT's
 * shape, `{ op, field }` / `{ op, left, right }`, and `packages/ai-contracts` is the frozen
 * definition both are supposed to agree with.
 *
 * They did not. Every authored predicate in the corpus was written in the `args` shape the
 * validator taught, and every one of them evaluated to `false` at runtime because
 * `predicate.field` was `undefined`. An `ask_if` that is permanently false means the question is
 * NEVER ASKED; a `skip_if` that is permanently false means the skip NEVER FIRES. Two live
 * questions in `qp_welding` behaved that way for the life of the pack.
 *
 * BOTH SIDES WERE THOROUGHLY UNIT-TESTED, which is exactly why nothing caught it: each suite
 * exercised its own AST and passed. A pack author read the shipped examples, copied `args`, and
 * the validator agreed with them. Two implementations of one rule cannot be kept in sync by
 * testing them separately — so there is now only one.
 *
 * THE FIX IS THE DELETION. This module no longer defines what a predicate is; it asks
 * `PredicateSchema` — the same schema `QuestionPackItemSchema.ask_if` is typed by and the runtime
 * engine's shape is derived from. What remains here is the part the contract cannot express: that
 * a field named by a predicate is a `question_key` in the SAME pack.
 */

import { PredicateSchema, type Predicate, type PredicateOperand } from "@badabhai/ai-contracts";

/**
 * How deep an authored condition may nest.
 *
 * NOT a contract rule — the schema is happily recursive — but an AUTHORING one. A human reviewing
 * a pack has to be able to hold the condition in their head, and nothing in the shipped corpus is
 * deeper than one level. Rejecting at build time is free; discovering an unreadable predicate
 * while debugging a question that never appears is not.
 */
const MAX_DEPTH = 8;

/** The `field` an operand reads, or null when it is a literal. */
function operandField(operand: PredicateOperand | undefined): string | null {
  if (operand === undefined || operand === null || typeof operand !== "object") return null;
  const field = (operand as { field?: unknown }).field;
  return typeof field === "string" ? field : null;
}

/**
 * Every `question_key` a predicate reads, in the CONTRACT's shape.
 *
 * Three places carry a field: `field` (the `answered`/`declined` operand), and `left`/`right` (the
 * comparison operands). `in` needs no special case here — the contract models its right-hand side
 * as one operand carrying a `const` array, not as an array of operands, which is one of the
 * simplifications that came free with dropping the second AST.
 */
function walkFields(node: Predicate, visit: (field: string) => void, depth = 0): void {
  if (depth > MAX_DEPTH) return;
  if (typeof node.field === "string") visit(node.field);
  for (const operand of [node.left, node.right]) {
    const field = operandField(operand);
    if (field !== null) visit(field);
  }
  if (node.predicate) walkFields(node.predicate, visit, depth + 1);
  for (const child of node.predicates ?? []) walkFields(child, visit, depth + 1);
}

/** How deep an already-parsed predicate actually nests. */
function depthOf(node: Predicate, depth = 0): number {
  if (depth > MAX_DEPTH) return depth;
  let deepest = depth;
  const children = [...(node.predicates ?? []), ...(node.predicate ? [node.predicate] : [])];
  for (const child of children) deepest = Math.max(deepest, depthOf(child, depth + 1));
  return deepest;
}

/**
 * Problems with one authored condition — empty when it is sound.
 *
 * EXHAUSTIVE AND LOUD, unlike the runtime, and the asymmetry is deliberate: here a malformed
 * condition is a build error a human fixes, whereas a live interview must not crash over a config
 * row. The runtime's silence is only safe if this is noisy.
 *
 * `knownFields` is the set of `question_key`s in the SAME pack. A condition naming a key from
 * another pack is the single most likely authoring mistake and the hardest to see: it evaluates
 * false forever, so the gated question simply never appears and nobody notices — the same class of
 * silence #776 was.
 */
export function validatePredicate(
  node: unknown,
  knownFields: ReadonlySet<string>,
  where: string,
): string[] {
  // THE CONTRACT DECIDES THE SHAPE. Op set, per-op arity, operand form and the
  // exactly-one-of-{field,const} rule are all enforced here, by the same schema the engine's AST
  // is derived from — so a corpus this accepts cannot be a corpus the engine reads differently.
  const parsed = PredicateSchema.safeParse(node);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? `.${issue.path.join(".")}` : "";
      return `${where}${path}: ${issue.message}`;
    });
  }

  const predicate = parsed.data as Predicate;
  const problems: string[] = [];
  if (depthOf(predicate) > MAX_DEPTH) {
    problems.push(`${where}: predicate nested deeper than ${MAX_DEPTH} levels`);
  }

  // The one rule the contract cannot express: a field has to exist IN THIS PACK. The schema knows
  // a valid slug when it sees one; it has no idea which questions this pack authored.
  walkFields(predicate, (field) => {
    if (!knownFields.has(field)) {
      problems.push(
        `${where}: field ${JSON.stringify(field)} is not a question_key in this pack. ` +
          `A dangling field is false forever, so the gated question would silently never appear.`,
      );
    }
  });
  return problems;
}

/**
 * Every `question_key` a predicate reads. Used by the validator's dependency checks.
 *
 * Tolerant of an unparseable node ON PURPOSE: this feeds ordering/dependency analysis, which runs
 * alongside {@link validatePredicate} rather than after it, and a malformed condition should be
 * reported by that function as a shape error — not by this one as a phantom missing dependency.
 */
export function predicateFields(node: unknown, out: Set<string> = new Set()): Set<string> {
  const parsed = PredicateSchema.safeParse(node);
  if (!parsed.success) return out;
  walkFields(parsed.data as Predicate, (field) => out.add(field));
  return out;
}
