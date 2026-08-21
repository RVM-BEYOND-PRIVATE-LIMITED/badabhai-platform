# Worker App — Screen-Flow Wireframes

> Status: **Draft for review** · Due 2026-06-14 · Scope: Phase-1 worker app
> (Flutter, Android-first, chat-first, low-literacy users).
> These are **low-fidelity ASCII wireframes** to align on flow + content before
> visual design. They are not final UI.

Companion to the built screens in
[`apps/worker-app/lib/features`](../../apps/worker-app/lib/features) (splash →
auth → consent → chat → profile → resume). Two screens are called out in this
round: **Resume display** and **Interview-kit download**.

## Design principles (low-literacy, India, blue/grey-collar)

- **Chat-first + voice-first.** Every text input has a 🎤 voice alternative.
- **Big tap targets, few choices per screen, strong icons + colour.**
- **Worker's language** (Hindi/regional) throughout; simple words, no jargon.
- **Offline-tolerant**: steps resume where left off; actions buffer + flush.
- **Trust + consent are explicit** (DPDP) before any profiling.
- **No PII shown that we don't need**; the resume shows only name + profile.

## End-to-end flow

```
 ┌─────────┐   ┌──────────┐   ┌───────────┐   ┌──────────────┐
 │ Splash  │──▶│  Phone   │──▶│   OTP     │──▶│   Consent    │
 │         │   │  login   │   │  verify   │   │   (DPDP)     │
 └─────────┘   └──────────┘   └───────────┘   └──────┬───────┘
                                                      ▼
 ┌──────────────┐   ┌───────────────┐   ┌─────────────────────┐
 │ Resume       │◀──│ Profile       │◀──│ Chat profiling      │
 │ preview      │   │ preview +     │   │ (text + 🎤 voice)   │
 │ (display)    │   │ confirm/edit  │   │  one Q at a time    │
 └──────┬───────┘   └───────────────┘   └─────────────────────┘
        ▼
 ┌──────────────────────┐
 │ Outputs hub          │   ⇒  • Resume: view / download / share
 │ (resume + kit)       │       • Interview kit: download (NEW)
 └──────────────────────┘
```

State persists per step (`onboarding_step_completed` action) so a worker can drop
off and resume. Every important step emits a validated event (see
`@badabhai/event-schema`).

---

## 1. Splash

```
┌──────────────────────────┐
│                          │
│                          │
│        [ LOGO ]          │
│       BadaBhai           │
│   "Aapki naukri ka       │
│      bada bhai"          │
│                          │
│        ● ● ●  (loading)  │
└──────────────────────────┘
```
Auto-advances to Login (or last incomplete step if already onboarding).

## 2. Phone login

```
┌──────────────────────────┐
│ ← BadaBhai               │
│                          │
│  Apna mobile number      │
│  daaliye                 │
│                          │
│  ┌────────────────────┐  │
│  │ +91 │ 98765 43210   │  │
│  └────────────────────┘  │
│                          │
│  [   OTP bhejein   ]     │  ← large primary button
│                          │
│  🔒 Aapka number safe hai │
└──────────────────────────┘
```
Mock OTP in Phase 1 (TD2). Emits `worker.otp_requested`.

## 3. OTP verify

```
┌──────────────────────────┐
│ ← Number verify karein   │
│                          │
│  98765 43210 par bheja   │
│  gaya code daaliye       │
│                          │
│   ┌─┐ ┌─┐ ┌─┐ ┌─┐        │
│   │ │ │ │ │ │ │ │        │  ← 4-box OTP
│   └─┘ └─┘ └─┘ └─┘        │
│                          │
│  Code nahi aaya? Dubara  │
│  bhejein (00:23)         │
└──────────────────────────┘
```
Emits `worker.otp_verified` (+ `worker.created` if new).

## 4. Consent (DPDP gate)

```
┌──────────────────────────┐
│ Aapki ijaazat            │
│                          │
│ Hum aapki baat-cheet se  │
│ aapka kaam ka profile    │
│ banayenge:               │
│  ✓ Kaam ki jaankari      │
│  ✓ Resume banana         │
│  ✓ Naukri dhoondhna      │
│                          │
│ Aapka phone/naam private │
│ rahega. 🔒               │
│                          │
│ [ ✓ ] Main agree karta   │
│       hoon               │
│  [   Aage badhein   ]    │
└──────────────────────────┘
```
**Blocks all profiling/AI until accepted.** Emits `consent.accepted`. (Production
legal copy is TD/R4 — placeholder now.)

## 5. Chat profiling (core)

```
┌──────────────────────────┐
│ Bada Bhai            ⋮    │
│ ──────────────────────── │
│ ┌──────────────────────┐ │
│ │ Namaste! Aap kaunsi  │ │  ← assistant, one Q
│ │ machine chalate ho?  │ │     at a time
│ └──────────────────────┘ │
│        ┌───────────────┐ │
│        │ VMC, 4 saal se │ │  ← worker reply
│        └───────────────┘ │
│ ┌──────────────────────┐ │
│ │ Badhiya! Fanuc ya    │ │
│ │ Siemens control?     │ │
│ └──────────────────────┘ │
│ ──────────────────────── │
│ [ Type… ]          [🎤]  │  ← voice alt always present
└──────────────────────────┘
```
- One question per turn; quick-reply chips when useful.
- 🎤 → voice note → transcription (gated/mock, TD6) → same flow.
- Progress signal when enough collected (`profile.extraction_ready`).
- Emits `chat.message_received/sent`, `voice_note.uploaded`.

