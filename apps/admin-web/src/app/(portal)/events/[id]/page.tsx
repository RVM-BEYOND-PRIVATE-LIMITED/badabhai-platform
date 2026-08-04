import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCapability } from "../../../../lib/auth";
import { getEvent, getTrace } from "../../../../lib/events";
import { AdminRequestError } from "../../../../lib/admin-http";
import { formatTimestamp, humanizeEventName } from "../../../../lib/format";

export const dynamic = "force-dynamic";

/**
 * Event detail — the envelope, the payload, and the causal chain it belongs to.
 *
 * The payload is rendered verbatim as JSON. That is deliberate: this is an audit record,
 * and prettifying or selectively displaying fields would mean an operator reviewing an
 * incident sees the portal's interpretation rather than what was actually written. The
 * server guarantees the projection is PII-free; the portal's job is to not editorialise.
 */
export default async function EventDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireCapability("read_events");
  const { id } = await params;

  let event;
  try {
    event = await getEvent(id);
  } catch (err) {
    // A 404 is an ordinary outcome (a mistyped or stale id) and deserves the real
    // not-found screen, not the "something broke" boundary.
    if (err instanceof AdminRequestError && err.status === 404) notFound();
    throw err;
  }

  // The chain is best-effort: the detail is the point of this page, and a trace failure
  // must not take it down with it.
  const trace = await getTrace(event.correlation_id).catch(() => null);
  const siblings = trace?.events.filter((e) => e.id !== event.id) ?? [];

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <p className="crumb">
            <Link className="link" href="/events">
              Events
            </Link>
          </p>
          <h1 className="page__title">{humanizeEventName(event.event_name)}</h1>
          <p className="page__sub">
            <time dateTime={event.occurred_at}>{formatTimestamp(event.occurred_at)}</time>
          </p>
        </div>
      </header>

      <section className="panel" aria-labelledby="env-heading">
        <div className="panel__head">
          <h2 className="panel__title" id="env-heading">
            Envelope
          </h2>
        </div>
        <dl className="kv">
          <Row k="Event" v={`${event.event_name} (v${event.event_version})`} mono />
          <Row k="Event id" v={event.id} mono />
          <Row k="Actor" v={`${event.actor_type} · ${event.actor_id ?? "—"}`} mono />
          <Row k="Subject" v={`${event.subject_type} · ${event.subject_id ?? "—"}`} mono />
          <Row k="Correlation id" v={event.correlation_id} mono />
          <Row k="Causation id" v={event.causation_id ?? "—"} mono />
        </dl>
      </section>

      <section className="panel" aria-labelledby="payload-heading">
        <div className="panel__head">
          <h2 className="panel__title" id="payload-heading">
            Payload
          </h2>
          <p className="panel__sub">
            Recorded verbatim. Payloads are PII-free by construction — ids, enums and
            codes only.
          </p>
        </div>
        <pre className="code">{JSON.stringify(event.payload, null, 2)}</pre>
      </section>

      {Object.keys(event.metadata).length > 0 && (
        <section className="panel" aria-labelledby="meta-heading">
          <div className="panel__head">
            <h2 className="panel__title" id="meta-heading">
              Metadata
            </h2>
          </div>
          <pre className="code">{JSON.stringify(event.metadata, null, 2)}</pre>
        </section>
      )}

      <section className="panel" aria-labelledby="chain-heading">
        <div className="panel__head">
          <h2 className="panel__title" id="chain-heading">
            Causal chain
          </h2>
          <p className="panel__sub">
            Everything sharing this correlation id — what led here, and what followed.
          </p>
        </div>
        {siblings.length === 0 ? (
          <p className="empty">
            {trace === null
              ? "The chain could not be loaded."
              : "This event is alone in its correlation chain."}
          </p>
        ) : (
          <ol className="chain">
            {siblings.map((e) => (
              <li className="chain__item" key={e.id}>
                <time className="chain__time" dateTime={e.occurred_at}>
                  {formatTimestamp(e.occurred_at)}
                </time>
                <Link className="link" href={`/events/${e.id}`}>
                  {humanizeEventName(e.event_name)}
                </Link>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <>
      <dt className="kv__k">{k}</dt>
      <dd className={`kv__v${mono ? " mono" : ""}`}>{v}</dd>
    </>
  );
}
