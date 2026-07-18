# BadaBhai · Payer App (Company + Agency) — Flutter build kit

One **role-aware mobile app** for the paying side of BadaBhai. The account type is
chosen **once at login** (Company *or* Agency) and fixes the whole session — there is
**no in-app role switch**. Theme is the locked **Desi Vernacular Pop** (same as the
worker app): vermilion + green + saffron, Baloo 2 + Mukta + Roboto Mono.

---

## How to use this kit (simple steps)

1. **Drop this whole folder** into your design system, e.g.
   `BadaBhai Design System/ui_kits/payer-app/`.
2. **To see it:** open `BadaBhai Payer App.dc.html` in a browser (it needs internet for
   fonts/icons; the design-system CSS + bundle are inside `bb_ds/`). Click through it —
   login → home → candidates → unlock → reveal, plus jobs, post, credits, and the agency
   Earn/Supply screens.
3. **To build it in Flutter with Claude:** open Claude, attach this folder, and say:
   > "Build this BadaBhai Payer App as a Flutter app. Use the theme tokens in
   > `bb_ds/tokens/*.css` for my Flutter `ThemeData`, and match the screens and flow in
   > `BadaBhai Payer App.dc.html` and this README. One login per session — Company **or**
   > Agency, no in-app role switch."

That's it. Claude reads the screens + tokens and writes the Flutter code.

---

## The session model (important)

- **Login** → pick **Company** *or* **Agency**, then phone + OTP.
- The chosen type is the session. The home header shows *who you are*
  (e.g. "Kalyani Industries · Company account" or "Apex Staffing · Agency · supply + demand").
- **Company** session = demand only (hire).
- **Agency** session = demand **+** an extra **Earn / Supply** surface (a 5th bottom-nav
  tab "Earn"; the home screen adds an Earn summary card above the Hire metrics).

## Screens

**Shared (both account types)**
1. **Login** — Company/Agency picker, phone + OTP, DPDP trust line.
2. **Home** — header identity; (agency only) Earn·Supply summary; Hire·Demand hero stat
   "Paid unlocks this week", repeat-unlock rate, credit balance, active jobs, candidates;
   quick actions; recent activity.
3. **Candidates (masked)** — relevance-sorted faceless cards: blurred name + silhouette,
   trade · skill, experience, city, availability, a **soft** "Strong fit / Good fit" label
   (never a numeric score), a "Hot" badge on a minority, **Unlock contact · ₹40**.
   Never shows gender/age/caste/religion or any demographic field.
4. **Unlock confirm** — dialog: spend 1 credit (₹40), shows balance + fair-use cap note.
5. **Revealed profile** — real name, phone, AI branded resume (download), WhatsApp contact.
6. **My jobs** — status pills (Active / Quota reached / In review), quota progress,
   verified + boost state, applicants/unlocks, top-up/boost actions.
7. **Post a job** — title, trade, location, vacancy band, salary, experience, skills;
   **verification gate** ("confirm this is a real, open role"); free posting; boost toggle.
8. **Buy credits** — packs 50 / 200 / 1,000 (1,000 carries a real discount) + unlock ledger.
9. **Account** — profile, billing, privacy/DPDP, sign out.

**Agency only — Supply**
10. **Earn hub (Mitra-Leader)** — earnings summary + links to the four supply screens.
11. **Referral hub** — shareable link + QR; "how earning works" (introduce → profiled →
    anyone unlocks within 90 days → you earn 25%).
12. **Referred workers** — masked worker rows, attribution status, 90-day window countdown
    (no resets), earnings per worker; expired rows are dimmed.
13. **Earnings & payouts** — total + this-month earned, pending payout vs ₹500 minimum,
    payout history.
14. **KYC** — PAN + bank details, status indicator (Not started / In review / Verified).

## Theme tokens (for Flutter `ThemeData`)

All values live in `bb_ds/tokens/*.css`. Key ones:

- **Vermilion** `#E0371C` — brand (logo, primary brand buttons).
- **Green** `#0E7A4F` — action / verified / money (Apply, success, ₹).
- **Saffron** `#F29D10` — warmth; used for the Agency **Earn/Supply** surfaces.
- **Ink** `#2A1A0E` text · **Cream** `#FFF6E8` page · white cards.
- **Type** — Baloo 2 (display/headlines/buttons), Mukta (body, Hinglish/Devanagari),
  Roboto Mono (numbers, ₹, OTP, IDs).
- Touch targets ≥ 48px; primary CTA 52–54px; body never below 16px.

## Flutter notes

- Material 3, **skinned to these tokens** (don't ship default Material colors).
- Phone + OTP auth; one account type per session (gate Supply screens behind agency).
- Masking is a payer pattern: candidates stay masked until a paid ₹40 unlock.
- Relevance **sorts** the candidate feed — it never blocks, and money never changes a
  worker's ranking. Show a soft fit label, never a percentage.
- Bundle Baloo 2 + Mukta with Devanagari; Roboto Mono ships in `bb_ds/assets/fonts/`.

## Files

- `BadaBhai Payer App.dc.html` — the clickable app (all screens + logic).
- `support.js` — runtime needed to open the `.dc.html` in a browser.
- `bb_ds/` — the BadaBhai design system slice it uses (tokens, component CSS, bundle,
  fonts, logo).
