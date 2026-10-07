"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ACTION_ICON, Icon, type IconName } from "@badabhai/icons";
import type { AgencyJob } from "../../../../lib/contracts";
import {
  day,
  experienceBandLabel,
  isActiveJob,
  isEditableJob,
  neededByLabel,
  payBandLabel,
  tradeLabel,
} from "../../../../lib/agency-view";
import { bandLabel } from "../../../../lib/masking";
import { Badge, Button, Card } from "../../../../components/ds";
import {
  closeAgencyJobAction,
  pauseAgencyJobAction,
  resumeAgencyJobAction,
  type AgencyJobActionResult,
} from "./jobs-actions";

/**
 * Client management surface for an agency's OWN postings (ADR-0022, LIVE) — the body of the
 * Postings page (`/agency/jobs`). DS3.1 skin.
 *
 * Runs in the BROWSER and sees NO secret. It calls the Server Actions, which bind to the
 * server-held payer (the payer JWT, XB-A) — the client passes ONLY a job id, NEVER a payer id.
 * The list LINKS the posting's own pages and runs only the lifecycle (pause / resume / close) in
 * place: EDIT is its own page (`/agency/jobs/<id>/edit`, final sweep F02 — the inline editor it
 * replaced started the worker card and "Save changes" below a laptop's fold), and CREATE is its own
 * page (`/agency/jobs/new`, the "New posting" entry point everywhere), so this list carries no
 * second create control. Every posting renders as a DS `Card`: bands + a count + a status
 * `Badge`; no worker identity, no employer name (faceless/coarse). ₹ pay band + counts render
 * in mono tabular (`bb-mono`). A not-found/not-owned action result reads neutrally (no oracle).
 * Like a company row, the TITLE opens the posting's details, and each row also links the job's
 * REAL applicants (#1956 — the feed serves the workers who applied since #1955). Tokens only
 * (no raw hex/px).
 */

/** The DS Badge tone for a posting's REAL state (reflects `status`, never invented). 4-state now. */
function statusTone(status: string): "success" | "warning" | "neutral" {
  if (status === "open") return "success";
  if (status === "paused" || status === "suspended") return "warning";
  return "neutral";
}

/** The row lifecycle actions — the one the payer pressed is the one that shows it is running. */
type LifecycleAction = "pause" | "resume" | "close";

/** Each lifecycle button's idle label and its running label (F39: say WHICH action runs). */
const LIFECYCLE_LABEL: Record<LifecycleAction, { idle: string; busy: string }> = {
  pause: { idle: "Pause", busy: "Pausing…" },
  resume: { idle: "Resume", busy: "Resuming…" },
  close: { idle: "Close posting", busy: "Closing…" },
};

