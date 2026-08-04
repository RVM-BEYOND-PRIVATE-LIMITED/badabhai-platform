import type { PaymentsPosture } from "../lib/entities";

/**
 * The provenance banner for every money screen.
 *
 * ── WHY THIS IS NOT OPTIONAL CHROME ─────────────────────────────────────────────────────
 * `PAYMENTS_ENABLE_REAL` is false today, which means **no rupee on the Finance screens was
 * ever charged to anyone**. Every order was settled by the mock path. Rendering those totals
 * without saying so produces a page that is indistinguishable from a revenue report — and
 * the first time one is pasted into a deck or a board update, the platform has told someone
 * it earned money it did not earn.
 *
 * This is the same failure TD81 recorded on the AI side: staging reported healthy for weeks
 * while running a mocked provider behind a 200, because nothing on the screen said which one
 * it was. The lesson taken from that was not "check more carefully" — it was "make the
 * simulated thing announce itself".
 *
 * So this renders on EVERY money view, at the top, in a warning tone, before the numbers.
 * It is never collapsed, never a footnote, and never suppressed once dismissed.
 */
export function PaymentsPostureBanner({ posture }: { posture: PaymentsPosture }) {
  if (posture.mode === "real") {
    return (
      <section className="notice" role="status">
        <strong>Live payments.</strong> These figures describe real money charged through the
        payment provider.
      </section>
    );
  }

  return (
    <section className="notice notice--warn" role="status">
      <strong>Simulated money — not revenue.</strong> Real payments are switched off
      {posture.blocked_reason ? (
        <>
          {" "}
          (<code>{posture.blocked_reason}</code>)
        </>
      ) : null}
      , so every order below was settled by the mock path and <strong>no one was charged</strong>.
      Credits and balances are real platform state; the ₹ amounts are not income.
    </section>
  );
}

/**
 * The inline form, for a money figure that appears away from the banner.
 *
 * Belt and braces on purpose: a stat tile can be screenshotted on its own, and a caveat that
 * only exists at the top of the page does not travel with it.
 */
export function MockMoneyTag({ posture }: { posture: PaymentsPosture }) {
  if (posture.mode === "real") return null;
  return (
    <span className="pill pill--warn" title="Real payments are disabled — this is mock money.">
      simulated
    </span>
  );
}
