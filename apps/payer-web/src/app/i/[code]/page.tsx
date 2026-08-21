import type { Metadata } from "next";
import {
  intentUrl,
  isWellFormedInviteCode,
  pingInviteClick,
  playStoreBrowseUrl,
  playStoreUrl,
} from "../../../lib/invite-landing";

/**
 * PUBLIC referral landing page — `https://payer.43-204-36-199.sslip.io/i/<code>` (blocker B4).
 *
 * WHY IT EXISTS. `kInviteLinkBase` in the worker app builds exactly this URL, and it had no
 * route: a shared link opened by anyone WITHOUT the app installed 404'd, and the referral —
 * and the agent's commission — evaporated. Firebase Dynamic Links shut down 2025-08-25, so
 * this self-hosted resolver plus Play Install Referrer IS the attribution chain now.
 *
 * WHEN THE APP IS INSTALLED, NOBODY EVER SEES THIS PAGE. Android intercepts a verified App
 * Link (`/.well-known/assetlinks.json` delegates `common.handle_all_urls` to the worker
 * app's package) and opens the app directly with the code. Do NOT "fix" this page for the
 * installed case, and do NOT add a client-side redirect into a `badabhai://` scheme to
 * force it: that fires the browser's "open in app?" interstitial for people who do NOT have
 * the app, which is the exact audience this page is for.
 *
 * DELIBERATELY OUTSIDE the `(portal)` route group, so it inherits NO payer auth, no session
 * read, and no portal chrome. It is worker-facing, not payer-facing.
 *
 * NO ORACLE. The page renders IDENTICALLY for a valid, invalid, expired and already-used
 * code: the code is never resolved for rendering, so there is nothing to branch on. It
 * never reveals whether a code exists, who sent it, or anything at all about a worker. That
 * matters because the URL is shareable and completely unauthenticated — an attacker who
 * could tell a live code from a dead one could enumerate the referral space.
 *
 * BUILT FOR A ₹7k PHONE ON 3G. A Server Component with zero client JavaScript, zero
 * client-side data fetching, no images, and no fonts beyond the ones the root layout
 * already loads. The whole page is static markup plus one anchor.
 */

export const dynamic = "force-dynamic";

/**
 * OPEN GRAPH (B4). WhatsApp is the actual distribution channel here: an agent forwards a
 * link into a group, and what recipients see is the preview card, not the URL. A link with
 * no OG tags renders as a bare grey string, which reads as spam and materially depresses
 * the forward→tap rate this whole commission channel depends on.
 *
 * STATIC, NOT PER-CODE — deliberately. Generating the card from the code would resolve the
 * code at render time and reintroduce the existence ORACLE the page's header rules out: a
 * valid and an invalid code must produce byte-identical output. It also means WhatsApp's
 * crawler fetch stays a pure cache hit that touches no referral state.
 *
 * `og:image` is intentionally ABSENT rather than pointed at a placeholder. WhatsApp renders
 * a clean title+description card when no image is declared, but shows a broken-image frame
 * when one is declared and fails to load — worse than none. Add one here only alongside a
 * real, cached, <300KB asset.
 */
export const metadata: Metadata = {
  title: "BadaBhai — apna profile banaiye",
  description: "BadaBhai app install karke apna profile banaiye aur naukri ke liye taiyar rahiye.",
  // A referral link is shared person-to-person; it has no business in a search index.
  robots: { index: false, follow: false },
  openGraph: {
    type: "website",
    siteName: "BadaBhai",
    title: "BadaBhai — apna profile banaiye",
    description:
      "CNC, VMC aur factory ke kaam ke liye. App install kijiye, apna profile aur resume bilkul free banaiye.",
    locale: "hi_IN",
  },
  twitter: {
    card: "summary",
    title: "BadaBhai — apna profile banaiye",
    description:
      "CNC, VMC aur factory ke kaam ke liye. App install kijiye, apna profile aur resume bilkul free banaiye.",
  },
};

/**
 * Worker-facing copy — Hinglish, aap-form. No `bhai/bhaiya/beta/behen/yaar`, no `tu/tum`,
 * no exclamation marks, no emoji (the persona rules; they also keep the page readable to a
 * screen reader and safe to translate later).
 */
const STEPS: readonly string[] = [
  "App install kijiye aur apna phone number verify kijiye",
  "Chat me apne kaam ke baare me bataiye — bol kar ya likh kar",
  "Apna profile aur resume taiyar milega, bilkul free",
];

export default async function InviteLandingPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;

  // Record the click server-side, best-effort. This is the ONLY thing the code is used for
  // besides being passed to the Play Store; the render below does not depend on it, and a
  // failure/timeout changes nothing that a visitor can observe.
  await pingInviteClick(code);

  // THE FALLBACK LEG LANDS HERE TOO (`/i/unknown`), so the code is not necessarily real.
  // A malformed code must NOT ride to Play as `referrer=bb_code=unknown`: the app would read
  // that junk back on first run and burn its one install-referrer claim attempt on a code
  // that resolves to nothing. An unattributed install is the honest outcome.
  const attributable = isWellFormedInviteCode(code);

  // The referral payload rides to Play as `referrer=bb_code=<code>`, which the app reads
  // back through the Install Referrer API on first run.
  const installUrl = attributable ? playStoreUrl(code) : playStoreBrowseUrl();

  // Leg 2 of the fallback chain — "open the app if installed, else Play Store WITH the
  // referrer". Rendered as a SECONDARY, user-tapped link, never an automatic redirect: the
  // header's warning about the `badabhai://` interstitial is about auto-redirecting people
  // who do NOT have the app, and that audience is exactly who lands here. An explicit
  // "already have the app?" affordance costs them nothing and rescues the installed-but-
  // App-Link-unverified case, which is EVERY Android user until P0-6 lands.
  // Suppressed for an unusable code — a deep link into `badabhai://i/unknown` would open the
  // app onto a code it cannot resolve, which is worse than not offering the shortcut.
  const openInAppUrl = attributable ? intentUrl(code) : null;

  return (
    <main className="invite-landing">
      <div className="invite-landing__card">
        <p className="invite-landing__eyebrow">Aapko invite mila hai</p>
        <h1 className="invite-landing__title">BadaBhai par apna profile banaiye</h1>
        <p className="invite-landing__sub">
          CNC, VMC aur factory ke kaam ke liye. Apni jaankari ek baar dijiye, aur company aap tak
          khud pahunchegi.
        </p>

        <a
          className="bb-btn bb-btn--primary bb-btn--lg bb-btn--block invite-landing__cta"
          href={installUrl}
          rel="noopener"
        >
          <span>Play Store se app install kijiye</span>
        </a>

        <ol className="invite-landing__steps">
          {STEPS.map((step, index) => (
            <li key={step} className="invite-landing__step">
              <span className="invite-landing__step-num" aria-hidden="true">
                {index + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>

        <p className="invite-landing__note">
          Aapki jaankari aapke control me rehti hai. Aapki permission ke bina aapka number kisi
          company ko nahi diya jata.
        </p>
        {openInAppUrl ? (
          <p className="invite-landing__note invite-landing__note--muted">
            App pehle se install hai, to{" "}
            <a href={openInAppUrl} rel="noopener">
              yahan se app me kholein
            </a>
            .
          </p>
        ) : (
          <p className="invite-landing__note invite-landing__note--muted">
            App pehle se install hai, to yeh link seedhe app me khul jayega.
          </p>
        )}
      </div>
    </main>
  );
}
