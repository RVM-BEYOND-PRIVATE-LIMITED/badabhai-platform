import type { PaymentsPosture } from "../lib/entities";
import { InfoPopover } from "./info-popover";

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
 * Its one-line claim is never collapsed, never a footnote, and never suppressed once dismissed;
 * only the explanation behind it is one click away (#2573).
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

  // ONE line (A3, #2573): the claim stays in band, before the numbers, and is never collapsed;
  // why it is simulated, and what is still real, sit behind the ⓘ beside it.
  return (
    <section className="notice notice--warn notice--row" role="status">
      <span>
        <strong>Simulated money — not revenue.</strong> No one was charged.
      </span>
      <InfoPopover label="About simulated money">
        <p>
          Real payments are switched off
          {posture.blocked_reason ? (
            <>
              {" "}
              ({posture.blocked_reason})
            </>
          ) : null}
          , so every order was settled by the mock path.
        </p>
        <p>Credits and balances are real platform state; the ₹ amounts are not income.</p>
      </InfoPopover>
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
