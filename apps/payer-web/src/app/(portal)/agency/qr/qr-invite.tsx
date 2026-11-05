"use client";

import { useRef, useState, useTransition } from "react";
import { QRCodeCanvas, QRCodeSVG } from "qrcode.react";
import { Icon } from "@badabhai/icons";
import { Button, Card, FieldFeedback, InlineNotice, Input } from "../../../../components/ds";
import {
  browsingOrigin,
  inviteShareMessage,
  qrDownloadFileName,
  shareableInviteOrigin,
  toAbsoluteInviteUrl,
  whatsAppShareUrl,
} from "../../../../lib/invite-share";
import { createInviteAction } from "../dashboard/invite-actions";
import { agencyErrorMessage } from "../../../../lib/agency-messages";

/**
 * PRINTABLE QR INVITE (ADR-0022) — designr6's generator: campaign settings on the left,
 * a live poster preview on the right.
 *
 * WHAT IS ENCODED, EXACTLY: the invite URL string and NOTHING else. No payer id, no agency
 * name, no session token, no campaign, no per-code caption. The campaign settings below are
 * LOCAL poster copy only — they never reach the mint, the API, or the encoded value. A QR is a
 * lossless encoding of a URL the agency is already sharing openly, so it adds no exposure
 * provided nothing else rides along inside it.
 *
 * RENDERED CLIENT-SIDE. `qrcode.react` draws the matrix locally; no third-party QR image
 * service is ever fetched. SVG, not canvas, for the paper sheet: it prints sharply at any size.
 *
 * FACELESS. The sheet carries no worker reference, no counts, no agency name, and no editable
 * label. Campaign fields are screened for PII before they are used as poster copy, and the
 * form only ever mints an EMPTY body.
 */

const NEUTRAL_FAILURE = "Could not create a QR invite right now. Please try again shortly.";
const DEFAULT_HEADLINE = "अपना काम पाइये — सीधे मालिक से";
const LOCATIONS = ["Factory Gate", "Canteen & Chai Stall", "Transit Hub / Stand"];

