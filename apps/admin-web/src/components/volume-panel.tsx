import type { VolumeSummary } from "../lib/dashboard";
import { formatCount } from "../lib/format";
import { CUSTOMER_KIND_LABELS } from "../lib/customer";
import { BucketList } from "./bucket-list";
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

      <div className="stats">
        <Stat label="Workers" value={formatCount(volume.workers.total)} />
        <Stat
          label="Workers with a profile"
          value={formatCount(volume.worker_profiles.workers_with_profile)}
        />
        <Stat label="Postings" value={formatCount(volume.job_postings.total)} />
        <Stat label="Customers" value={formatCount(volume.payers.total)} />
      </div>

      <div className="stats stats--compact">
        <Stat label="Applies" value={formatCount(volume.applications.applied)} />
        <Stat
          label="Posting decisions (applies + skips)"
          value={formatCount(volume.applications.total)}
        />
        <Stat label="Contact unlocks" value={formatCount(volume.unlocks.issued)} />
        <Stat label="Resumes generated" value={formatCount(volume.resumes.total)} />
        <Stat
          label="Deletions scheduled"
          value={formatCount(volume.workers.pending_deletion)}
          /* A DPDP erasure in flight is an operational fact with a clock on it, not a
             neutral counter — it reads as attention-worthy whenever it is non-zero. */
          tone={volume.workers.pending_deletion > 0 ? "warn" : undefined}
        />
      </div>

      <div className="cols">
        <div>
          <h3 className="panel__title" id="volume-workers">
            Workers by status
          </h3>
          <BucketList buckets={volume.workers.by_status} labelledBy="volume-workers" />
        </div>
        <div>
          <h3 className="panel__title" id="volume-profiles">
            Profiles by status
          </h3>
          <p className="panel__sub">
            One row per worker — their current profile, not one row per extraction job.
          </p>
          <BucketList buckets={volume.worker_profiles.by_status} labelledBy="volume-profiles" />
        </div>
      </div>

      <div className="cols">
        <div>
          <h3 className="panel__title" id="volume-postings">
            Postings by status
          </h3>
          <BucketList buckets={volume.job_postings.by_status} labelledBy="volume-postings" />
        </div>
        <div>
          <h3 className="panel__title" id="volume-payers-role">
            Customers by type
          </h3>
          {/* The stored roles are `employer` and `agent`; the console's names are Company and
              Agency (owner ruling 2026-10-01), so the rows say those and need no legend. */}
          <BucketList
            buckets={volume.payers.by_role}
            labelledBy="volume-payers-role"
            labels={CUSTOMER_KIND_LABELS}
          />

          <h3 className="panel__title" id="volume-payers-status">
            Customers by status
          </h3>
          <BucketList buckets={volume.payers.by_status} labelledBy="volume-payers-status" />
        </div>
      </div>
    </section>
  );
}
