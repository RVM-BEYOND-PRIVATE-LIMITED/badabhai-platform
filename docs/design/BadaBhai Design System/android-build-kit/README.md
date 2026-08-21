# BadaBhai · Worker App — Android Build Kit

Everything your Android (Flutter) developer needs to build the **worker mobile
app**, end to end, in the locked **Desi Vernacular Pop** theme.

**Open `index.html`** — two modes (toggle top-center):
- **Interactive flow** — click through the whole app, splash → jobs.
- **All screens** — every screen at once, for a build-along reference.

---

## The flow

```
Splash + language → Phone → OTP → Consent (DPDP)
   → Chat onboarding (bada bhai) → [form pop-up] → Building → Resume ready
        ├─ Resume edit (safe fields)
        └─ Interview kit → Kit detail
   → Tabbed app:  Jobs (swipe) → Job detail / Filters → Applied
                  Resume · Profile → Settings · Alerts
```

## 17 screens
1. **Splash + language** — language first (Hindi/Marathi/Bhojpuri/English), "No test. Just talk."
2. **Phone** — number entry, +91, reassurance that the number stays private.
3. **OTP** — 4-digit, big mono cells, resend timer.
4. **Consent** — DPDP gate incl. model-training consent (compliance-locked).
5. **Chat onboarding** — bada bhai profiles the worker in Hinglish; async voice note; **form pop-up** (hybrid profiling: 1–2 prompts → pre-filled card).
6. **Building** — generating the resume (deterministic template-fill, no AI prose).
7. **Resume ready** — free branded resume, Download PDF + WhatsApp share.
8. **Resume edit** — only the safe fields the worker controls (name spelling, photo on/off, phone shown/hidden, night-shift).
9. **Interview kit** — per-trade Q&A list + interview-day checklist.
10. **Kit detail** — questions with answers, downloadable.
11. **Job feed** — swipe-to-apply (right = apply, left = skip); filter chips; vacancy-quota "spots left".
12. **Job detail** — full posting (kaam, requirements, benefits) + sticky apply.
13. **Filters** — bottom sheet: trade / distance / shift.
14. **Applied** — confirmation + application status timeline.
15. **Profile** — strength meter, verified badge, interview-kit shortcut.
16. **Settings** — language, WhatsApp alerts, notifications, privacy/consent, delete account.
17. **Alerts** — job alerts, profile-viewed, "resume ready" nudges.

Bottom nav (4 tabs): **Jobs · Resume · Profile · Alerts**.

---

## Theme — Desi Vernacular Pop (LOCKED)

Truck-art / bazaar-signage energy, made legible.

- **Vermilion** `#E0371C` — brand (logo, highlights, primary brand buttons).
- **Green** `#0E7A4F` — the **action / "go"** color: Apply, verified, ₹/money,
  consent. Primary CTAs are green with a 3D bottom-shadow press.
- **Saffron** `#F29D10` — warmth: tags, resume header, kit icons.
- **Ink** `#2A1A0E` warm brown · **Cream** `#FFF6E8` page · white cards.
- **Festive motif** — dashed-green + double-vermilion borders on hero cards
  (job card, resume header, form pop-up). Rani-pink/turquoise for tiny accents.
- **Type** — **Baloo 2** (display, headlines, buttons), **Mukta** (body, Hinglish
  + Devanagari), **Roboto Mono** (numbers, ₹, OTP, IDs).
- **Touch targets ≥ 48px**; primary CTA 54px. One idea per screen.

All values come from the design system: tokens in **`../styles.css`** →
`../tokens/*.css` (`colors.css`, `typography.css`, spacing, radii, elevation,
motion). Build a Flutter `ThemeData` from these.

## Components (production)
The reusable React primitives this app composes live in **`../components/`**
(Button, IconButton, Input, OtpInput, Chip, Badge, Avatar, Card, ProgressBar,
Switch, BottomNav, and brand ones: BadaBhaiLogo, ChatBubble, JobCard). Each has a
`.d.ts` (props) and `.prompt.md` (usage) — use them as the spec for your Flutter
widgets.

## Flutter build notes
- Material 3, but skin it to these tokens (don't ship default Material colors).
- Multilingual: bundle Baloo 2 + Mukta with Devanagari; default to the chosen
  language; keep copy short and spoken (see readme → Content Fundamentals).
- Phone + OTP auth; offline-tolerant; async voice notes ≤ 2 min (never realtime).
- Swipe gestures on the job card (right apply / left skip); each swipe is a signal.
- Masking (blurred candidates) is a **payer-web** pattern — NOT in the worker app.
- Money never tilts a worker's visibility — never imply pay-to-rank.

## Assets
- App icon: `../assets/logo/app-icon.svg` (vermilion squircle + green chat-lift).
- Fonts: Roboto Mono in `../assets/fonts/`; Baloo 2 + Mukta from Google Fonts.

## Files
`index.html` · `screens.jsx` (all 17 screens + Device/Logo/Nav) · `app.jsx`
(flow + gallery controllers) · `ui.css` (screen styling on the brand tokens).

## Caveats
Built from the product/strategy doc — no Figma or existing Flutter source was
provided, so this is a faithful interpretation, not a pixel recreation. Worker
photos are placeholder avatars (no real imagery supplied). Share either and this
snaps to exact.
