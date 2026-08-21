import { describeJourneyCaveat } from "../lib/journey-view";

/**
 * The journey API's HONEST-ABSENCE channel, rendered.
 *
 * A caveat is the server saying "this measurement does not exist for this data" — kit
 * downloads only attributable since migration 0079, per-session AI cost only from 0077, a
 * session with no interview state, a pack version retired under a worker's answers, a stuck
 * ranking that was partly blind. Every one of them exists so a MISSING measurement never
 * renders as a confident zero, which means dropping them is not a styling choice: it re-creates
 * exactly the failure the field was added to prevent.
 *
 * So this renders whatever the server sent, including a code this build has never heard of —
 * `describeJourneyCaveat` has an explicit unknown branch that shows the code itself.
 *
 * Renders NOTHING when the list is empty. An empty caveat band on every page would train an
 * operator to skip the band on the page where it matters.
 */
export function CaveatList({
  caveats,
  headingId,
}: {
  caveats: readonly string[];
  headingId: string;
}) {
  if (caveats.length === 0) return null;

  return (
    <section className="attention" aria-labelledby={headingId}>
      <h2 className="attention__heading" id={headingId}>
        What these figures cannot tell you
      </h2>
      <ul className="attention__list">
        {caveats.map((code) => {
          const view = describeJourneyCaveat(code);
          return (
            <li className="attention__item attention__item--info" key={code}>
              <div className="attention__text">
                <p className="attention__title">{view.title}</p>
                <p className="attention__body">{view.body}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
