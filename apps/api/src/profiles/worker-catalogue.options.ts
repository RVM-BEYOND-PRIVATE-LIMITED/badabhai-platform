import { MACHINES, SKILLS } from "@badabhai/taxonomy";
import { MAX_CORRECTION_MACHINES, MAX_CORRECTION_SKILLS } from "./extracted-corrections.contract";

/**
 * The worker-facing CORRECTION CATALOGUES (#1596) — canonical ids + display labels, read from
 * `@badabhai/taxonomy`, the SAME source `extracted-corrections.dto.ts` validates
 * `skill_ids`/`machine_ids` against.
 *
 * WHY THIS EXISTS. `POST /profile/corrections` has accepted canonical `skill_*`/`mach_*` ids
 * since #1593, but no worker-facing read served the id↔label mapping: the labels the client can
 * read (`GET /workers/me/profile-summary`, kit checklists) carry NO ids, and the contract
 * rejects anything that is not a canonical id. A picker built on those labels would mint invalid
 * ids and every correction write would 400 — which is why the client affordance was left unwired
 * rather than built on a guess. This is the missing read.
 *
 * PURE AND STATIC. No worker data, no values, no counts, no PII — vocabulary only, mirroring
 * `me/qualifications/options` and `me/work-preferences/options`. The order is the taxonomy's own,
 * so the picker is stable across sessions and deploys.
 *
 * THE CAPS ARE DOCUMENTED HERE, ENFORCED AT THE WRITE. `MAX_CORRECTION_SKILLS` (50) and
 * `MAX_CORRECTION_MACHINES` (32) are the correction contract's ceilings; this read serves the
 * whole catalogue (single digits today) and lets a worker pick up to the caps. The parity test
 * pins the catalogue under the caps, so a taxonomy that outgrows them fails loudly instead of
 * shipping a tail no picker can submit.
 */

/** One closed-vocabulary option: the canonical id plus the label a worker reads. */
export interface CatalogueOption {
  readonly id: string;
  readonly label: string;
}

/** Canonical `skill_*` ids + labels, in taxonomy order. */
export function skillOptions(): CatalogueOption[] {
  return SKILLS.map((node) => ({ id: node.id, label: node.name }));
}

/** Canonical `mach_*` ids + labels, in taxonomy order. */
export function machineOptions(): CatalogueOption[] {
  return MACHINES.map((node) => ({ id: node.id, label: node.name }));
}

/** Re-exported so the controller test can pin the caps without reaching into the contract. */
export { MAX_CORRECTION_MACHINES, MAX_CORRECTION_SKILLS };
