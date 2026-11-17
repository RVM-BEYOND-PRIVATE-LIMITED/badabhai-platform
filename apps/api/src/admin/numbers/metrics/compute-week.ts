import { activeWorkers30d } from "./active-workers";
import { UNKNOWN_DIMS, type NumbersDims, type NumbersMetricCells } from "./cells";
import { companiesPosted } from "./companies-posted";
import { completedProfiles } from "./completed-profiles";
import { confirmedHires } from "./confirmed-hires";
import { contactsPerHire } from "./contacts-per-hire";
import { formCompletedUnconfirmed } from "./form-completed-unconfirmed";
import { payingCompanies } from "./paying-companies";
import { revenueByPack } from "./revenue-by-pack";
import {
  weekWindow,
  type NumbersActivityRow,
  type NumbersCurrentProfileRow,
  type NumbersDimsLookup,
  type NumbersFirstPublicationRow,
  type NumbersFormCompletionRow,
  type NumbersHireRow,
  type NumbersOpenedContactRow,
  type NumbersPaidOrderRow,
  type NumbersWeekWindow,
} from "./types";

/**
 * The source reads one week's metrics need — implemented by `NumbersWeeklyRepository.sourcesFor`
 * on the week's transaction, and by hand in the unit tests. Every read returns countable rows
 * only (the exclusions are SQL, `exclusions.ts`).
 */
export interface NumbersWeekSources {
  paidOrders(window: NumbersWeekWindow): Promise<NumbersPaidOrderRow[]>;
  firstPublications(window: NumbersWeekWindow): Promise<NumbersFirstPublicationRow[]>;
  currentProfiles(window: NumbersWeekWindow): Promise<NumbersCurrentProfileRow[]>;
  activity(window: NumbersWeekWindow): Promise<NumbersActivityRow[]>;
  confirmedHires(window: NumbersWeekWindow): Promise<NumbersHireRow[]>;
  openedContacts(window: NumbersWeekWindow): Promise<NumbersOpenedContactRow[]>;
  formCompletions(window: NumbersWeekWindow): Promise<NumbersFormCompletionRow[]>;
  companyDims(payerIds: readonly string[]): Promise<Map<string, NumbersDims>>;
  workerDims(workerIds: readonly string[]): Promise<Map<string, NumbersDims>>;
}

function lookup(map: ReadonlyMap<string, NumbersDims>): NumbersDimsLookup {
  return (id) => map.get(id) ?? UNKNOWN_DIMS;
}

/**
 * EVERY SNAPSHOT METRIC OF ONE WEEK: read the sources (in sequence: they share the week's one
 * connection), place every company and worker they name, and run each metric function. The
 * result is every stored metric × its 42 cells, in a stable order. No clock and no write: the
 * sweep and the recompute tool decide what to do with it.
 */
export async function computeNumbersWeek(
  sources: NumbersWeekSources,
  week: string,
): Promise<NumbersMetricCells[]> {
  const w = weekWindow(week);
  const orders = await sources.paidOrders(w);
  const publications = await sources.firstPublications(w);
  const hires = await sources.confirmedHires(w);
  const opened = await sources.openedContacts(w);
  const profiles = await sources.currentProfiles(w);
  const activity = await sources.activity(w);
  const completions = await sources.formCompletions(w);

  const companies = lookup(
    await sources.companyDims([
      ...orders.map((o) => o.payerId),
      ...publications.map((p) => p.payerId),
      ...hires.map((h) => h.payerId),
      ...opened.map((o) => o.payerId),
    ]),
  );
  const workers = lookup(
    await sources.workerDims([
      ...profiles.map((p) => p.workerId),
      ...activity.map((a) => a.workerId),
      ...completions.map((c) => c.workerId),
    ]),
  );

  return [
    ...payingCompanies(w, orders, companies),
    ...companiesPosted(w, publications, companies),
    ...completedProfiles(w, profiles, workers),
    ...activeWorkers30d(w, activity, workers),
    ...formCompletedUnconfirmed(w, completions, workers),
    ...confirmedHires(w, hires, companies),
    ...contactsPerHire(w, opened, hires, companies),
    ...revenueByPack(w, orders, companies),
  ];
}
