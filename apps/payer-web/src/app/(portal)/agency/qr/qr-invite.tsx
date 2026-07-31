"use client";

import { useState, useTransition } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Badge, Button, Card } from "../../../../components/ds";
import { createInviteAction } from "../dashboard/invite-actions";

/**
 * PRINTABLE QR INVITE (ADR-0022) — one opaque invite link, rendered as a sheet an agency
 * can print and stick on a workshop wall.
 *
 * WHAT IS ENCODED, EXACTLY: the invite URL string and NOTHING else. No payer id, no agency
 * name, no session token, no campaign, no per-code caption. A QR is a lossless encoding of a
 * URL the agency is already sharing openly, so it adds no exposure — provided nothing else
 * rides along inside it.
 *
 * RENDERED CLIENT-SIDE. `qrcode.react` draws the matrix locally; no third-party QR image
 * service is ever fetched. Sending the code to api.qrserver.com (or any external renderer)
 * would hand a live bearer token to an outside party for no benefit — hence the vendored
 * library. SVG, not canvas: it prints sharply at any size.
 *
 * FACELESS: an invite code identifies nobody. The sheet carries no worker reference, no
 * counts, and not even the agency's own name — a wall poster is public, and the printed
 * sheet must stay meaningless to anyone who photographs it. If an agency wants to note who a
 * particular sheet is for, that note belongs on their own paper, never on the platform.
 *
 * NEUTRAL FAILURE: a cap-reached mint and a transient error surface as the SAME message from
 * `createInviteAction` — no fake code is ever rendered.
 */

/**
 * Build the ABSOLUTE url a QR must encode from the RELATIVE link the mint returns ("/i/<code>").
 *
 * A camera cannot resolve a relative path: encoding "/i/abc" produces a QR that scans to
 * nothing. Pure + exported so the "is it absolute?" property is unit-pinned.
 */
export function toAbsoluteInviteUrl(origin: string, link: string): string {
  if (/^https?:\/\//i.test(link)) return link; // already absolute — encode as-is.
  const base = origin.replace(/\/+$/, "");
  return `${base}${link.startsWith("/") ? "" : "/"}${link}`;
}

/** The browser origin, or "" when there is no window (SSR) — the caller refuses to encode "". */
function currentOrigin(): string {
  return typeof window === "undefined" ? "" : window.location.origin;
}

/**
 * Which origin goes ON THE PAPER.
 *
 * A printed poster is PERMANENT: whatever host it encodes is the host workers scan for as
 * long as the sheet is on the wall, and it cannot be corrected after printing. Using the
 * browsing origin alone meant a staffer on a preview deploy, an IP, or localhost printed a
 * poster that dies the moment that host does.
 *
 * So: prefer the deployment's CANONICAL public site url when one is configured
 * (`NEXT_PUBLIC_SITE_URL` — an EXISTING optional payer-web variable, not a new required one;
 * public by definition and safe in the client bundle), and fall back to the browsing origin
 * when it is unset or unparseable. Only the ORIGIN is taken (`new URL(...).origin` drops any
 * path/query), and only http(s) is accepted, so a stray value can never turn the poster into
 * a link to somewhere else. Either way the sheet PRINTS the url it encoded, on screen, before
 * the print button — a wrong host is meant to be visible while it is still fixable.
 */
export function printableInviteOrigin(
  configured: string | undefined,
  browsingOrigin: string,
): string {
  const raw = configured?.trim();
  if (!raw) return browsingOrigin;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return browsingOrigin;
    return url.origin;
  } catch {
    return browsingOrigin; // not a url at all — the browsing origin is the honest fallback.
  }
}

const NEUTRAL_FAILURE = "Could not create a QR invite right now. Please try again shortly.";

export function AgencyQrInvite() {
  const [sheet, setSheet] = useState<{ code: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      // No campaign tag on this path: a printed sheet is the one place a "who is this for?"
      // label gets typed, and such a label must never be stored (it would turn a cardinality
      // into an assertion about a person).
      const res = await createInviteAction({});
      if (!res.ok) {
        setSheet(null);
        setError(res.error);
        return;
      }
      // `process.env.NEXT_PUBLIC_SITE_URL` is referenced literally so Next inlines it into
      // the client bundle; it is a PUBLIC value and never a secret.
      const origin = printableInviteOrigin(process.env.NEXT_PUBLIC_SITE_URL, currentOrigin());
      if (!origin) {
        // Never render a QR encoding a relative path — it would print an unscannable sheet.
        setSheet(null);
        setError(NEUTRAL_FAILURE);
        return;
      }
      setSheet({ code: res.code, url: toAbsoluteInviteUrl(origin, res.link) });
    });
  }

  function print() {
    if (typeof window !== "undefined") window.print();
  }

  return (
    <section className="agency-section agency-qr">
      <Card variant="flat" className="agency-invite__note">
        <strong>One poster, many workers.</strong> Anyone who scans this code lands on the BadaBhai
        install page and joins themselves. The code names nobody — print it, stick it up, and hand
        out copies freely.
      </Card>

      <form className="agency-invite__form" onSubmit={handleCreate}>
        <div className="agency-invite__actions">
          <Button type="submit" disabled={pending} loading={pending}>
            {pending ? "Creating…" : sheet ? "Create another QR invite" : "Create a QR invite"}
          </Button>
          <Badge tone="success" upper>
            Live
          </Badge>
        </div>
        {/*
          THE ONE ANNOUNCED REGION — outcomes, not just failures. The whole sheet (QR, caption,
          printed url) and the print button render OUTSIDE the form and focus never moves, so a
          success that is not announced here is silent to a screen reader. The announcement
          repeats the encoded url, which is also the host check: it is spoken and shown BEFORE
          anything reaches paper.
        */}
        <div aria-live="polite" className="agency-invite__status">
          {error ? <p className="agency-invite__error">{error}</p> : null}
          {!error && sheet ? (
            <p className="agency-section__sub">
              QR invite created. It encodes <span className="bb-mono">{sheet.url}</span> — check
              that address is right, then use the &ldquo;Print this sheet&rdquo; button below.
            </p>
          ) : null}
        </div>
      </form>

      {sheet ? (
        <>
          {/*
            THE PRINTABLE SHEET. Everything inside is meant for paper: the QR, one line of
            instruction, and the same link in type so a worker whose camera fails can enter
            it by hand. Nothing identifying — no agency name, no counts, no worker reference.
          */}
          <div className="agency-qr__sheet">
            <div className="agency-qr__layout">
              <div className="agency-qr__frame">
                <QRCodeSVG
                  className="agency-qr__code"
                  // EXACTLY the invite url — nothing appended, nothing encoded alongside.
                  value={sheet.url}
                  size={320}
                  // Level Q (25% recovery): printed paper gets creased, greasy and dusty on a
                  // shop floor, and a wall poster is scanned at an angle. M is the floor; Q is
                  // the margin that keeps it readable after a month on the wall.
                  level="Q"
                  // Four modules of quiet zone — the spec minimum. Without it, scanners fail
                  // against a dark wall or a printed border.
                  marginSize={4}
                  title="Scan to install BadaBhai and join"
                />
              </div>
              <p className="agency-qr__caption">
                Scan to install BadaBhai — apna profile banaiye, bilkul free
              </p>
              <p className="agency-qr__link bb-mono">{sheet.url}</p>
            </div>
          </div>

          <div className="agency-qr__actions">
            <Button variant="secondary" onClick={print}>
              Print this sheet
            </Button>
          </div>
        </>
      ) : null}
    </section>
  );
}
