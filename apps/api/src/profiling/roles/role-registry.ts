/**
 * EVERY ROLE THE PLATFORM CAN PROFILE, and the derivations the rest of the codebase reads.
 *
 * ADDING A ROLE IS A FILE AND A LINE. Import the descriptor, put it in the array, and the form
 * kind, the routing row, the handover copy, the pack→kind mapping and the fresher vocabulary all
 * follow. Nothing else is authored, which is the property the eleven scattered tables did not
 * have and the reason twenty more roles are tractable at all.
 *
 * ORDER IS NOT SIGNIFICANT and must not become so. `routeToTradeForm` returns the first route
 * whose evidence matches, so an ordering that mattered would mean two roles could claim one
 * worker and the winner was whoever was imported first. That is what the conflict veto exists to
 * prevent: genuinely ambiguous evidence must reach NO form, not the alphabetically luckier one.
 * `role-registry.test.ts` asserts no two enabled roles share an occupation term, which is the
 * property that makes order irrelevant rather than merely unimportant.
 */
import {
  assertEventSpineCanNameEveryRole,
  assertRegistryIsCoherent,
  conflictTermsFor,
  nonEmptyTuple,
  type RoleFormDescriptor,
} from "./role-form-descriptor";

import { CAD_DRAUGHTSMAN } from "./cad-draughtsman.role";
import { CAM_PROGRAMMER } from "./cam-programmer.role";
import { CNC_GRINDING } from "./cnc-grinding.role";
import { CNC_MACHINING_CENTRE } from "./cnc-machining-centre.role";
import { CNC_TURNER } from "./cnc-turner.role";

/**
 * DECLARED ROLES — including the ones whose forms do not exist yet.
 *
 * A DISABLED ROLE IS NOT A PLACEHOLDER, it is load-bearing vocabulary. Conflict terms are derived
 * from a role's cluster siblings, so CNC Turner's veto on "vmc", "milling" and "grinding" is
 * produced by the machining-centre and grinding descriptors being here. Enabling a form is then a
 * boolean on one line instead of an edit to every other role's conflict list — which is the
 * difference between twenty additive changes and four hundred and twenty ordered pairs.
 */
const DECLARED = [
  CNC_TURNER,
  CNC_MACHINING_CENTRE,
  CNC_GRINDING,
  CAM_PROGRAMMER,
  CAD_DRAUGHTSMAN,
] as const;

/**
 * The registry as CONSUMERS see it — one uniform interface, not a union of four literal shapes.
 *
 * TWO VIEWS OF ONE ARRAY, and the split is load-bearing rather than cosmetic. `DECLARED` keeps its
 * `as const` literal types so `TradeFormKind` can be derived from them; but a union of four object
 * literals has no `fresher` property unless EVERY member declares one, so a caller asking "does
 * this role have a fresher vocabulary" would not type-check against it. Widening here restores the
 * optional field that the interface always had, and costs nothing: the literal information is
 * still available below, where it is the only place it is needed.
 */
export const ROLE_FORM_DESCRIPTORS: readonly RoleFormDescriptor[] = DECLARED;

assertRegistryIsCoherent(ROLE_FORM_DESCRIPTORS);
// AT MODULE LOAD, like the coherence check above and for the same reason: the failure it replaces
// is a funnel that goes quietly to zero for the newest trade, reported by one log line that both
// emitters write on their way to swallowing the error. Failing at boot is the cheap version of
// finding out.
assertEventSpineCanNameEveryRole(ROLE_FORM_DESCRIPTORS);

/**
 * A role whose form actually ships — narrowed by the LITERAL `formEnabled: true`.
 *
 * THE TYPE AND THE RUNTIME FILTER AGREE BY CONSTRUCTION, which is the whole reason the descriptors
 * are written `as const satisfies` rather than with a type annotation. An annotation would widen
 * `formEnabled` to `boolean` and `kind` to `string`, and `TradeFormKind` would have to be either
 * hand-maintained (the thing this file exists to stop) or widened to every declared role —
 * letting `z.enum` accept a kind with no pack behind it and turning an authoring slip into a
 * runtime 503 for whichever worker's session happened to carry it.
 */
type EnabledDeclaration = Extract<(typeof DECLARED)[number], { formEnabled: true }>;

/** The closed set of form kinds, in the type system. Exactly the roles that can be routed to. */
export type TradeFormKind = EnabledDeclaration["kind"];

/**
 * The roles whose forms actually exist. Everything routable is derived from this.
 *
 * Widened to the interface like {@link ROLE_FORM_DESCRIPTORS}, but with `kind` held at the closed
 * union — so a caller can read every optional field AND hand `kind` straight to something that
 * wants a `TradeFormKind` without a cast that nobody would ever re-check.
 */
export const ENABLED_ROLE_DESCRIPTORS: readonly (RoleFormDescriptor & {
  readonly kind: TradeFormKind;
})[] = DECLARED.filter((descriptor): descriptor is EnabledDeclaration => descriptor.formEnabled);

/**
 * The closed set of form kinds — what `chat.dto.ts` and `trade-form.dto.ts` validate against.
 *
 * ONLY ENABLED KINDS. A kind in this enum with no pack behind it is a 503 waiting for the first
 * worker whose session happens to carry it.
 */
export const TRADE_FORM_KINDS = nonEmptyTuple(
  ENABLED_ROLE_DESCRIPTORS.map((descriptor) => descriptor.kind),
  "TRADE_FORM_KINDS",
);

/** The conflict terms each enabled role vetoes on, computed once at load rather than per turn. */
const CONFLICT_TERMS: ReadonlyMap<string, readonly string[]> = new Map(
  ENABLED_ROLE_DESCRIPTORS.map((descriptor) => [
    descriptor.kind,
    conflictTermsFor(descriptor, ROLE_FORM_DESCRIPTORS),
  ]),
);

export function conflictTermsForKind(kind: TradeFormKind): readonly string[] {
  return CONFLICT_TERMS.get(kind) ?? [];
}

export function descriptorForKind(kind: string): RoleFormDescriptor | undefined {
  return ROLE_FORM_DESCRIPTORS.find((descriptor) => descriptor.kind === kind);
}

export function descriptorForPack(
  packId: string | null | undefined,
): RoleFormDescriptor | undefined {
  return packId
    ? ROLE_FORM_DESCRIPTORS.find((descriptor) => descriptor.packId === packId)
    : undefined;
}
