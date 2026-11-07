import Link from "next/link";
import type { EntityTimeline } from "../lib/events";
import { queryHref } from "../lib/query-href";
import { EventTable } from "./event-table";
import { Pager } from "./pager";
import { ACTION_ICON, Icon } from "@badabhai/icons";

/**
 * The Timeline tab (A9, #2579): every event recorded for the company's ROOT payer, newest
 * first. Read-only (`read_events`), keyset-paged.
 */
export function CompanyTimelineTab({
  timeline,
  refused,
  failed,
  cursor,
  basePath,
  noun,
}: {
  timeline: EntityTimeline | null;
  refused: boolean;
  failed: boolean;
  cursor: string | undefined;
  basePath: string;
  noun: string;
}) {
  if (refused) {
    return (
      <div className="state">
        <h3 className="state__title">Your role cannot read the event timeline</h3>
        <p className="state__body">
          The timeline sits on a separate capability from the company record. Nothing is broken;
          this tab is simply not open to your role.
        </p>
      </div>
    );
  }

  if (failed) {
    return (
      <div className="state state--error">
        <h3 className="state__title">The event timeline is unavailable</h3>
        <p className="state__body">
          The events read failed. The company record and its other tabs came from separate reads
          and are unaffected.
        </p>
        <div className="state__actions">
          <Link className="btn btn--ghost" href={queryHref(basePath, { tab: "timeline" })}>
            <Icon name={ACTION_ICON.retry} />
            Retry
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="company-timeline">
      <div className="panel__head">
        <h2 className="panel__title">Timeline</h2>
        <p className="panel__sub">
          Every event recorded for this {noun}, newest first. Admin writes carry the session admin
          as the actor.
        </p>
      </div>
      <EventTable
        events={timeline?.events ?? []}
        emptyMessage="No events recorded yet"
        emptyBody={`The audit spine fills as this ${noun} is used. Events will appear here as they are emitted.`}
        pager={
          <Pager
            basePath={basePath}
            params={{ tab: "timeline" }}
            cursor={cursor}
            nextCursor={timeline?.nextCursor}
            note="The timeline is keyset-paged, so new events arriving mid-scan cannot make rows skip or repeat."
          />
        }
      />
    </div>
  );
}