## 6. Profile preview + confirm/edit

```
┌──────────────────────────┐
│ Aapka profile            │
│ ──────────────────────── │
│ 👷 Role:  VMC Operator   │  ✎ │
│ 🛠  Machines: VMC        │  ✎ │
│ 🎛  Control: Fanuc       │  ✎ │
│ 📅 Experience: 4 saal    │  ✎ │
│ 📍 Location: Pune        │  ✎ │
│ 💰 Salary: ₹22,000       │  ✎ │
│ ──────────────────────── │
│ Sab sahi hai?            │
│  [  ✓ Confirm karein  ]  │
│  [  ✎ Badlaav karein  ]  │
└──────────────────────────┘
```
Each ✎ edits one field (chat or form). Confirm → `profile.confirmed`; edits emit
`action.recorded` (`profile_edited`). Triggers resume generation.

---

## 7. Resume display  ★ (this round)

The generated resume, viewed in-app, with the actions hub.

```
┌──────────────────────────┐
│ ← Aapka Resume      ⋮    │
│ ──────────────────────── │
│ ┌──────────────────────┐ │
│ │  RAMESH KUMAR        │ │  ← {{full_name}} (only PII)
│ │  VMC Operator        │ │  ← headline
│ │  Pune · 4 yrs        │ │
│ │ ──────────────────── │ │
│ │ Summary              │ │  ← scrollable rendered
│ │  Skilled VMC oper... │ │     template (classic/
│ │ Machines: VMC        │ │     modern/minimal/
│ │ Skills: Fanuc, GD&T  │ │     fallback)
│ │ ...                  │ │
│ └──────────────────────┘ │
│ ──────────────────────── │
│ Template:  ◉ Classic     │  ← template_id picker
│            ○ Modern      │     (resume registry)
│            ○ Minimal     │
│ ──────────────────────── │
│ [⬇ PDF]  [↗ Share]  [✎]  │
└──────────────────────────┘
```
- Renders one of the resume **templates** (see
  [`apps/api/src/resume/templates`](../../apps/api/src/resume/templates));
  unknown/absent selection → generic fallback.
- `[⬇ PDF]` downloads; `[↗ Share]` (WhatsApp-first); `[✎]` back to edit.
- Actions emit `resume_viewed` / `resume_downloaded` / `resume_shared`.
- Loading + empty/error states: skeleton while generating; "Resume ban raha
  hai…"; retry on failure (never a blank screen).

## 8. Interview-kit download  ★ (this round, NEW)

A downloadable prep kit for the worker's role — likely questions + simple model
answers + a checklist (what to carry, dress, reach early). Generated from the
confirmed profile.

```
┌──────────────────────────┐
│ ← Interview Kit     ⋮    │
│ ──────────────────────── │
│  🎯 VMC Operator ke liye │
│     interview taiyari    │
│ ──────────────────────── │
│  Ismein kya hai:         │
│   • 10 common sawaal +   │
│     aasaan jawaab        │
│   • Machine/■ checklist  │
│   • Kya saath le jaayein │
│   • Tips (time, dress)   │
│ ──────────────────────── │
│  Bhasha:  ◉ हिंदी ○ Eng  │
│                          │
│  [   ⬇  Kit download    ]│  ← primary, large
│  [   ↗  WhatsApp pe bhej ]│
│                          │
│  📄 PDF · ~2 pages        │
└──────────────────────────┘
```
- Language toggle (Hindi default). Download = PDF; share = WhatsApp-first.
- Empty/disabled state until the profile is confirmed ("Pehle profile confirm
  karein").
- Emits an action on download (proposed `action_type` `interview_kit_downloaded`
  — **new**, additive to `ACTION_TYPES`).

> **Scope note:** the interview-kit *generator* (content + PDF) is a **new
> feature, not yet built** — this wireframe defines the screen/flow so the
> download surface and its event can be planned. Generation will reuse the
> resume template/render layer once that lands.

---

## Cross-cutting states (apply to every screen)

| State | Treatment |
| ----- | --------- |
| Loading | Skeleton/placeholder + short Hindi status; never a blank screen. |
| Empty | Friendly prompt + the single next action. |
| Error | Plain-language message + Retry; offline writes buffer and flush. |
| Offline | Banner "Internet nahi hai — baad mein sync hoga"; flow continues where possible. |
| Accessibility | ≥48dp targets, high contrast, icon+text, voice everywhere, TalkBack labels. |

## Open questions for review

1. Interview-kit content scope + who authors the question bank per role.
2. Resume template default + whether the worker may switch post-download.
3. Where downloads live on-device + re-download/versioning UX.
4. Is the interview kit Phase-1 or fast-follow? (affects `ACTION_TYPES` change.)