export function AgencyQrInvite() {
  const [sheet, setSheet] = useState<{ code: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // Appended after the sheet/error pair the unit test seeds by source order.
  const [campaign, setCampaign] = useState("General Worker Onboarding (NCR Hub)");
  const [location, setLocation] = useState(LOCATIONS[0]!);
  const [headline, setHeadline] = useState(DEFAULT_HEADLINE);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // The OFF-SCREEN canvas twin of the printed SVG, for the downloadable PNG.
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const PII_SHAPE = /@|\+?\d{7,}/;
  const posterHeadline = headline.trim() !== "" ? headline : DEFAULT_HEADLINE;

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCopied(false);
    // Local poster copy must never become a PII sink: a name/phone/email typed here would be
    // printed on a public wall. Refuse it before anything is minted or shown.
    if (PII_SHAPE.test(campaign) || PII_SHAPE.test(headline) || PII_SHAPE.test(location)) {
      setSettingsError(
        "Campaign settings must be non-PII labels — never a person's phone or email.",
      );
      return;
    }
    setSettingsError(null);
    startTransition(async () => {
      // No campaign tag on this path: a printed sheet is public, and a stored "who is this
      // for?" label would turn a cardinality into an assertion about a person.
      const res = await createInviteAction({});
      if (!res.ok) {
        setSheet(null);
        setError(agencyErrorMessage(res.error));
        return;
      }
      // `process.env.NEXT_PUBLIC_SITE_URL` is a PUBLIC value, never a secret.
      const origin = shareableInviteOrigin(process.env.NEXT_PUBLIC_SITE_URL, browsingOrigin());
      if (!origin) {
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

  function downloadPng() {
    const canvas = canvasRef.current;
    if (!canvas || !sheet) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = qrDownloadFileName(sheet.code);
      a.click();
      URL.revokeObjectURL(objectUrl);
    }, "image/png");
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="agency-qr">
      <Card variant="flat" className="agency-invite__note agency-qr__note">
        <Icon name="info" />
        <p>
          <strong>One poster, many workers.</strong> Anyone who scans this code lands on the
          BadaBhai install page and joins themselves. The code names nobody — print it, stick it
          up, and hand out copies freely.
        </p>
      </Card>

      <div className="agency-qr__grid">
        <div className="agency-qr__main">
          <form className="panel agency-qr__settings" onSubmit={handleCreate}>
            <div className="panel__head">
              <h2 className="panel__title">Campaign Settings</h2>
              {sheet ? <span className="agency-protected">Live</span> : null}
            </div>
            <div className="panel__body">
              <Input
                label="Campaign tag / title"
                value={campaign}
                maxLength={120}
                onChange={(e) => {
                  setCampaign(e.target.value);
                  if (settingsError) setSettingsError(null);
                }}
              />

              <div className="agency-qr__field">
                <span className="agency-qr__label">Primary target location</span>
                <div className="agency-qr__segments">
                  {LOCATIONS.map((loc) => (
                    <button
                      key={loc}
                      type="button"
                      className={
                        location === loc
                          ? "agency-qr__segment agency-qr__segment--active"
                          : "agency-qr__segment"
                      }
                      aria-pressed={location === loc}
                      onClick={() => setLocation(loc)}
                    >
                      {loc}
                    </button>
                  ))}
                </div>
              </div>

              <Input
                label="On-poster headline (bilingual)"
                value={headline}
                maxLength={160}
                hint="A short line printed on the poster. Never a person's name, phone, or email."
                onChange={(e) => {
                  setHeadline(e.target.value);
                  if (settingsError) setSettingsError(null);
                }}
              />
              <FieldFeedback error={settingsError ?? undefined} role="alert" />
            </div>
          </form>

          <section className="panel agency-qr__urlcard">
            <div className="panel__head">
              <h2 className="panel__title">Unique Encoded URL</h2>
              {sheet ? <span className="agency-protected">Verified SSL Link</span> : null}
            </div>
            <div className="panel__body">
              <div className="agency-qr__urlrow">
                <code className="bb-mono">
                  {sheet ? sheet.url : "Create an invite to generate your unique link"}
                </code>
                {sheet ? (
                  <Button
                    type="button"
                    variant="secondary"
                    iconLeft="copy"
                    onClick={() => copy(sheet.url)}
                  >
                    {copied ? "Copied" : "Copy"}
                  </Button>
                ) : null}
              </div>
            </div>
          </section>

          <div className="agency-qr__generate">
            <Button
              type="button"
              variant="primary"
              block
              disabled={pending}
              loading={pending}
              iconLeft="qr-code"
              onClick={handleCreate}
            >
              {pending ? "Creating…" : sheet ? "Generate Another QR Invite" : "Generate QR Invite"}
            </Button>
            <p className="agency-qr__subnote">
              Generating a new code creates a separate tracking code in your candidate hub.
            </p>
          </div>

          <div aria-live="polite" className="agency-invite__status">
            {error ? <InlineNotice tone="danger">{error}</InlineNotice> : null}
            {!error && sheet ? (
              <p className="agency-section__sub">
                QR invite created. It encodes <span className="bb-mono">{sheet.url}</span> — check
                that address is right, then use the &ldquo;Print this sheet&rdquo; button below.
              </p>
            ) : null}
          </div>
        </div>

        <aside className="agency-qr__rail">
          <div className="agency-qr__railhead">
            <span>Live Poster Preview</span>
            {sheet ? (
              <span className="agency-qr__livedot">
                <span aria-hidden="true" /> Live
              </span>
            ) : null}
          </div>

          <div className="agency-qr__sheet">
            <div className="agency-qr__layout">
              <div className="agency-qr__postertop">BadaBhai Verified Desk</div>
              <p className="agency-qr__headline">{posterHeadline}</p>
              <div className="agency-qr__frame">
                {sheet ? (
                  <QRCodeSVG
                    className="agency-qr__code"
                    value={sheet.url}
                    size={240}
                    level="Q"
                    marginSize={4}
                    title="Scan to install BadaBhai and join"
                  />
                ) : (
                  <div className="agency-qr__placeholder" aria-hidden="true">
                    <Icon name="qr-code" />
                  </div>
                )}
              </div>
              <p className="agency-qr__caption">
                Scan to install BadaBhai — apna profile banaiye, bilkul free
              </p>
              <p className="agency-qr__link bb-mono">
                {sheet ? sheet.url : "Your unique link appears here"}
              </p>
              <div className="agency-qr__benefits">
                <div>
                  <strong>1. कमाई</strong>
                  <span>Direct Work</span>
                </div>
                <div>
                  <strong>2. सुरक्षा</strong>
                  <span>Verified Employer</span>
                </div>
                <div>
                  <strong>3. सम्मान</strong>
                  <span>Skill Recognition</span>
                </div>
              </div>
              <p className="agency-qr__authorized">
                Authorized by: BadaBhai Verified Network
              </p>
            </div>
          </div>

          <div className="agency-qr__actions">
            <Button
              type="button"
              variant="secondary"
              iconLeft="printer"
              onClick={print}
              disabled={!sheet}
            >
              Print Poster (A4/A5)
            </Button>
            <Button
              type="button"
              variant="secondary"
              iconLeft="download-simple"
              onClick={downloadPng}
              disabled={!sheet}
            >
              Download PNG
            </Button>
            {sheet ? (
              <a
                className="bb-btn bb-btn--secondary"
                href={whatsAppShareUrl(inviteShareMessage(sheet.url))}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Icon name="whatsapp-logo" />
                <span>WhatsApp</span>
              </a>
            ) : null}
          </div>
          <p className="agency-qr__consent">
            <Icon name="lock-key" /> Worker self-onboarding with OTP consent
          </p>
        </aside>
      </div>

      {/*
        THE OFF-SCREEN TWIN. Same `value` as the printed SVG, rendered large so the saved PNG
        stays sharp in a flyer. `display:none` keeps it off both the screen and the paper.
      */}
      {sheet ? (
        <QRCodeCanvas
          ref={canvasRef}
          value={sheet.url}
          size={1024}
          level="Q"
          marginSize={4}
          style={{ display: "none" }}
          aria-hidden="true"
        />
      ) : null}
    </section>
  );
}