export function AgencyJobsManager({ jobs }: { jobs: AgencyJob[] }) {
  const router = useRouter();
  // useState call order (mirrored by agency-jobs-manager.test.tsx): rows, busyById, errorById.
  const [rows, setRows] = useState<AgencyJob[]>(jobs);
  // The lifecycle action in flight on EACH row (review L3): a row's press and its finish touch only
  // that row's entry, so two rows working at once never overwrite each other's state.
  const [busyById, setBusyById] = useState<Record<string, LifecycleAction>>({});
  const [errorById, setErrorById] = useState<Record<string, string | null>>({});
  const [, startTransition] = useTransition();

  function setError(id: string, error: string | null) {
    setErrorById((prev) => ({ ...prev, [id]: error }));
  }

  function upsertRow(job: AgencyJob) {
    setRows((prev) => {
      const i = prev.findIndex((j) => j.id === job.id);
      if (i === -1) return [job, ...prev];
      const next = prev.slice();
      next[i] = job;
      return next;
    });
  }

  function runLifecycle(
    id: string,
    action: LifecycleAction,
    run: () => Promise<AgencyJobActionResult>,
  ) {
    setError(id, null);
    setBusyById((prev) => ({ ...prev, [id]: action }));
    startTransition(async () => {
      const res = await run();
      setBusyById((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      if (res.ok) {
        upsertRow(res.job);
        router.refresh();
      } else {
        setError(id, res.error);
      }
    });
  }

  return (
    <div className="agency-jobs">
      {rows.length === 0 ? (
        // The same empty-state pattern as the company list; what to do next is the page head's
        // one primary action, "New posting", which the copy names instead of repeating.
        <Card>
          <div className="state">
            <span className="state__icon">
              <Icon name={ACTION_ICON.posting} />
            </span>
            <h2 className="state__title">No postings yet</h2>
            <p className="state__body">
              Matched workers can only find your agency once a role is live — use New posting above.
              Posting is free through launch.
            </p>
          </div>
        </Card>
      ) : (
        <div className="agency-jobs__list">
          {rows.map((j) => {
            const rowAction = busyById[j.id];
            const rowBusy = rowAction !== undefined;
            const err = errorById[j.id] ?? null;
            const active = isActiveJob(j);
            /**
             * One lifecycle button: it spins (and says what it is doing) only when IT was pressed;
             * while any action on this row runs, the row's other buttons are disabled.
             */
            const lifecycle = (
              action: LifecycleAction,
              icon: IconName,
              run: () => Promise<AgencyJobActionResult>,
            ) => {
              const running = rowAction === action;
              return (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={rowBusy}
                  loading={running}
                  iconLeft={icon}
                  onClick={() => runLifecycle(j.id, action, run)}
                >
                  {running ? LIFECYCLE_LABEL[action].busy : LIFECYCLE_LABEL[action].idle}
                </Button>
              );
            };
            return (
              <Card key={j.id} className="agency-job">
                <div className="agency-job__main">
                  <div className="agency-job__head">
                    <Link className="agency-job__title" href={`/agency/jobs/${j.id}`}>
                      {j.title}
                    </Link>
                    <Badge tone={statusTone(j.status)} upper>
                      {j.status}
                    </Badge>
                  </div>
                  <div className="agency-job__meta">
                    <span>{tradeLabel(j.tradeKey)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{bandLabel([j.city, j.area]) || "—"}</span>
                    <span aria-hidden="true">·</span>
                    <span className="bb-mono">{payBandLabel(j.payMin, j.payMax)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{experienceBandLabel(j.minExperienceYears, j.maxExperienceYears)}</span>
                    <span aria-hidden="true">·</span>
                    <span>Needed {neededByLabel(j.neededBy)}</span>
                  </div>
                  <div className="agency-job__meta">
                    <span>
                      <span className="bb-mono">{j.applicantsReceived}</span> applicants
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>
                      Posted <span className="bb-mono">{day(j.createdAt)}</span>
                    </span>
                  </div>
                </div>

                <div className="agency-job__actions">
                  <Link
                    className="bb-btn bb-btn--secondary bb-btn--sm"
                    href={`/agency/jobs/${j.id}/applicants`}
                  >
                    <Icon name={ACTION_ICON.users} />
                    <span>Applicants</span>
                  </Link>
                  {isEditableJob(j) ? (
                    <div className="agency-job__btns">
                      {/* The posting's own edit page (F02) — the same door its details header
                          offers. NOT a door while this row's action runs (review L2): Close, then
                          Edit, opened an edit page whose save could never succeed. The disabled
                          stand-in keeps the row's layout and takes no click or focus. */}
                      {rowBusy ? (
                        <span className="bb-btn bb-btn--secondary bb-btn--sm" aria-disabled="true">
                          <Icon name={ACTION_ICON.edit} />
                          <span>Edit posting</span>
                        </span>
                      ) : (
                        <Link
                          className="bb-btn bb-btn--secondary bb-btn--sm"
                          href={`/agency/jobs/${j.id}/edit`}
                        >
                          <Icon name={ACTION_ICON.edit} />
                          <span>Edit posting</span>
                        </Link>
                      )}
                      {active
                        ? lifecycle("pause", "pause", () => pauseAgencyJobAction({ jobId: j.id }))
                        : lifecycle("resume", "play", () => resumeAgencyJobAction({ jobId: j.id }))}
                      {lifecycle("close", ACTION_ICON.reject, () =>
                        closeAgencyJobAction({ jobId: j.id }),
                      )}
                    </div>
                  ) : (
                    <span className="agency-job__closed">
                      {j.status === "suspended" ? "Suspended" : "Closed"}
                    </span>
                  )}
                  <div aria-live="polite" className="agency-job__status">
                    {err ? <p className="agency-job__error">{err}</p> : null}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
