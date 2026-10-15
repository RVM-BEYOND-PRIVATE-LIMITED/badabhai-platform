import { Injectable, Logger } from "@nestjs/common";

import { FREE_CHAT_RESUME_FACTS_MAX, type CompanionEditSnapshotRow } from "@badabhai/ai-contracts";
import type { WorkerProfile } from "@badabhai/db";

// VALUE import, not `import type`: a constructor parameter, resolved from `design:paramtypes`.
import { CompanionEditService } from "./companion-edit.service";
import { snapshotRows, trimSnapshot, type EditState } from "./edit-snapshot";

/**
 * #2304 (owner rulings 2026-10-15) — WHAT THE WORKER'S RÉSUMÉ SAYS, for the Bada Bhai chat's reply.
 *
 * "meri salary kitni hai?" is answered from the résumé or the earlier conversation, never guessed,
 * so the companion's casual and career replies read the résumé's current values. They come from
 * the EDIT PATH'S OWN VIEW (`CompanionEditService.readState` → `snapshotRows`): the same sections
 * the edit menu edits, read the same way, so the chat never describes a résumé the edit path would
 * not recognise. The opaque refs ride along (the contract's row shape); nothing here is a DB id.
 *
 * THE SALARY BAND, WHOLE. The edit snapshot carries the band's upper end only (`expected_salary`,
 * the figure an edit changes); the résumé prints the band, so its lower end and period are added
 * to the preferences row here. When the (readable) preferences hold no band, the confirmed
 * draft's band is the one the résumé prints for the chat road, and it is added instead.
 *
 * FAIL SOFT. A failed read (any section, or the whole state) costs the reply its résumé facts,
 * never the reply: `factsFor` returns null and the reply runs exactly as before #2304.
 */
export function resumeFactsOf(state: EditState, text: string): CompanionEditSnapshotRow[] {
  const rows: CompanionEditSnapshotRow[] = snapshotRows(state).map((row) => ({
    ref: row.ref,
    section: row.section,
    fields: row.ref === "pref" ? withSalaryBand(row.fields, state) : { ...row.fields },
  }));
  // An UNREADABLE preferences section has no `pref` row, so no band at all: which band the résumé
  // prints is then unknown, and the draft's may be the wrong one (fail closed, as `sectionReadable`).
  const said = rows.filter((row) => Object.values(row.fields).some((value) => value !== null));
  return trimSnapshot(
    said.map((row) => ({ ...row, target: null })),
    text,
    FREE_CHAT_RESUME_FACTS_MAX,
  ).map(({ ref, section, fields }) => ({ ref, section, fields }));
}

/** The preferences row with the band's lower end and period beside its upper end. */
function withSalaryBand(
  fields: Readonly<Record<string, string | null>>,
  state: EditState,
): Record<string, string | null> {
  const values = state.preferences?.values;
  const own: Record<string, string | null> = {
    ...fields,
    expected_salary_min:
      values?.salary_expected_min == null ? null : String(values.salary_expected_min),
    salary_period: values?.salary_period ?? null,
  };
  if (own.expected_salary !== null || own.expected_salary_min !== null) return own;
  // No band among the preferences: the chat road's résumé prints the draft's.
  return { ...own, ...(draftBandOf(state) ?? {}) };
}

/** The confirmed draft's salary band, as the chat road's résumé prints it; null when it has none. */
function draftBandOf(state: EditState): Record<string, string | null> | null {
  const band = state.draft?.salary_expectation;
  if (band === undefined || (band.amount_min === null && band.amount_max === null)) return null;
  return {
    expected_salary_min: band.amount_min === null ? null : String(band.amount_min),
    expected_salary: band.amount_max === null ? null : String(band.amount_max),
    salary_period: band.period,
  };
}

/** The résumé facts one companion reply reads (see {@link resumeFactsOf}); null when unreadable. */
@Injectable()
export class CompanionResumeFacts {
  private readonly logger = new Logger(CompanionResumeFacts.name);

  constructor(private readonly edits: CompanionEditService) {}

  async factsFor(
    workerId: string,
    profile: WorkerProfile,
    text: string,
  ): Promise<CompanionEditSnapshotRow[] | null> {
    try {
      const facts = resumeFactsOf(await this.edits.readState(workerId, profile), text);
      return facts.length > 0 ? facts : null;
    } catch (err) {
      // Ids and the error's class only: never a value, which is the worker's own data.
      this.logger.warn(
        `companion résumé facts unreadable for worker ${workerId}; the reply runs without them (${
          err instanceof Error ? err.name : "UnknownError"
        })`,
      );
      return null;
    }
  }
}
