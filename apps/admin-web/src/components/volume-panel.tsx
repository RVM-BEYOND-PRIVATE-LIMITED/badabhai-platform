import type { VolumeSummary } from "../lib/dashboard";
import { formatCount } from "../lib/format";
import { CUSTOMER_KIND_LABELS } from "../lib/customer";
import { BucketList } from "./bucket-list";
import { PanelSection } from "./panel-section";
import { Stat } from "./stat";

/**
 * Platform VOLUME — how big the marketplace is, per table, with each closed enum broken out.
 *
 * PRESENTATIONAL ONLY: every number is the server's, and every headline total is summed
 * server-side FROM the buckets shown beneath it, so a total can never disagree with its own
 * breakdown. Nothing is re-added here.
 *
 * ── THE COUNTS THAT ARE NARROWER THAN THEY LOOK, LABELLED AS SUCH ───────────────────────
 *  - `applications.total` counts every decision — applies AND skips. `applied` is the growth
 *    metric; a skip is a real signal but it is not an application, so both ship.
 *  - `unlocks.issued` is `granted` + `revealed`, not `count(*)`: a `denied` unlock issued
 *    nothing and was charged for nothing.
 *  - `worker_profiles` is ONE ROW PER WORKER, resolved through `CURRENT_PROFILE_ORDER` — not a
 *    count of `worker_profiles` rows, which would double-count every re-interviewed worker.
 * Each of those is said in the copy rather than left for a reader to infer from a number.
 */
export function VolumePanel({ volume }: { volume: VolumeSummary }) {
  return (
    <section className="panel" aria-labelledby="volume-heading">
      <div className="panel__head">
        <h2 className="panel__title" id="volume-heading">
          Platform volume
        </h2>
        <p className="panel__sub">
          Live table state, all-time. Every headline is summed from the breakdown below it, so
          the two cannot disagree.
        </p>
      </div>

      {/* THREE GROUPS, NAMED (#2572): who is on the platform (Supply), who is hiring
          (Demand), and what the two do with each other (Engagement). The same nine tiles as
          before, regrouped so a reader is not left to sort them. Each block below is a
          PanelSection (A1, #2571): 24px apart, behind a hairline divider. */}
      <PanelSection>
        <div className="volume-groups">
          <div className="volume-group">
            <h3 className="volume-group__title" id="volume-supply">
              Supply
            </h3>
            <div className="stats stats--compact" aria-labelledby="volume-supply" role="group">
              <Stat
                label="Workers"
                value={formatCount(volume.workers.total)}
                {...count(volume.workers.total)}
              />
              <Stat
                label="Workers with a profile"
                value={formatCount(volume.worker_profiles.workers_with_profile)}
                {...count(volume.worker_profiles.workers_with_profile)}
              />
              <Stat
                label="Resumes generated"
                value={formatCount(volume.resumes.total)}
                {...count(volume.resumes.total)}
              />
              <Stat
                label="Deletions scheduled"
                value={formatCount(volume.workers.pending_deletion)}
                /* A DPDP erasure in flight is an operational fact with a clock on it, not a
                   neutral counter — it reads as attention-worthy whenever it is non-zero. */
                tone={volume.workers.pending_deletion > 0 ? "warn" : undefined}
              />
            </div>
          </div>

          <div className="volume-group">
            <h3 className="volume-group__title" id="volume-demand">
              Demand
            </h3>
            <div className="stats stats--compact" aria-labelledby="volume-demand" role="group">
              <Stat
                label="Customers"
                value={formatCount(volume.payers.total)}
                {...count(volume.payers.total)}
              />
              <Stat
                label="Postings"
                value={formatCount(volume.job_postings.total)}
                {...count(volume.job_postings.total)}
              />
              <Stat
                label="Contact unlocks"
                value={formatCount(volume.unlocks.issued)}
                {...count(volume.unlocks.issued)}
              />
            </div>
          </div>

          <div className="volume-group">
            <h3 className="volume-group__title" id="volume-engagement">
              Engagement
            </h3>
            <div className="stats stats--compact" aria-labelledby="volume-engagement" role="group">
              <Stat
                label="Applies"
                value={formatCount(volume.applications.applied)}
                {...count(volume.applications.applied)}
              />
              <Stat
                label="Posting decisions (applies + skips)"
                value={formatCount(volume.applications.total)}
                {...count(volume.applications.total)}
              />
            </div>
          </div>
        </div>
      </PanelSection>

      <PanelSection>
        <div className="cols">
          <PanelSection title="Workers by status" titleId="volume-workers">
            <BucketList buckets={volume.workers.by_status} labelledBy="volume-workers" />
          </PanelSection>
          <PanelSection title="Profiles by status" titleId="volume-profiles">
            <p className="panel__sub">
              One row per worker — their current profile, not one row per extraction job.
            </p>
            <BucketList buckets={volume.worker_profiles.by_status} labelledBy="volume-profiles" />
          </PanelSection>
        </div>
      </PanelSection>

      <PanelSection>
        <div className="cols">
          <PanelSection title="Postings by status" titleId="volume-postings">
            <BucketList buckets={volume.job_postings.by_status} labelledBy="volume-postings" />
          </PanelSection>
          <div>
            <PanelSection title="Customers by type" titleId="volume-payers-role">
              {/* The stored roles are `employer` and `agent`; the console's names are Company
                  and Agency (owner ruling 2026-10-01), so the rows say those and need no
                  legend. */}
              <BucketList
                buckets={volume.payers.by_role}
                labelledBy="volume-payers-role"
                labels={CUSTOMER_KIND_LABELS}
              />
            </PanelSection>
            <PanelSection title="Customers by status" titleId="volume-payers-status">
              <BucketList buckets={volume.payers.by_status} labelledBy="volume-payers-status" />
            </PanelSection>
          </div>
        </div>
      </PanelSection>
    </section>
  );
}

/** The count-up a volume tile runs on first render (#2572). */
function count(n: number) {
  return { countUp: { to: n, kind: "count" as const } };
}
