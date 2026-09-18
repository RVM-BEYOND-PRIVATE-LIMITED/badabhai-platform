import { Injectable } from "@nestjs/common";
import { ROLES } from "@badabhai/taxonomy";

import { OCCUPATIONS_MAX } from "./worker-occupations.dto";
import { WorkerOccupationsRepository } from "./worker-occupations.repository";
import { WorkerQualificationsRepository } from "./worker-qualifications.repository";

/**
 * CHAT → NORMALIZED-TABLE WRITE LEG (Layer A elicitation, qp_universal@4).
 *
 * WHY THIS EXISTS. `languages`/`work_types` land in `worker_attributes` through the projector, but
 * training and secondary occupations have DEDICATED tables with their own pages, validators and
 * résumé readers. Writing their chat answers into `worker_attributes` would create a second store
 * for one fact, and the qualifications/occupations pages would never see it — the exact class of
 * divergence the `languages` carve-out was created to avoid.
 *
 * WHAT IT DOES NOT DO. It never edits rows the page wrote. Both repository methods are
 * insert-only-when-empty: a worker with page rows is left untouched, and a chat answer is the
 * fallback store only. It writes no PII: a course name, a provider, a year, and closed taxonomy
 * role ids — the same fields the pages own.
 *
 * PURE EXTRACTION, IMPURE WRITES. The two `*FromChatAttributes` functions are pure so their rules
 * are directly testable; the service is a two-call composition.
 */

/** The projector's attribute shape, narrowed to what this file reads. */
export interface ChatAttribute {
  readonly attributeKey: string;
  readonly value: boolean | number | string | readonly string[];
}

const TRAINING_NAME_MAX = 120;
const TRAINING_PROVIDER_MAX = 120;
const YEAR_MIN = 1950;
const YEAR_MAX = 2100;

function stringValue(attributes: readonly ChatAttribute[], key: string): string | null {
  const attribute = attributes.find((candidate) => candidate.attributeKey === key);
  if (!attribute || typeof attribute.value !== "string") return null;
  const trimmed = attribute.value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * ONE training row from the three chat attributes, or null when the name was never answered.
 *
 * THE NAME IS THE ROW. A year without a course is not a credential, so the name gates the whole
 * entry; provider and year are optional in the table and stay optional here. A decline on the
 * name (`training_name` never reaching `answered`) therefore writes nothing, which is the
 * declined-terminal rule applied to a table write.
 */
export function trainingEntryFromChatAttributes(
  attributes: readonly ChatAttribute[],
): { name: string; provider: string | null; year: number | null } | null {
  const name = stringValue(attributes, "training_name");
  if (name === null) return null;
  const rawProvider = stringValue(attributes, "training_provider");
  const yearAttribute = attributes.find((candidate) => candidate.attributeKey === "training_year");
  const rawYear =
    yearAttribute && typeof yearAttribute.value === "number" ? yearAttribute.value : null;
  return {
    name: name.slice(0, TRAINING_NAME_MAX),
    provider: rawProvider === null ? null : rawProvider.slice(0, TRAINING_PROVIDER_MAX),
    // The DB CHECK owns this bound too (`wt_year_chk`); refusing here keeps a bad answer askable
    // instead of failing the extraction on the insert.
    year:
      rawYear !== null && Number.isInteger(rawYear) && rawYear >= YEAR_MIN && rawYear <= YEAR_MAX
        ? rawYear
        : null,
  };
}

const ROLE_IDS: ReadonlySet<string> = new Set(ROLES.map((role) => role.id));

/**
 * The closed `role_*` ids the worker tapped or said, in the order given, deduped and capped.
 *
 * AN UNKNOWN ID IS DROPPED, never stored: `worker_occupation.role_id` is validated against the
 * same taxonomy on the page's DTO, and a value the id space does not know would make the pages'
 * unedited save a 400.
 */
export function roleIdsFromChatAttributes(attributes: readonly ChatAttribute[]): string[] {
  const attribute = attributes.find(
    (candidate) => candidate.attributeKey === "secondary_occupations",
  );
  if (!attribute) return [];
  const values = Array.isArray(attribute.value) ? attribute.value : [attribute.value];
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || !ROLE_IDS.has(value) || out.includes(value)) continue;
    out.push(value);
    if (out.length === OCCUPATIONS_MAX) break;
  }
  return out;
}

@Injectable()
export class ChatTableWritesService {
  constructor(
    private readonly qualifications: WorkerQualificationsRepository,
    private readonly occupations: WorkerOccupationsRepository,
  ) {}

  /**
   * Land the chat's training/occupation answers in their tables, if they are still empty.
   *
   * Called by the extraction processor immediately after `worker_attributes` are upserted, in the
   * same "allowed to throw, idempotent on retry" envelope: the repositories are insert-if-empty,
   * so a redelivery converges rather than duplicating.
   */
  async applyFromChatAttributes(
    workerId: string,
    attributes: readonly ChatAttribute[],
  ): Promise<{ trainingWritten: boolean; occupationsWritten: number }> {
    const training = trainingEntryFromChatAttributes(attributes);
    const trainingWritten =
      training === null ? false : await this.qualifications.appendTrainingIfEmpty(workerId, training);

    const roleIds = roleIdsFromChatAttributes(attributes);
    const occupationsWritten =
      roleIds.length === 0 ? 0 : await this.occupations.appendIfEmpty(workerId, roleIds);

    return { trainingWritten, occupationsWritten };
  }
}
