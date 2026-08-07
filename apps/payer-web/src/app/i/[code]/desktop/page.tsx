import type { Metadata } from "next";
import { inviteLandingUrl, pingInviteClick } from "../../../../lib/invite-landing";
import { InviteQr } from "./invite-qr";

/**
 * DESKTOP referral landing page — `https://app.badabhai.in/i/<code>/desktop` (B4).
 *
 * WHERE IT COMES FROM. A DESKTOP browser is sent here instead of to the mobile page, because
 * the mobile page's only real action is "install from the Play Store", which is useless on a
 * laptop: the worker cannot install an Android app on it, and a dead-ended desktop visit is
 * a lost referral for an agent who happened to share the link into a desktop WhatsApp Web
 * session — a completely normal thing for the ~450-agent channel to do.
 *
 * WHAT IT DOES INSTEAD. Renders the shareable link as a QR so the visitor scans it with the
 * phone they will actually install on. The scan re-enters `/i/<code>` from the phone, so the
 * PHONE's own User-Agent drives the App-Link / intent / Play-Store branch — that is what
 * preserves attribution across the device hop; the code is never retyped and never lost.
 *
 * IT ENCODES `/i/`, NOT `/r/` (#607). `/r/` is served by `apps/api`, but the short-link origin
 * points at this app, which has no `/r` route and no rewrite — so the QR encoded a 404 and
 * every bridge scan died there with no `referral_clicks` row. `/i/` logs its own click via
 * {@link pingInviteClick}, which is where the resolver's 302 landed anyway.
 *
 * SAME NO-ORACLE RULE as the mobile page: the code is never resolved for rendering, so a
 * valid, invalid, expired and already-used code all produce identical output. Nothing here
 * reveals whether a code exists or who sent it.
 *
 * NOT INDEXED and no OG card: a desktop QR bridge is not something to preview or share
 * onward — the shareable artifact is the short link itself, whose card lives on the mobile
 * route.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "BadaBhai — phone se scan kijiye",
  description: "QR code scan karke BadaBhai app install kijiye.",
  robots: { index: false, follow: false },
};

const STEPS: readonly string[] = [
  "Apne phone ka camera kholiye",
  "Yeh QR code scan kijiye",
  "App install karke apna profile banaiye, bilkul free",
];

export default async function InviteDesktopPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;

  // Record the click server-side, best-effort — identical posture to the mobile page. A
  // desktop view IS a real click on the agent's link and must count; the phone's later scan
  // is de-duplicated downstream by the click-hash window, not by dropping this one.
  await pingInviteClick(code);

  // The QR encodes the MOBILE landing, not this page: scanning must re-enter `/i/<code>` from
  // the phone so the phone's own User-Agent drives the App-Link/Play-Store branch. Encoding
  // this desktop URL instead would strand the phone on a QR page showing itself.
  const scanUrl = inviteLandingUrl(code);

  return (
    <main className="invite-landing">
      <div className="invite-landing__card">
        <p className="invite-landing__eyebrow">Aapko invite mila hai</p>
        <h1 className="invite-landing__title">Phone se yeh QR scan kijiye</h1>
        <p className="invite-landing__sub">
          BadaBhai app Android phone par chalta hai. Apne phone se yeh code scan kijiye aur app
          install kijiye.
        </p>

        <div className="invite-landing__qr">
          <InviteQr url={scanUrl} />
        </div>

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

        {/* The same link in type, so someone whose camera fails can still type it. */}
        <p className="invite-landing__note invite-landing__note--muted bb-mono">{scanUrl}</p>
        <p className="invite-landing__note">
          Aapki jaankari aapke control me rehti hai. Aapki permission ke bina aapka number kisi
          company ko nahi diya jata.
        </p>
      </div>
    </main>
  );
}
