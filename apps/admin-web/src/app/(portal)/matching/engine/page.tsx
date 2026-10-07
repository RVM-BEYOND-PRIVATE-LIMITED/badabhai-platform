import Link from "next/link";
import { requireCapability } from "../../../../lib/auth";
import { isAdminRequestError } from "../../../../lib/admin-http";
import { getEnginePosting, getEngineWorker, listEngineWorkers } from "../../../../lib/match-engine";
import {
  dateOnly,
  engineHref,
  type EnginePosting,
  type EngineRecentWorker,
  type EngineTab,
  type EngineWorker,
} from "../../../../lib/match-engine-view";
import { BrandLockup } from "../../../../components/brand-lockup";
import { EngineLive } from "./engine-live";

export const dynamic = "force-dynamic";
export const metadata = { title: "Engine view" };

/**
 * ENGINE VIEW — how Matching V1 decides what one worker sees, live (owner-approved investor
 * demo, 2026-10-05).
 *
 * ── PAGE GATE == DATA GATE ──────────────────────────────────────────────────────────────
 * `read_entities`, exactly the capability on all three `AdminMatchEngineController` reads, so
 * a role that can open this page can read every byte it shows and vice versa.
 *
 * ── LIVE WITHOUT A SECOND READ PATH ─────────────────────────────────────────────────────
 * The client half (`EngineLive`) polls with `router.refresh()`: every tick re-renders THIS
 * server component, which re-checks the session and re-reads through `adminFetch`. There is no
 * browser-reachable proxy route and no cached copy — the screen is always the API's answer.
 *
 * ── DEMO WORKERS ONLY (owner ruling 2026-10-06) ─────────────────────────────────────────
 * The API serves demo workers only (fail-closed, `AdminEngineDemoGate`); a real worker's id is
 * the same neutral "not available" as an unknown one. This page adds no second check.
 *
 * ── NOTHING HERE DECIDES ANYTHING ───────────────────────────────────────────────────────
 * Card order, tiers, funnel counts and the "why" line are the server's (the worker feed's own
 * code path). This page picks WHICH worker or posting to show and nothing else.
 */
export default async function EngineViewPage({
  searchParams,
}: {
  searchParams: Promise<{ worker?: string; tab?: string; posting?: string }>;
}) {
  await requireCapability("read_entities");
  const sp = await searchParams;
  const tab: EngineTab = sp.tab === "posting" ? "posting" : "worker";
  const workerId = isUuid(sp.worker) ? sp.worker : undefined;
  const postingId = isUuid(sp.posting) ? sp.posting : undefined;

  const [recent, worker, posting] = await Promise.all([
    listEngineWorkers().catch(() => null),
    tab === "worker" && workerId ? readOrMissing(() => getEngineWorker(workerId)) : null,
    tab === "posting" && postingId ? readOrMissing(() => getEnginePosting(postingId)) : null,
  ]);

  return (
    <div className="engine">
      <header className="engine__head">
        <BrandLockup surface="ink" />
        <h1 className="engine__title">
          How <span className="engine__title-key">matching</span> works
        </h1>
        <p className="engine__sub">
          One worker&apos;s skills decide which postings reach them, and in what order.
        </p>
      </header>

      <nav className="engine__tabs" aria-label="Engine view">
        <Link
          className="engine__tab"
          aria-current={tab === "worker" ? "page" : undefined}
          href={engineHref({ worker: workerId })}
        >
          Worker
        </Link>
        <Link
          className="engine__tab"
          aria-current={tab === "posting" ? "page" : undefined}
          href={engineHref({ worker: workerId, tab: "posting", posting: postingId })}
        >
          Posting
        </Link>
      </nav>

      {tab === "worker" ? (
        <WorkerPicker recent={recent} selected={workerId} />
      ) : (
        <PostingPicker workerId={workerId} postingId={postingId} />
      )}

      <EngineBody
        tab={tab}
        worker={worker}
        posting={posting}
        selectedWorker={workerId}
        selectedPosting={postingId}
      />
    </div>
  );
}

function EngineBody({
  tab,
  worker,
  posting,
  selectedWorker,
  selectedPosting,
}: {
  tab: EngineTab;
  worker: EngineWorker | "missing" | null;
  posting: EnginePosting | "missing" | null;
  selectedWorker: string | undefined;
  selectedPosting: string | undefined;
}) {
  if (tab === "worker") {
    if (!selectedWorker)
      return <p className="engine__state">Pick a demo worker to see their feed.</p>;
    if (worker === "missing" || worker === null) {
      return <p className="engine__state">That worker is not available.</p>;
    }
    return <EngineLive worker={worker} posting={null} />;
  }
  if (!selectedPosting) {
    return <p className="engine__state">Open a posting from a feed card, or paste its id.</p>;
  }
  if (posting === "missing" || posting === null) {
    return <p className="engine__state">That posting is not available.</p>;
  }
  return <EngineLive worker={null} posting={posting} />;
}

function WorkerPicker({
  recent,
  selected,
}: {
  recent: { workers: EngineRecentWorker[] } | null;
  selected: string | undefined;
}) {
  if (recent === null) {
    return <p className="engine__state">The worker list could not be loaded.</p>;
  }
  if (recent.workers.length === 0) {
    return (
      <p className="engine__state">
        No demo worker has any skills yet. Seed the demo workers first.
      </p>
    );
  }
  return (
    <ul className="engine__picker" aria-label="Recent workers">
      {recent.workers.map((w) => {
        const parts = (
          <>
            <span className="engine__pick-ref mono">{w.short_ref}</span>
            <span className="engine__pick-trade">{w.trade_label ?? "No trade yet"}</span>
            <span className="engine__pick-date">{dateOnly(w.created_at)}</span>
          </>
        );
        return (
          <li key={w.worker_id}>
            {/* The selected worker is a STATE, not a way anywhere: it would link the page it is
                on, beside the Worker tab that already does (final re-sweep NEW-05). */}
            {w.worker_id === selected ? (
              <span className="engine__pick" aria-current="true">
                {parts}
              </span>
            ) : (
              <Link className="engine__pick" href={engineHref({ worker: w.worker_id })}>
                {parts}
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function PostingPicker({
  workerId,
  postingId,
}: {
  workerId: string | undefined;
  postingId: string | undefined;
}) {
  return (
    <form className="engine__posting-form" method="get" action={engineHref({})}>
      <input type="hidden" name="tab" value="posting" />
      {workerId ? <input type="hidden" name="worker" value={workerId} /> : null}
      <label className="engine__posting-label" htmlFor="engine-posting">
        Posting id
      </label>
      <input
        id="engine-posting"
        className="engine__posting-input mono"
        name="posting"
        defaultValue={postingId ?? ""}
        placeholder="00000000-0000-0000-0000-000000000000"
        autoComplete="off"
        spellCheck={false}
      />
      <button className="btn btn--primary" type="submit">
        Show
      </button>
    </form>
  );
}

/** A 404 / 400 is a neutral "not available"; anything else is a real failure and throws. */
async function readOrMissing<T>(read: () => Promise<T>): Promise<T | "missing"> {
  try {
    return await read();
  } catch (err) {
    if (isAdminRequestError(err) && (err.status === 404 || err.status === 400)) return "missing";
    throw err;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v: string | undefined): v is string {
  return typeof v === "string" && UUID.test(v);
}
