# BADA BHAI PLATFORM — COMPLETE UI ARCHITECTURAL MAP

> **Purpose:** Master checklist for brand kit and logo overhaul migration
> **Theme:** High-contrast blue and red professional theme
> **Generated:** 2026-09-12

---

## SHARED DESIGN SYSTEM FOUNDATION

All three apps share these core tokens (the "JUL31 Josh" system):

### Color Palette

| Token                         | Hex       | Role                                     |
| ----------------------------- | --------- | ---------------------------------------- |
| `haldi` / `--vermilion-500`   | `#FFC400` | Hero CTA, brand accent                   |
| `blue` / `--blue-500`         | `#123D8C` | Structure, headers, links, dark surfaces |
| `green` / `--green-500`       | `#1E7A3C` | Success, money, WhatsApp                 |
| `red` / `--red-500`           | `#C62828` | Danger only                              |
| `ink900` / `--ink-900`        | `#101828` | Primary text                             |
| `ink600` / `--ink-600`        | `#475069` | Secondary text                           |
| `ink500` / `--ink-500`        | `#667085` | Muted text                               |
| `canvas` / `--surface-page`   | `#F2F4F8` | Page background                          |
| `paper` / `--paper-0`         | `#FFFFFF` | Card surfaces                            |
| `border` / `--border-default` | `#D8DEE9` | Hairline separators                      |
| `disabled`                    | `#C5CEDF` | Disabled elements                        |
| `onBlue` / `--text-inverse`   | `#FFFFFF` | Text on blue/haldi                       |
| `onBlueMuted`                 | `#B9C8E6` | Muted text on blue                       |

### Font Families

| Family             | Role                                     | Platforms                                           |
| ------------------ | ---------------------------------------- | --------------------------------------------------- |
| **Anek / Baloo 2** | Display, headings, wordmark, buttons     | All (web: Google Fonts async; Flutter: self-hosted) |
| **Inter / Mukta**  | Body/UI (web: Inter; Flutter: Mukta)     | All                                                 |
| **Roboto Mono**    | Data: IDs, OTP, counts (tabular figures) | All                                                 |
| **Roboto**         | Multilingual fallback (Devanagari)       | All                                                 |

### Typography Scale

| Token                  | Value |
| ---------------------- | ----- |
| `--text-2xs` / `2xs`   | 11px  |
| `--text-xs` / `xs`     | 12px  |
| `--text-sm` / `sm`     | 14px  |
| `--text-base` / `base` | 16px  |
| `--text-md` / `md`     | 18px  |
| `--text-lg` / `lg`     | 20px  |
| `--text-xl` / `xl`     | 24px  |
| `--text-2xl` / `2xl`   | 30px  |
| `--text-3xl` / `3xl`   | 38px  |
| `--text-4xl` / `4xl`   | 48px  |

### Weight Tokens

| Token                | Value |
| -------------------- | ----- |
| `--weight-light`     | 300   |
| `--weight-regular`   | 400   |
| `--weight-medium`    | 500   |
| `--weight-semibold`  | 600   |
| `--weight-bold`      | 700   |
| `--weight-extrabold` | 800   |

### Spacing (4px grid)

| s0  | s1  | s2  | s3  | s4  | s5  | s6  | s7  | s8  | s9  | s10 | s11 | s12 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0   | 4   | 8   | 12  | 16  | 20  | 24  | 32  | 40  | 48  | 64  | 80  | 96  |

### Radii

| Token                | Value           |
| -------------------- | --------------- |
| `xs` / `--radius-xs` | 6px             |
| `sm` / `md` / `lg`   | 10px            |
| `xl` / `2xl`         | 12px (hard cap) |
| `chip`               | 14px            |
| `pill`               | 999px           |

### Elevation

All base shadows = `none` (JUL31 shadow ban). Only overlays例外.

---

# APPLICATION 1: WORKERS APP (Flutter)

**Location:** `apps/worker-app/`
**Entry:** `lib/main.dart` → `lib/app.dart`

---

## FEATURE: SPLASH

### SplashScreen

- **File:** `lib/features/splash/presentation/splash_screen.dart`
- **Route:** `/`
- **Function:** Brand welcome — first screen workers see
- **UI Elements:**
  - Full-screen deep-blue (`AppColors.blue`) background
  - 72x72 haldi rounded-square tile with "BB" text (Anek/Baloo 2, 30px, w800, blue)
  - "BadaBhai" wordmark (Anek/Baloo 2, 30px, w800, white)
  - "Your placement team for factory jobs" tagline (Roboto, 14px, `onBlueMuted`)
  - "No test. Just talk." promise (Anek, 20px, haldi)
  - **Get started** `BbButton` — haldi CTA, block, arrow_forward icon
- **Typography:** Anek/Baloo 2 display for headings, Roboto body for tagline
- **Styling:** Deep-blue full-bleed, centered lockup, scroll-safe

---

## FEATURE: AUTH

### PhoneLoginScreen

- **File:** `lib/features/auth/presentation/phone_login_screen.dart`
- **Route:** `/login`
- **Function:** Phone number entry for OTP login
- **UI Elements:**
  - `BbBlueHeader` — title "Enter your phone number", subtitle "We send a one-time code to log you in."
  - "MOBILE NUMBER" eyebrow label (Roboto, 12px, w700, `textMuted`)
  - `TextField` — phone input, mono font 20px, `+91` prefix, 10-digit limit
  - Lock icon + privacy text "Your number stays private..."
  - **Send OTP** `BbButton` — block, loading state
  - Error: SnackBar with danger color
- **Typography:** Mono for phone, body for privacy note

### OtpVerifyScreen

- **File:** `lib/features/auth/presentation/otp_verify_screen.dart`
- **Route:** `/otp`
- **Function:** OTP code entry with segmented cells + resend cooldown
- **UI Elements:**
  - `BbBlueHeader` — title "Enter the code", subtitle "Sent to $phone", back arrow
  - "OTP DAALEIN" eyebrow label
  - 6-segment OTP row: underline cells (active=blue, filled=strong, empty=disabled)
  - Hidden `TextField` for keyboard/autofill/paste
  - **Verify** `BbButton` — block, loading
  - **Resend** TextButton with refresh icon + cooldown text "Naya code Xs mein"
  - Pending-deletion `AlertDialog`
- **Typography:** Mono 24px bold for OTP cells

### EnterPinScreen

- **File:** `lib/features/auth/presentation/enter_pin_screen.dart`
- **Route:** `/pin`
- **Function:** PIN unlock screen (cold start / re-lock)
- **UI Elements:**
  - `BbBlueHeader` — title "PIN daalein"
  - `BbPinView` — 4-dot masked PIN display (error=crimson flash)
  - `BbSpinner` — loading
  - `BbPinKeypad` — numeric keypad (0-9, backspace)
  - "PIN bhool gaye?" link (Roboto, w700, blue)
  - Error: `showBbAlert` dialog

### SetPinScreen

- **File:** `lib/features/auth/presentation/set_pin_screen.dart`
- **Route:** `/pin/set`
- **Function:** Set/reset PIN with enter + confirm rows
- **UI Elements:**
  - `BbBlueHeader` — title per new user vs reset
  - `BbSetPinForm` — two PIN input rows (enter + confirm), OS keyboard
  - Error: `showBbAlert` dialog

### ForgotPinScreen

- **File:** `lib/features/auth/presentation/forgot_pin_screen.dart`
- **Route:** `/pin/forgot`
- **Function:** 3-phase PIN reset: phone → OTP → new PIN
- **UI Elements:**
  - `BbBlueHeader` — title/subtitle per phase
  - Phase 1: phone field + Send OTP button
  - Phase 2: OTP field (mono, 30px, w700) + "Aage badhein" button
  - Phase 3: `BbSetPinForm` (enter + confirm)
  - SMS auto-fill
  - Errors: `showBbAlert` dialogs

### DevicesScreen

- **File:** `lib/features/auth/presentation/devices_screen.dart`
- **Route:** `/profile/settings/devices`
- **Function:** My-devices list with revoke + logout-all
- **UI Elements:**
  - `BbBlueHeader` — title "Aapke devices", back arrow
  - `ListView` of device tiles (icon + label + last seen + "Hatayein")
  - Current device: blue icon, "Yeh phone" green label
  - Other devices: muted icon, "Hatayein" (danger TextButton)
  - **Sabhi devices se logout** `BbButton` — danger, block, logout icon
  - Confirmation `AlertDialog`

---

## FEATURE: CONSENT

### ConsentScreen

- **File:** `lib/features/consent/presentation/consent_screen.dart`
- **Route:** `/consent`
- **Function:** DPDP voice consent gate
- **UI Elements:**
  - `BbBlueHeader` — title "Your privacy"
  - 56x56 trust icon: blue tinted container + `verified_user_outlined`
  - White card with consent statement + bullet list
  - Checkbox row: "I agree" (blue checkbox, body text)
  - **Continue** `BbButton` — block, haldi, arrow_forward, pinned bottom
  - Error: inline red text with error icon

---

## FEATURE: NAME

### NameScreen

- **File:** `lib/features/name/presentation/name_screen.dart`
- **Route:** `/name`
- **Function:** Capture worker's name + coarse location
- **UI Elements:**
  - Full-bleed deep-blue header: "Aapka naam?" (haldi), subtitle (onBlueMuted)
  - "PEHLA NAAM" / "AAKHRI NAAM" eyebrow labels
  - Two `TextField` inputs for first/last name (body md, paper fill)
  - "SHEHER AUR STATE" section:
    - **Location se bharein** button — outline, location icon
    - City + State `TextField` inputs
    - GPS confirmation/error text
  - **Continue** `BbButton` — block, haldi
  - Location prompt `AlertDialog`

---

## FEATURE: CHAT (AI Profiling Interview)

### ChatProfilingScreen

- **File:** `lib/features/chat/presentation/chat_profiling_screen.dart`
- **Route:** `/chat` (onboarding) and `/bada-bhai` (persistent tab)
- **Function:** AI profiling chat — the heart of the app
- **UI Elements:**
  - **AppBar:** Deep-blue, haldi "BB" avatar (32x32, rounded), "Bada Bhai" title (sm, w700), "online" subtitle (2xs, green300), "Feedback" button
  - **OIE Header:** `BbProgressBar` + occupation pill
  - **Chat ListView:** `BbChatBubble` items (worker=right/blue, bot=left/paper)
  - **Speaker button:** volume_up icon on bot bubbles (blue, 48px tap)
  - **Unread pill:** "Naye message" centered
  - **Composer bar:**
    - Text field: body sm, canvas fill, md radius, blue focus
    - Trailing: mic (blue) when empty, send (blue) when text
    - `DictationBar`: full-width waveform while listening
  - **Answer affordance:** Chips/tips/options for tap-to-answer
  - **CTA:** "Ho gaya — meri profile banaiye" (haldi) or "Thodi aur baat karein"
  - **Form offer card:** Server handover card with haldi border
  - Error: inline notices, retry
- **Typography:** Body sm for bubbles, display for headings, eyebrow for OIE
- **Styling:** Chat bubbles md radius, worker=blueChatOut, bot=paper

---

## FEATURE: VOICE (Server-Side Voice Note)

### VoiceNoteScreen

- **File:** `lib/features/voice/presentation/voice_note_screen.dart`
- **Route:** `/voice`
- **Function:** Voice note capture + confirm
- **UI Elements:**
  - `BbScaffold` with `BbAppBar` (title "Voice note")
  - **Idle:** Large haldi circle mic button (96px), heading "Bol kar batayein", body text
  - **Recording:** Circular progress (danger), red pulse dot, mono clock "0:00 / 2:00", Send + Cancel
  - **Confirm:** Transcript in own bubble + "Yeh theek hai?" + chips (Haan / Sudhaarna hai)
  - **Correction panel:** TextField + Re-record
  - **Processing:** Captioned spinner
  - **Error:** Status view with retry + type-instead

---

## FEATURE: VOICE FORM (Voice Profiling Form)

### VoiceFormEntryChooser

- **File:** `lib/features/voice_form/presentation/voice_form_entry_chooser.dart`
- **Function:** Choose between voice Q&A and chat profiling
- **UI Elements:**
  - `BbScaffold` with `BbAppBar` (title "Profile kaise banayein")
  - Intro text
  - **Two cards** (radius 16, ink200 border):
    - "Sawaal-jawaab" (record_voice_over_outlined, blue) — voice Q&A
    - "Khul kar baat" (chat_bubble_outline, blue) — chat profiling
  - "Baad mein badal sakte hain" footer note (xs, muted)

### PreflightScreen

- **File:** `lib/features/voice_form/presentation/preflight_screen.dart`
- **Function:** Mic permission + room noise calibration + upload probe
- **UI Elements:**
  - `BbScaffold` with `BbAppBar` (title "Awaaz jaanch")
  - Loading: `BbStatusView.loading()` with captions
  - Permission denied: mic_off icon (danger), retry + back
  - Voice unavailable (503): cloud_off (muted), back
  - Consent required (403): verified_user (warning), consent button
  - Session expired (401): lock (warning), login button
  - **Ready verdicts:**
    - Quiet: check_circle (success), "Shuru karein" haldi CTA
    - Loud: graphic_eq (warning), "Phir bhi shuru karein"
    - Very Loud: "Kaafi shor hai"
    - Mic Dead: "Mic se awaaz nahi aa rahi"

### VoiceFormScreen

- **File:** `lib/features/voice_form/presentation/voice_form_screen.dart`
- **Function:** One-question-at-a-time voice interview with dot-rail progress
- **UI Elements:**
  - `BbScaffold` with `BbAppBar` (title "Aapka profile")
  - Loading: `BbStatusView.loading()`
  - **Asking state:**
    - `VoiceDotRail` — progress dots (blue=filled, ink200=empty)
    - Question prompt (display xl) + speaker replay button (volume_up, blue, 48px)
    - "Yeh kyun poochh rahe hain" expandable (info_outline, blue)
    - `VoiceChoiceChips` for choice questions
    - **Mic state row:** circle dot (danger/listening, ink300/not) + label + `VoiceLevelMeter`
    - **Actions:** "Aage badhein" (primary) + "Phir se bolein" (outline)
    - "Nahi pata" (ghost) below
    - "Mic sirf jawaab ke waqt chalu hota hai" footnote (xs, muted)
  - **Correction:** Chip picker bottom sheet / Typing AlertDialog / Voice AlertDialog
  - **Error:** `BbStatusView` + "Phir se bolein"

### VoiceReviewScreen

- **File:** `lib/features/voice_form/presentation/voice_review_screen.dart`
- **Function:** Review all answers before submitting
- **UI Elements:**
  - `BbScaffold` with `BbAppBar` (title "Ek baar dekh lein")
  - `ListView` of review rows:
    - Field label (xs, muted) + value (body 16px, w600; mono for numeric)
    - "Nahi bataya" when declined (muted, w500)
    - Replay button (volume_up, blue, 22px, 48px tap)
    - Correct button (replay icon, secondary, 48px tap)
  - **Correction bottom sheet** (VoiceCorrectionSheet):
    - "Kaise theek karein" header (display 18px)
    - Chip se chunein / Dobara bolein / Type karke likhein
  - **Bottom bar:**
    - Normal: "Sab theek hai" haldi CTA, loading
    - Draining: disabled submit + "Baad mein bhejein"

---

## FEATURE: PROFILE (Onboarding Preview)

### ProfilePreviewScreen

- **File:** `lib/features/profile/presentation/profile_preview_screen.dart`
- **Route:** `/profiling`
- **Function:** Confirm extracted profile before resume generation
- **UI Elements:**
  - `BbScaffold` with `BbAppBar` (title "Your profile")
  - **Extracting:** CircularProgressIndicator + "Bada Bhai is preparing..."
  - **Ready:** "Yeh sahi hai?" heading (blue display), white card with `_ConfirmRow` items
  - Bottom bar: **Badlo** (outline) + **Haan, sahi hai** (haldi, loading)
  - **Failed:** Status view with retry + back-to-chat
  - **Draft:** Status view with "Thodi aur detail chahiye"

---

## FEATURE: FINISHING (Work History Wizard)

### FinishingScreen

- **File:** `lib/features/finishing/presentation/finishing_screen.dart`
- **Route:** `/finishing`
- **Function:** Multi-page wizard for work history + preferences (8 pages)
- **UI Elements:**
  - `BbBlueHeader` — per-page title/subtitle, back arrow
  - `VoiceDotRail` — page progress dots
  - **8 pages:** Languages, Documents, Shift & Type, Cities, Salary, Education, Education Detail, Work History
  - Chips: `BbChip` for multi/single select
  - Text fields: `FinishingTextField` for cities, year, institute
  - `EmployerCard` for work history entries
  - Toggles: `BbToggle` for relocate/accommodation
  - **Bottom bar:** "Aage badhein" or "Ho gaya" button

---

## FEATURE: TRADE FORM (Server-Driven Trade Questions)

### TradeFormScreen

- **File:** `lib/features/trade_form/presentation/trade_form_screen.dart`
- **Route:** `/trade-form`
- **Function:** Trade-specific form wizard (server-driven)
- **UI Elements:**
  - `BbBlueHeader` — per-step title, back arrow
  - `TradeFormProgressBar` — linear progress
  - Question steps: chips, boolean, or text input
  - Marker steps: Preferences/Employment/Qualifications
  - Error: red MaterialBanner
  - **Bottom bar:** "Aage badhein" (navy) or "Ho gaya" (green success)

---

## FEATURE: RESUME

### BuildingScreen

- **File:** `lib/features/resume/presentation/building_screen.dart`
- **Route:** `/building`
- **Function:** Resume generation progress animation
- **UI Elements:**
  - Full-bleed deep-blue background
  - "Resume ban raha hai..." title (white, Anek xl, w800)
  - Determinate `LinearProgressIndicator` (haldi on translucent track)
  - Step label: "STEP N/3" (haldi, xs, w600)
  - Checklist card: translucent blue container with check marks

### ResumePreviewScreen

- **File:** `lib/features/resume/presentation/resume_preview_screen.dart`
- **Route:** `/resume`
- **Function:** Resume tab root — shows generated resume
- **UI Elements:**
  - `BbAppBar` — title "Your resume", `BbAlertsAction` bell, `BbChatAction`
  - **Ready state:**
    - Blue banner: "Resume taiyaar haldi + checkmark" + `BbSuccessStamp`
    - Artifact card: haldi 4px top rail + `ResumePhotoHeader` + resume sections
    - **Download PDF** — navy variant
    - **WhatsApp pe bhejein** — green variant
    - **Edit resume** — ghost variant
    - "Naam / photo / phone aap control karte hain" note
  - **No Profile / Failed:** icon + guide or retry

### ResumeEditScreen

- **File:** `lib/features/resume/presentation/resume_edit_screen.dart`
- **Route:** `/resume/edit`
- **Function:** Edit safe fields (name, photo, toggles)
- **UI Elements:**
  - `BbScaffold` with `BbAppBar` (title "Aap control karte hain")
  - White card with hairline dividers:
    - **Name row:** label + value + edit icon → `_NameDialog`
    - **Photo row:** thumbnail (CircleAvatar) + add/edit icon
    - **Photo dikhayein** toggle: `BbToggle`
    - **Night shift ke liye taiyaar** toggle: `BbToggle`
  - **Save karein** `BbButton` — haldi, block, check icon

---

## FEATURE: SWIPE (Jobs Feed)

### SwipeJobsScreen

- **File:** `lib/features/swipe/presentation/swipe_jobs_screen.dart`
- **Route:** `/jobs`
- **Function:** Jobs tab — dual-mode feed (list + swipe deck)
- **UI Elements:**
  - **Deep-blue header:** "Kaam milega." (haldi, Anek xl, w800) + job count (2xs, onBlueMuted)
  - `BbAlertsAction` bell + list/deck toggle icon + filter icon (active dot)
  - **Search bar:** Paper pill, "Job title ya city se dhoondein", search icon
  - **Filter search:** `BbSearchField` + suggestion chips + active removable chips
  - **List mode:** `ListView.builder` of `BbJobCard` items (green "APPLY ->")
  - **Deck mode:** `JobDeck` swipe cards (swipe right=apply, left=skip)
  - `BbSuccessStamp` overlay on apply
  - States: loading, error, empty, no-match, consent-required

### JobDetailScreen

- **File:** `lib/features/swipe/presentation/job_detail_screen.dart`
- **Route:** `/jobs/detail/:jobId`
- **Function:** Full job posting detail
- **UI Elements:**
  - `BbAppBar` (empty title)
  - **White header band:** Job title (Anek xl, w800) + salary (Anek 30px, w800)
  - **Meta row:** Place/Shift/Experience/Needed-by with icons (xs, secondary)
  - **Sections:** "KAAM KE BAARE MEIN", "ZAROORI SKILLS" (`BbTag` chips), "BENEFITS" (green check)
  - **Sticky CTA:** Close button (circle, border) + **Apply karein** (haldi, check icon)
  - Applied status: green tinted card + checkmark

---

## FEATURE: JOB SEARCH

### JobSearchScreen

- **File:** `lib/features/job_search/presentation/job_search_screen.dart`
- **Route:** `/jobs/search`
- **Function:** Indeed-style job search
- **UI Elements:**
  - `SliverAppBar` (floating, snap) — deep-blue, "Jobs dhoondein"
  - Two search fields: "Job title ya skill" + "City, State" (paper fill, md radius, blue focus)
  - **Search** `BbButton` — haldi, block, search icon
  - Results: `SliverList` of `BbJobCard` items
  - Infinite scroll pagination
  - States: idle, loading, error, empty, results

---

## FEATURE: PROFILE TAB

### ProfileTabScreen

- **File:** `lib/features/profile_tab/presentation/profile_tab_screen.dart`
- **Route:** `/profile`
- **Function:** Profile tab — worker's identity + shortcuts
- **UI Elements:**
  - **Deep-blue header:** "Profile" title (Anek lg, w800, onBlue) + `BbAlertsAction` + `BbChatAction` + Settings gear
  - **Identity row:** `ProfileAvatar` (photo/initials) + name/trade/city + `BbVerifiedBadge`
  - **Strength card:** `ProfileStrengthCard`
  - **Skills card:** experience, education, skills, machines
  - **Shortcuts card:** Interview kit + Applied jobs + Invite (optional)
  - **Logout** — danger variant

---

## FEATURE: SETTINGS

### SettingsScreen

- **File:** `lib/features/settings/presentation/settings_screen.dart`
- **Route:** `/profile/settings`
- **Function:** App settings
- **UI Elements:**
  - `BbScaffold` with `BbAppBar` (title "Settings")
  - **Group 1:** Invite (optional), WhatsApp alerts, Notifications toggle
  - **Group 2:** Devices, Privacy & data, Withdraw consent
  - **Version footer:** "BadaBhai v1.0 build X Made in India" (xs, faint)
  - Rows: `BbListRow.setting()` (icon + title + subtitle)
  - Notification toggle: `BbListRow.toggle()` with slide switch
  - Consent withdrawal: danger row + confirm dialog
  - Delete OTP dialog: AlertDialog with countdown + resend

---

## FEATURE: NOTIFICATIONS

### NotificationsScreen

- **File:** `lib/features/notifications/presentation/notifications_screen.dart`
- **Route:** `/alerts`
- **Function:** Alerts/notifications list
- **UI Elements:**
  - **Deep-blue header:** "Alerts" (Anek xl, w800, onBlue) + back arrow + "Aapke saare updates" (xs, onBlueMuted)
  - `SliverList.builder` inside `DecoratedSliver` (white card, lg radius, border)
  - `BbListRow.notification()` rows: icon + tone-colored tile + title + subtitle + time
  - Unread: small haldi dot in left gutter
  - Pull-to-refresh
  - Empty: "Abhi koi alert nahi"

---

## FEATURE: APPLICATIONS

### AppliedJobsScreen

- **File:** `lib/features/applications/presentation/applied_jobs_screen.dart`
- **Route:** `/profile/applied`
- **Function:** Worker's applied jobs list
- **UI Elements:**
  - `BbScaffold` with `BbAppBar` (title "Applied jobs")
  - **Green success header:** Check stamp + "Aapki applications" + count (green bg)
  - **AB KYA HOGA card:** White card with 3-step process
  - **Application cards:** `BbJobCard` items

---

## FEATURE: KIT (Interview Preparation)

### KitScreen

- **File:** `lib/features/kit/presentation/kit_screen.dart`
- **Route:** `/profile/kit`
- **Function:** Interview preparation kit list
- **UI Elements:**
  - `BbAppBar` (title "Interview kit")
  - Intro text (textSecondary)
  - **Grouped card:** White card (lg radius, borderSubtle) with hairline dividers
  - `BbListRow.kit()` per trade: build_outlined icon (saffron100 bg, saffron700), title (display base w700), subtitle (body sm, muted)
  - **Coming-soon stub:** "Interview din ki checklist" — shows "Jald aa raha hai" snackbar
  - Empty / Error states

### KitDetailScreen

- **File:** `lib/features/kit/presentation/kit_detail_screen.dart`
- **Route:** `/profile/kit/detail/:tradeKey`
- **Function:** Full interview kit — numbered Q&A + checklists + download
- **UI Elements:**
  - `BbAppBar` (title = kit title) + download PDF action
  - **Overview card:** White card with overview text
  - **4 question sections** (white card, lg radius):
    - "Aam sawaal", "Practical sawaal", "Safety sawaal", "Drawing aur measurement"
    - Numbered list: "1. question text"
  - **4 list sections** (icon-bulleted):
    - Skill checklist, Interview se pehle dohraayein, Documents saath le jaayein, Aam galtiyan
  - **Hinglish note:** Green tinted card with lightbulb
  - **Download PDF:** resolves signed URL, in-app download, SnackBar with "Kholein" action

---

## FEATURE: FEEDBACK

### FeedbackScreen

- **File:** `lib/features/feedback/presentation/feedback_screen.dart`
- **Route:** `/feedback`
- **Function:** App-wide feedback submission
- **UI Elements:**
  - `BbScaffold` with `BbAppBar` (title "Feedback")
  - **AAPKI BAAT** eyebrow label
  - Message box: multi-line TextField (paper fill, sm radius), mic/stop inside field
  - Listening strip: waveform + "Sun rahe hain..." (blue tint bg)
  - Voice control: mic (blue) / stop (secondary)
  - Character counter (near ceiling)
  - **KIS BAARE MEIN?** chips: category tags
  - **PHOTO (OPTIONAL)** section: add photo + thumbnail strip
  - **Bhejein** `BbButton` — haldi, block, send icon

---

## FEATURE: INVITE

### InviteScreen

- **File:** `lib/features/invite/presentation/invite_screen.dart`
- **Route:** `/invite`
- **Function:** Referral invite sharing
- **UI Elements:**
  - **Deep-blue header:** "Dost ko invite karein" (Anek xl, w800, onBlue)
  - Circle icon: saffron50 bg + group_add icon
  - Heading: "Apne dost ko BadaBhai par bulao"
  - **Link chip:** Paper pill with link icon + URL (mono sm) + copy button
  - **Link share karein** — haldi, block, share icon
  - **WhatsApp pe bhejein** — green variant, block, chat icon

---

## SHARED WIDGETS (core/widgets/)

| Widget             | File                      | Purpose                          | Key Styling                                                                   |
| ------------------ | ------------------------- | -------------------------------- | ----------------------------------------------------------------------------- |
| `BbButton`         | `bb_button.dart`          | THE reusable button (8 variants) | Anek label, elevation 0, `AppRadii.sm`, haldi primary                         |
| `BbBlueHeader`     | `bb_blue_header.dart`     | Full-bleed deep-blue header      | Status bar inset + gutter, haldi title, muted subtitle                        |
| `BbBottomNav`      | `bb_bottom_nav.dart`      | 4-tab bottom nav                 | White paper, hairline top, haldi active indicator, labels always visible      |
| `BbScaffold`       | `bb_scaffold.dart`        | Standard page shell              | Cream bg, safe area, gutter padding                                           |
| `BbLogo`           | `bb_logo.dart`            | Brand mark                       | CustomPainter (drawn), deep-blue squircle + white chat bubble + green chevron |
| `BbAppBar`         | `bb_app_bar.dart`         | Standard app bar                 | Light (themed) or Dark (deep-blue, white title/icons)                         |
| `BbChatBubble`     | `bb_chat_bubble.dart`     | Chat message bubble              | worker=blueChatOut/white text/bot=paper/hairline; max width 78%               |
| `BbJobCard`        | `bb_job_card.dart`        | Job posting card                 | White, sm radius, borderSubtle, haldi left rail (hot), green "APPLY ->"       |
| `BbChip`           | `bb_chip.dart`            | Selectable chip                  | Selected=haldi fill+blue label; unselected=white+border; radius 14px          |
| `BbTag`            | `bb_tag.dart`             | Small saffron pill               | saffron100 bg, pill radius, xs w700, saffron700                               |
| `BbStatusView`     | `bb_status_view.dart`     | Empty/error/loading states       | 48px icon + display md title + body subtitle                                  |
| `BbSuccessStamp`   | `bb_success_stamp.dart`   | Animated green seal              | Scale 0.3→1.0, AppMotion.stamp overshoot                                      |
| `BbVerifiedBadge`  | `bb_verified_badge.dart`  | Inline "Verified" pill           | successTint bg, verified icon + "Verified" sm w700                            |
| `BbProgressBar`    | `bb_progress_bar.dart`    | Slim pill progress               | 12px height, surfaceInset track, success green fill                           |
| `BbListRow`        | `bb_list_row.dart`        | List row family (4 constructors) | `.setting()`, `.toggle()`, `.notification()`, `.status()`, `.kit()`           |
| `VoiceDotRail`     | `voice_dot_rail.dart`     | Progress dots                    | 10px circles, blue=filled, ink200=empty                                       |
| `VoiceLevelMeter`  | `voice_level_meter.dart`  | 5-bar audio meter                | blue when lit, ink200 when silent, animated 90ms                              |
| `VoiceChoiceChips` | `voice_choice_chips.dart` | Choice chips for voice           | Boolean, single-select, multi-select                                          |

---

# APPLICATION 2: PAYERS APP (Flutter)

**Location:** `apps/payer-app/`
**Entry:** `lib/main.dart` → `lib/app.dart`
**Navigation:** `AppShell` with 5-tab bottom nav (Home/Find/Jobs/Credits/Account)

---

## FEATURE: AUTH

### LoginScreen

- **File:** `lib/features/auth/presentation/login_screen.dart`
- **Function:** Two-step email+OTP authentication with role picker
- **UI Elements:**
  - `_BrandHeader`: Full-width deep-blue (`AppColors.blue`)
    - 56x56 haldi rounded-square + `Icons.handshake` (30px, deep-blue)
    - "Hire faster, bada bhai ke saath." — Anek w800, 30px, white
    - Subtitle — Roboto 12px, `onBlueMuted` (#B9C8E6)
  - Role picker row: two `_RolePick` cards (Company/Agency)
    - Selected: brandTint bg, 2px blue border, checkmark
    - Unselected: white bg, 1px border
    - Icon (24px blue) + title (Anek w700 16px) + subtitle (Roboto 12px `textMuted`)
  - `BbField` "Company/agency name" — `Icons.apartment`
  - `BbField` "Work email" — `Icons.mail_outline`
  - `BbButton` "Get OTP" — primary (haldi), block, `Icons.arrow_forward`
  - Step 2 (animated via `BbAnimatedSwitcher`):
    - Title "Enter the code" — Anek w700 20px
    - Subtitle with email — Roboto 14px `textSecondary`
    - `BbField` "OTP code" — `Icons.lock_outline`, mono, autofillHints.oneTimeCode
    - `BbButton` "Verify & continue" — primary, block
    - `BbButton` "Change email" — ghost, block
  - `_ErrorLine`: dangerTint bg, red100 border, 16px red icon, Roboto 14px red
  - `_TrustLine`: `Icons.verified_user` 16px green + "DPDP-compliant..." Roboto 12px muted
- **Typography:** Anek for headings, Roboto body, mono for OTP
- **Styling:** Max width 440px, canvas bg, gutter/6/gutter/7 padding

---

## FEATURE: HOME (Dashboard)

### HomeScreen

- **File:** `lib/features/home/presentation/home_screen.dart`
- **Function:** Dashboard — identity header, credit balance, quick actions, agency hub
- **UI Elements:**
  - `_Header`: Deep-blue full-width, padding gutter/s5
    - `BbAvatar` (48px, initials) — haldi-tinted
    - Org name — Anek w700 18px `onBlue`
    - Plan — Roboto 12px `onBlueMuted`
    - `PayerRoleBadge` — COMPANY/AGENCY label
  - `ListView` body:
    - `_SectionLabel("OVERVIEW")` — Roboto 12px w700 uppercase `textMuted`
    - `_CreditBalanceCard` — `BbStat` (label "Credit balance", icon `lock_open`)
    - `_SectionLabel("QUICK ACTIONS")`
    - Row of two `BbButton`s:
      - "Post a job" — primary haldi, `Icons.add_circle_outline`
      - "Browse" — secondary outlined, `Icons.search`
    - (Agency only) `_AgencyHubCard`: `BbCard` with `Icons.campaign_outlined` 24px blue, "Refer & earn" title, chevron_right
- **Styling:** White cards (1px border, radius 10, elevation 0)

---

## FEATURE: FIND (Candidate Feed)

### FindScreen

- **File:** `lib/features/find/presentation/find_screen.dart`
- **Function:** Faceless real applicants or mock candidates
- **UI Elements:**
  - Eyebrow "CANDIDATES FOR {ROLE}" — Roboto 12px w700 muted
  - "Browse & unlock" — Anek w800 24px
  - "History" button — `TextButton.icon`, `Icons.history`
  - Job selector: horizontal `ListView` of `BbChip`s (selected=haldi pill)
  - Count line: RichText with bold count
  - `_ApplicantCard` (real feed):
    - `BbCard` with optional `featured` (4px haldi rail for Hot)
    - `BbAvatar` (50px, "••", masked mode)
    - Masked label — Mono w700 16px
    - `BbBadge("Hot", danger, fire, solid)`
    - Facets — Roboto 14px w600 secondary
    - Signal chips: `BbBadge` (neutral)
    - Match-tier badge: `BbBadge("Direct match", success)` or `BbBadge("Related to X", warning)`
    - Action: `BbButton("₹40", md, lock_open)` or `BbButton("View", md, chat_bubble_outline)`
    - Unlocked: green 1.5px border

### RevealScreen

- **File:** `lib/features/find/presentation/reveal_screen.dart`
- **Function:** Revealed candidate profile — MOCK (rich) and REAL (relay)
- **UI Elements:**
  - **REAL mode:**
    - Header: back + "Candidate" Anek w800 20px + `BbBadge("Unlocked", success)`
    - Identity card: 84px masked avatar, masked label Mono w800 24px, privacy notice
    - Relay card: contact relay handle (Mono w700 16px), "Contact via relay" primary button
    - Resume card: haldi-tint icon, download icon/spinner
    - `BbStampCelebration(lock_open)` overlay
  - **MOCK mode:**
    - 84px avatar with initials, real name Anek w800 24px
    - Phone pill: surfaceSunken bg, green phone icon, Mono w700 16px
    - Skills card: `BbBadge` chips
    - Resume card: "AI branded resume" w700
    - "Contact on WhatsApp" — green CTA

### DisclosureHistoryScreen

- **File:** `lib/features/find/presentation/disclosure_history_screen.dart`
- **Function:** Resume disclosure audit log (PII-free)
- **UI Elements:**
  - Header: back + "Disclosure history" Anek w800 20px
  - Loading/error/empty via `BbStatusView`
  - `ListView.separated` of `_DisclosureRow`:
    - "Worker ••{last4}" — Roboto w700 18px
    - `BbBadge(status)` — success/neutral/danger
    - "Disclosed: {date}" / "Expires: {date}"

---

## FEATURE: JOBS

### JobsScreen

- **File:** `lib/features/jobs/presentation/jobs_screen.dart`
- **Function:** My Job Postings (role-branched: Company vs Agency)
- **UI Elements (COMPANY mode):**
  - "MY JOB POSTINGS" eyebrow + "{n} jobs" Anek w800 24px + "Post" primary haldi
  - "Create with AI" — tonal sm, `Icons.auto_awesome`
  - `_ResumeChatCard`: `BbCard` with `Icons.forum_outlined` brand, "Continue your job posting", chevron_right
  - `_RealJobCard`:
    - Title — Anek w700 18px
    - `BbBadge(lifecycle)` — info/warning/neutral
    - Meta line — Roboto 14px muted
    - Verified badge: `BbBadge("Verified job", success, verified_user)`
    - Boosted badge: `BbBadge("Boosted", brand, rocket_launch)`
    - `BbProgress` bar
    - Actions per state: Publish (navy), Pause (secondary), Close (secondary), "Manage plan on web"
    - "Edit details" — secondary sm block
- **UI Elements (AGENCY mode):**
  - Same structure with `_AgencyJobCard`: title + trade label + status badge + meta + "Close" + "Edit details"

### AgencyJobsView

- **File:** `lib/features/jobs/presentation/agency_jobs_screen.dart`
- **Function:** Agency job postings (faceless demand)
- **UI Elements:**
  - "AGENCY JOB POSTINGS" eyebrow + "{n} jobs" + "Post" button
  - `_AgencyJobCard`: BbCard (dim if closed), title, trade label, status badge, meta (city/area + pay + experience), applicant count, "Close", "Edit details"

### PostJobScreen

- **File:** `lib/features/jobs/presentation/post_job_screen.dart`
- **Function:** Post a job (role-branched form)
- **UI Elements (COMPANY form):**
  - Header: back + "Post a job" Anek w800 20px + `BbBadge("Free", success)`
  - Section cards (blue Anek section titles):
    - **Company & role:** BbField(org), BbField(title), BbSelect(trade), BbField(location), chip vacancy band
    - **Pay & experience:** BbField(pay min/max), BbField(exp min/max) — number/mono
    - **Skills & matching:** `MatchSkillPicker` or free-text chips
    - Verification notice: green-tint container
  - "Post job" primary haldi CTA in `bottomNavigationBar`
  - `_AddSkillDialog`: AlertDialog with BbField
- **UI Elements (AGENCY form):**
  - Section cards: chip trade, BbField(title/city/area), chip needed-by
  - Info notice: blue-tint container
  - "Post job" CTA

### EditCompanyJobScreen

- **File:** `lib/features/jobs/presentation/edit_company_job_screen.dart`
- **Function:** Edit company posting
- **UI Elements:**
  - Header: back + "Edit job"
  - Section card: BbField(title), BbField(location), chip vacancy band
  - Note: "Pay, experience and skills are not editable here yet"
  - "Save changes" primary haldi CTA

### EditAgencyJobScreen

- **File:** `lib/features/jobs/presentation/edit_agency_job_screen.dart`
- **Function:** Edit agency posting
- **UI Elements:**
  - Header: back + "Edit job"
  - Section cards: BbField(title), chip trade, BbField(city/area), BbField(pay/exp min/max), chip needed-by
  - "Save changes" primary haldi CTA

---

## FEATURE: JOB POSTING CHAT (AI-Assisted)

### JobPostingChatScreen

- **File:** `lib/features/job_posting_chat/presentation/job_posting_chat_screen.dart`
- **Function:** AI-assisted job posting interview
- **UI Elements:**
  - Header: back + "AI job posting" Anek w800 20px + "View draft"/"Hide draft" text button (brand blue w700)
  - Session failed banner: dangerTint, `Icons.cloud_off`, Roboto 14px dangerPress
  - Chat body: `ListView` with `BbChatBubble` (payer vs AI)
  - Draft panel: `DraftPreview` embedded
  - Typing indicator: `Icons.more_horiz` 20px haldi + "Working on it..."
  - Follow-up chips: horizontal `SingleChildScrollView` of `BbChip`s
  - Input bar: TextField with chip-radius border (14px), haldi focus ring
  - Send button: blue circle (48px tap), `Icons.send_rounded` 22px white

---

## FEATURE: CREDITS

### CreditsScreen

- **File:** `lib/features/credits/presentation/credits_screen.dart`
- **Function:** Credit balance + ledger + unlock history (READ-ONLY)
- **UI Elements:**
  - Header: back + "Credits" Anek w800 20px
  - Balance card: `BbCard(ink: true)` — dark blue bg
    - "Current balance" — Roboto 14px ink300
    - Balance figure — Mono w700 30px white + "unlocks" Roboto 16px ink300
  - "Buy credits on web" — secondary sm + muted note
  - "Credit ledger" section: Anek w700 16px
  - `BbCard` ledger rows: label Roboto 14px secondary + amount Mono w700 14px (green for credit)
  - "Unlock history" section: same pattern

---

## FEATURE: ACCOUNT

### AccountScreen

- **File:** `lib/features/account/presentation/account_screen.dart`
- **Function:** Account identity + settings + sign-out
- **UI Elements:**
  - "Account" Anek w800 24px + `PayerRoleBadge`
  - `_IdentityCard`: BbCard with 54px avatar, org name Anek w700 18px, role/status
  - `_DetailsCard`: BbCard with info rows (email, phone masked, status) — Roboto w600 14px right-aligned
  - Settings card (BbCard):
    - Edit account — `Icons.edit_outlined`
    - Team — `Icons.groups_outlined`
    - Hiring capacity — `Icons.tune`
    - Refer & earn — `Icons.campaign_outlined` (agency only)
    - Privacy & DPDP consent — `Icons.verified_user_outlined`
    - Sign out — `Icons.logout`, danger red
  - `_EditSheet` (modal bottom sheet): "Edit account" Anek w800 20px, BbField(org), BbField(phone +91 mono), "Save changes" CTA
  - Confirm sign-out: `showBbConfirm` dialog

---

## FEATURE: CAPACITY

### CapacityScreen

- **File:** `lib/features/capacity/presentation/capacity_screen.dart`
- **Function:** Hiring capacity — concurrent vacancy allowance (READ-ONLY)
- **UI Elements:**
  - Header: back + "Hiring capacity" Anek w800 20px
  - `_AllowanceCard`: BbCard(ink: true) — dark blue
    - "Active vacancies in use" — Roboto 14px ink300
    - "{n} / {max}" — Mono w700 30px white
    - `LinearProgressIndicator` — pill radius, green300/warning value color
    - "{n} more vacancies available" or "Full"
  - `_DetailsCard`: BbCard with info rows — current tier badge, renews/expires

---

## FEATURE: ORG (Team)

### TeamScreen

- **File:** `lib/features/org/presentation/team_screen.dart`
- **Function:** Org members, invite/accept, owner-only remove
- **UI Elements:**
  - Header: back + "Team" Anek w800 20px
  - (Owner only) "Invite recruiter" — primary haldi, `Icons.person_add_alt`
  - "Members" Anek w700 16px
  - `BbCard` member list: `_MemberRow` — 40px avatar, masked email Mono w600 14px, "You" badge, role badge, status badge, remove button
  - "Have an invite?" section: "Accept invite" — secondary
  - `_InviteSheet`: email field + "Send invite"
  - `_AcceptSheet`: token field (mono) + "Join team"

---

## FEATURE: REFERRAL

### ReferralScreen

- **File:** `lib/features/referral/presentation/referral_screen.dart`
- **Function:** Agency Refer-and-earn hub
- **UI Elements:**
  - Header: back + "Refer & earn" Anek w800 20px
  - `_LinkCard`: BbCard with share URL (Mono w700 16px), code, "Share on WhatsApp" (green CTA), "Copy link" (secondary)
  - "Your funnel": Three columns (Invited/Clicked/Joined) — Anek w800 24px + label Roboto 12px muted
  - Privacy note
  - "Go deeper" section: "Referred workers" / "Invite in bulk" / "Earnings & payouts" — BbCard nav cards with blue icons

---

## FEATURE: AGENCY

### AgencyEngagementScreen

- **File:** `lib/features/agency/presentation/agency_engagement_screen.dart`
- **Function:** Faceless per-worker referral funnel
- **UI Elements:**
  - Header: back + "Referred workers" Anek w800 20px
  - `RefreshIndicator` + `ListView.separated`:
    - `_WorkerCard`: BbCard with 40px masked avatar, ref handle Mono w700 16px, last active text, profile badge (success/warning), `_MiniStat` row (Applied/Unlocked Mono w700 20px)

### AgencyEarningsScreen

- **File:** `lib/features/agency/presentation/agency_earnings_screen.dart`
- **Function:** Supply-money hub — earnings, KYC, payouts
- **UI Elements:**
  - Header: back + "Earnings & payouts" Anek w800 20px
  - `_RequestableCard`: BbCard with "Available to request", "₹{amount}" Anek w800 24px, "Request payout" primary haldi
  - `_TotalsRow`: Three columns (Earned/In request/Paid) — Anek w800 20px
  - "How you earn" section + `_HowItWorksCard`
  - "Manage" section: `_KycNavCard` (status badge) + "Payout history" nav card

### AgencyKycScreen

- **File:** `lib/features/agency/presentation/agency_kyc_screen.dart`
- **Function:** Submit/view masked payout KYC (PAN + bank)
- **UI Elements:**
  - Header: back + "KYC details" Anek w800 20px
  - `_StatusCard`: BbCard with status badge + masked PAN/bank Mono w700 16px
  - Form: BbField(account holder), BbField(PAN mono uppercase), BbField(bank mono digits), BbField(IFSC mono uppercase)
  - "Submit"/"Save changes" primary CTA, disabled until valid

### AgencyPayoutsScreen

- **File:** `lib/features/agency/presentation/agency_payouts_screen.dart`
- **Function:** Payout request history
- **UI Elements:**
  - Header: back + "Payout history" Anek w800 20px
  - `ListView.separated`: `_PayoutCard` — "₹{amount}" Anek w800 20px, "{n} unlocks · {date}" muted, `BbBadge(status)`

### BatchInviteScreen

- **File:** `lib/features/agency/presentation/batch_invite_screen.dart`
- **Function:** Mint batch invite codes with QR
- **UI Elements:**
  - Header: back + "Invite in bulk" Anek w800 20px
  - Form in BbCard: BbField(count mono), BbField(campaign tag), "Create invites" primary haldi
  - `_ResultsHeader`: "Ready to share ({n})" + "Copy all" ghost
  - `_InviteCard` per code: QR image (148px, `QrImageView`), code Mono w700 18px, URL muted, "Share on WhatsApp" green, "Copy link" secondary
  - `BbStampCelebration(qr_code_2)` overlay

---

## SHARED WIDGETS (core/widgets/)

| Widget               | File                        | Purpose                                                              | Key Styling                                                        |
| -------------------- | --------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `BbButton`           | `bb_button.dart`            | 8 variants (primary/brand/navy/secondary/tonal/success/ghost/danger) | Anek label, elevation 0, sm/md/lg                                  |
| `BbBottomNav`        | `bb_bottom_nav.dart`        | 5-tab bottom nav                                                     | Blue active, muted inactive                                        |
| `BbCard`             | `bb_card.dart`              | White card, 1px border, radius 10, elevation 0                       | Variants: featured (haldi rail), ink (dark blue), festive          |
| `BbAvatar`           | `bb_avatar.dart`            | Initials avatar                                                      | Modes: brand (haldi tint), masked (faceless), sealed (green check) |
| `BbBadge`            | `bb_badge.dart`             | Status chips                                                         | Tones: success/danger/warning/info/neutral/brand                   |
| `BbChip`             | `bb_chip.dart`              | Selectable chips                                                     | Selected=haldi pill                                                |
| `BbField`            | `bb_field.dart`             | Text input                                                           | Label, hint, icon, mono, keyboard type                             |
| `BbIconButton`       | `bb_icon_button.dart`       | 48px tap target                                                      |                                                                    |
| `BbStat`             | `bb_stat.dart`              | Hero stat card                                                       | Label, value, icon, delta                                          |
| `BbProgress`         | `bb_progress.dart`          | Progress bar                                                         | Label + count                                                      |
| `BbStatusView`       | `bb_status_view.dart`       | Loading/error/empty                                                  |                                                                    |
| `BbChatBubble`       | `bb_chat_bubble.dart`       | Chat bubble                                                          | Payer vs AI                                                        |
| `BbToast`            | `bb_toast.dart`             | Toast notifications                                                  |                                                                    |
| `BbAlertDialog`      | `bb_alert_dialog.dart`      | Confirm dialog                                                       |                                                                    |
| `BbUnlockDialog`     | `bb_unlock_dialog.dart`     | ₹40 unlock confirmation                                              |                                                                    |
| `BbStampCelebration` | `bb_stamp_celebration.dart` | Celebration animation                                                |                                                                    |
| `PayerRoleBadge`     | `payer_role_badge.dart`     | COMPANY/AGENCY badge                                                 |                                                                    |

---

# APPLICATION 3: PAYERS/AGENT WEB (Next.js)

**Location:** `apps/payer-web/`
**Stack:** Next.js 15.5, React 19, CSS custom properties, Phosphor Icons
**Roles:** employer (payer) and agent (agency) — nav/data/routes are role-gated

---

## GLOBAL SHELL

### Root Layout (`src/app/layout.tsx`)

- **Visual:** `<html>` with `data-theme="ink"` toggle, no-FOUC script, async Google Fonts
- **Fonts loaded:** Anek (display), Inter (body/UI), Roboto (multilingual), self-hosted Roboto Mono
- **Body:** `className="bb-theme"` + child
- **Footer:** "BadaBhai for Employers — {ENVIRONMENT} — Worker identities are masked and consent-gated."

### Portal Layout (`src/app/(portal)/layout.tsx`)

- **Auth Gate:** `requirePayer()` → redirect `/login` if no session
- **Shell** (via `AppShell`):
  - **Left Rail** (`pshell__rail`): BadaBhaiLogo (30px) + "BadaBhai" / "for Employers|Agencies", sidebar nav, whoami badge
  - **Sticky Header** (`pshell__header`): PortalBreadcrumb, balance chip, ThemeToggle, AccountMenu
  - **Content Column** (`pshell__content`): page body with entrance animation

### AppShell (`src/app/(portal)/app-shell.tsx`)

- Responsive left rail:
  - `>=1280px`: full labeled rail, collapsible to icon rail
  - `1024-1280px`: icon rail by default
  - `<1024px`: overlay drawer with hamburger + scrim

### SidebarNav (`src/app/(portal)/sidebar-nav.tsx`)

- Active route highlighting via `isNavItemActive()`
- Phosphor icons (`ph ph-{icon}`) + text labels
- Active: brand-tint bg + inset brand border-left spine
- "Coming Soon" items: `<span>` (not links)

### AccountMenu (`src/app/(portal)/account-menu.tsx`)

- Avatar trigger (org initials, 36px) with dropdown: org name (Anek display), email (mono), role/status badges, "Account settings", "Sign out"

### ThemeToggle (`src/components/ds/theme-toggle.tsx`)

- `role="switch"` — three-state cycle: paper (light) / ink (dark) / system
- Radial View Transition sweep

### Loading State (`src/app/(portal)/loading.tsx`)

- Skeleton placeholders with shimmer animation

---

## DESIGN SYSTEM COMPONENTS (`src/components/ds/`)

| Component        | Variants                                                                              | Key Styling                     |
| ---------------- | ------------------------------------------------------------------------------------- | ------------------------------- |
| **Button**       | primary (haldi bg, blue-500 text), secondary, tonal, ghost, success, danger; sm/md/lg | Phosphor icons, loading spinner |
| **IconButton**   | ghost, solid, outline                                                                 |                                 |
| **Input**        | label, hint, error, left/right Phosphor icons                                         | Error: red border + icon        |
| **Select**       | Dropdown with custom chevron                                                          |                                 |
| **Textarea**     | Multi-line                                                                            |                                 |
| **Checkbox**     | Custom styled + Phosphor check                                                        |                                 |
| **Radio**        | Custom styled + inner dot                                                             |                                 |
| **Switch**       | Toggle with thumb animation                                                           |                                 |
| **OtpInput**     | 6-digit cells, auto-advance, paste support                                            |                                 |
| **SelectMenu**   | WAI-ARIA combobox, keyboard nav, type-ahead                                           |                                 |
| **Card**         | default, raised, flat, outline, ink; pad-none/sm/md/lg; whole-card link               |                                 |
| **Badge**        | neutral, brand, success, danger, warning, info; soft/solid/outline                    |                                 |
| **StatTile**     | KPI tile with label, value (mono tabular), icon, delta                                |                                 |
| **Avatar**       | Initials fallback; brand gradient, masked blur, verified seal                         |                                 |
| **Chip**         | Selectable pill, optional icon, remove button                                         |                                 |
| **Dialog**       | Modal/bottom-sheet, focus trap, Esc, scrim-click                                      |                                 |
| **Toast**        | Dark-ink surface; success/danger/brand/neutral                                        |                                 |
| **Tabs**         | underline, segmented; WAI-ARIA, roving tabindex                                       |                                 |
| **ProgressBar**  | 0-100, brand/success tones                                                            |                                 |
| **BadaBhaiLogo** | full, mark, wordmark; brand mark SVG + Anek wordmark                                  |                                 |

---

## SCREEN-BY-SCREEN MAP

### Login (`/login`)

- **File:** `src/app/login/page.tsx` + `login-form.tsx`
- **Function:** OTP-based sign-in or account creation
- **UI Elements:**
  - `login-wrap` centered, `ThemeToggle` (top-right)
  - `login-card` (max-width 440px):
    - `BadaBhaiLogo` size=34 (full)
    - Title: "Your hiring desk" (Anek, --text-2xl, center)
    - Subtitle: (Inter, --text-sm, center, muted)
    - Hairline divider
    - `LoginForm` (client):
      - **Step 1:** Role tabs (Company|Agency segmented), mode switch (Sign in|Create account radio pills), org name/email/phone fields, submit, trust microcopy
      - **Step 2:** Step indicator (2 dots), OTP instruction, `OtpInput` (6 cells), verify/resend/back, Toast

### Dashboard (`/dashboard`)

- **File:** `src/app/(portal)/dashboard/page.tsx`
- **Function:** Command centre — alerts, stats, quick actions, posting list, recent unlocks
- **UI Elements:**
  - `page-head`: "Dashboard", subtitle (role-dependent), "Post a job/vacancy" primary button
  - **Attention items** (conditional): `.alert` blocks with icons (warning-octagon/warning/info)
  - **Stat tiles** (`.stat-row`): Credit balance, Open postings, Revenue (agency only), Contacts unlocked
  - **Quick actions** (`.quick`): grid of `quick__card` with Phosphor icons + labels + descriptions
  - **Your postings** (employer): `Card` list with status Badge, "View applicants" arrow
  - **Recent unlocks:** `MaskedCandidate` rows
  - **Agent sections** (agency only): demand summary, vacancy manager (`AgencyJobsManager`), invite panel, QR tools, referral funnel, parked modules

### Postings List (`/postings`)

- **File:** `src/app/(portal)/postings/page.tsx`
- **Function:** Manage all job postings/vacancies
- **UI Elements:**
  - Back link, page head: "Manage postings/vacancies", "Post a job/vacancy" button
  - Info alert: applicant quota explanation
  - `PostingsManager`: Card rows with status Badge, role title, meta (middot-separated), lifecycle buttons

### Post a Job (`/postings/new`)

- **File:** `src/app/(portal)/postings/new/page.tsx` + `posting-form.tsx`
- **Function:** Create new job posting
- **UI Elements:**
  - Back link, page head: "Post a job"
  - `PostingForm` with sections:
    - **The role:** SelectMenu (Trade), Input (Role title), Input (Location), Input (Vacancies) + badges
    - **Pay and experience:** grid of Input pairs
    - **Match skills:** `MatchSkillPicker` with Chip grid, related skill chips, reach Badge
    - **Details:** Textarea (Description)
    - Submit: "Post job" / "Post anyway — reaches nobody yet"

### MatchSkillPicker (`/postings/new/match-skill-picker.tsx`)

- **File:** `src/app/(portal)/postings/new/match-skill-picker.tsx`
- **Function:** Skill selection with reach calculation
- **UI Elements:**
  - Panel: "Which skill are you hiring for?"
  - Vocabulary chips grid (`.match-picker__vocab`)
  - Related skill chips with "+N" reach suffixes
  - Reach strip: Badge ("Reaches N workers"), tier-1 count

### Posting Detail (`/postings/[id]`)

- **File:** `src/app/(portal)/postings/[id]/page.tsx`
- **Function:** View single posting details
- **UI Elements:**
  - Back link, page head with title + status Badge, "View applicants" + "Edit posting" buttons
  - Panel with `kv` description list (Location, Vacancies, Applicants, Posted date)

### Applicant Feed (`/postings/[id]/applicants`)

- **File:** `src/app/(portal)/postings/[id]/applicants/page.tsx`
- **Function:** Faceless applicant feed for one posting
- **UI Elements:**
  - Back link, page head: "Applicants"
  - Info alert: faceless explainer
  - `ApplicantActions`:
    - Segmented tabs: `New (N)` / `Shortlist (N)`
    - Applicant card: Avatar (masked), opaque ID (mono), trade, experience/city, rank badge, score (mono), skills/chips, Keep/Pass buttons, "Mark as contacted", "Unlock contact (1 credit)"
    - `ConfirmSpendDialog`, `UnlockResultToast`

### Edit Posting (`/postings/[id]/edit`)

- **File:** `src/app/(portal)/postings/[id]/edit/page.tsx` + `edit-posting-form.tsx`
- **Function:** Edit existing posting
- **UI Elements:**
  - Back link, page head: "Edit posting"
  - Form with sections: The role, Pay and timing, Description
  - Save button, inline error alert

### AI Job Posting (`/postings/ai/new`)

- **File:** `src/app/(portal)/postings/ai/new/page.tsx`
- **Function:** Chat-first posting creation
- **UI Elements:**
  - Back link, page head: "Post with AI"
  - `JobPostingChat`:
    - **CHOOSE screen:** Resume card (outline) + Intro card (flat) with "Start chat"
    - **CHAT screen:** Thread card with conversation lines, suggested Chips, composer (Textarea + Send), sidebar with DraftPreview + "Publish posting"

### Credits (`/credits`)

- **File:** `src/app/(portal)/credits/page.tsx`
- **Function:** Wallet, top-up, credit history (Owner-only)
- **UI Elements:**
  - Page head: "Credits"
  - Stat tile: Credit balance (wallet icon)
  - **Top up:** `CreditsPanel` with pack card grid, Buy buttons, Razorpay/Mock flow
  - **History:** table (Date, Type Badge, Credits, Amount, Ref — all mono tabular)
  - **Expiry:** table (Credits, Purchased, Expires)

### Capacity (`/capacity`)

- **File:** `src/app/(portal)/capacity/page.tsx`
- **Function:** Concurrent vacancy allowance
- **UI Elements:**
  - Back link, page head: "Capacity"
  - Stat tiles: Active postings, Applicant quota used
  - `CapacityPanel`: tier card grid with Buy buttons
  - Per-posting table (Role, Status, Vacancies, Applicants, Quota)

### Plans (`/plans`)

- **File:** `src/app/(portal)/plans/page.tsx`
- **Function:** Combined plans — capacity + credit packs + posting plans
- **UI Elements:**
  - Back link, page head: "Plans & Capacity"
  - Capacity overview, `CapacityPanel`, quota table, credit packs grid, posting plans grid

### Account (`/account`)

- **File:** `src/app/(portal)/account/page.tsx`
- **Function:** Payer's own account management
- **UI Elements:**
  - Back link, page head: "Account"
  - Panel: "Signed in as" with Avatar (52px, brand), `kv` list (Organisation, Email mono)
  - `AccountForm`: org name, phone (masked current + new input), email (read-only), role/status badges
  - Agency-only: KYC & Bank Details section

### Team (`/team`)

- **File:** `src/app/(portal)/team/page.tsx`
- **Function:** Owner-only user management
- **UI Elements:**
  - Back link, page head: "Team"
  - `TeamManager`: Invite panel (email input + Send), Members table (masked email, role/status badges, Remove button)

### Accept Invite (`/team/accept`)

- **File:** `src/app/(portal)/team/accept/page.tsx`
- **Function:** Accept team invite
- **UI Elements:**
  - Page head: "Join a team"
  - Missing token / Accept button / Success alert / Failure alert

### Agency Dashboard (redirects to `/dashboard`)

### Agency Jobs Manager (inline in dashboard)

- **File:** `src/app/(portal)/agency/dashboard/agency-jobs-manager.tsx`
- **Function:** Agency vacancy CRUD
- **UI Elements:**
  - "Post a vacancy" button
  - `AgencyJobForm`: Select(Trade), Input(title/city/area), Grid(pay min/max), Grid(exp min/max), Select(needed-by)
  - Job card list: title, status Badge, meta, "Details" link, Edit/Pause/Close buttons

### Agency Invite Panel (inline in dashboard)

- **File:** `src/app/(portal)/agency/dashboard/invite-panel.tsx`
- **Function:** Create single referral link
- **UI Elements:**
  - Consent-first note Card
  - Form: Campaign tag, Link type (Organic/Paid), Role slug, City slug
  - Create button + "Live" Badge
  - Result: code (mono), URL, Copy link, WhatsApp share

### Agency Batch Invite Panel

- **File:** `src/app/(portal)/agency/dashboard/batch-invite-panel.tsx`
- **Function:** Generate up to 50 referral links
- **UI Elements:**
  - Note Card, Form (count, tag, type, role, city), Create button
  - Results: ordered list with code, URL, per-row WhatsApp share, "Copy all links"

### Agency Referral Funnel

- **File:** `src/app/(portal)/agency/dashboard/referral-funnel.tsx`
- **Function:** Invite → Clicked → Accepted funnel
- **UI Elements:**
  - Three Cards: "Invites created" / "Clicked" / "Accepted", each with k-anon count (mono)

### Agency Workers (`/agency/workers`)

- **File:** `src/app/(portal)/agency/workers/page.tsx`
- **Function:** Faceless worker activity list
- **UI Elements:**
  - Panel with count, faceless explainer, Table (per-agency pseudonym, Profile badge, Applied/Unlocked counts, Last active)

### Agency Referrals (`/agency/referrals`)

- **File:** `src/app/(portal)/agency/referrals/page.tsx`
- **Function:** Referral funnel + earnings + KYC + payouts
- **UI Elements:**
  - `AgencyInvitePanel`, `AgencyBatchInvitePanel`
  - Stat tiles (Invites created, Clicked, Accepted), ProgressBar
  - `EarningsPanel`: StatTiles (Total accrued, Requestable, In request, Paid)
  - `KycPanel`: status banner, masked PAN/bank, submit form
  - `PayoutPanel`: "Request payout" button, history table

### Agency QR (`/agency/qr`)

- **File:** `src/app/(portal)/agency/qr/page.tsx`
- **Function:** Printable QR invite poster
- **UI Elements:**
  - Create button, Printable sheet: QRCodeSVG (320px), caption, typed URL (mono)
  - Actions: "Print this sheet", "Download PNG", "Send on WhatsApp"

### Agency Job Detail (`/agency/jobs/[jobId]`)

- **File:** `src/app/(portal)/agency/jobs/[jobId]/page.tsx`
- **Function:** Single agency job detail
- **UI Elements:**
  - Back link, page head with title + Badge, `kv` list (Trade, Location, Pay, Experience, Needed by, Applicants, Posted)

### Invite Landing (`/i/[code]`) — PUBLIC

- **File:** `src/app/i/[code]/page.tsx`
- **Function:** Worker-facing referral landing (Hinglish)
- **UI Elements:**
  - `invite-landing` centered, Card: eyebrow "Aapko invite mila hai", title (Anek), Hinglish description, "Play Store se app install kijiye" primary button, 3 numbered steps, privacy note
  - **NO icons, NO images, NO JS** (Server Component, zero client code)

### Invite Desktop (`/i/[code]/desktop`)

- **File:** `src/app/i/[code]/desktop/page.tsx`
- **Function:** Desktop QR bridge
- **UI Elements:** Same layout + QR code (via `qrcode.react`)

---

## CSS TOKEN SYSTEM (`src/styles/tokens.css`)

### Color Tokens (180+ CSS custom properties)

**Blue (structural):** `--blue-50` (#e9f0fb) → `--blue-700` (#0a2350)
**Vermilion/Haldi (brand):** `--vermilion-50` (#fff7e0) → `--vermilion-900` (#5c4600)
**Green:** `--green-50` (#e9f5ec) → `--green-700` (#0f4a24)
**Amber:** `--amber-100` (#fef3c7) → `--amber-800` (#92400e)
**Red/Crimson:** `--red-50` (#fbeaea) → `--red-700` (#7f1818)
**Ink (neutrals):** `--ink-950` (#0b1220) → `--ink-50` (#f2f4f8)
**Paper:** `--paper-0` (#ffffff) → `--paper-4` (#e4e9f1)

### Semantic Aliases

| Category | Key Tokens                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------- |
| Text     | `--text-primary`, `--text-secondary`, `--text-muted`, `--text-brand`, `--text-on-brand`, `--text-link`, `--text-disabled` |
| Surface  | `--surface-page`, `--surface-card`, `--surface-raised`, `--surface-sunken`, `--surface-ink`                               |
| Brand    | `--brand` (vermilion-500), `--brand-hover`, `--brand-press`, `--brand-tint`, `--brand-border`                             |
| Status   | `--success` (green-500), `--danger` (red-500), `--warning` (amber-700), `--info` (blue-500)                               |
| Border   | `--border-subtle`, `--border-default`, `--border-strong`, `--border-ink`, `--border-control`                              |

### Typography Tokens

| Role    | Font        | Size                        | Weight   | Leading                 |
| ------- | ----------- | --------------------------- | -------- | ----------------------- |
| Display | Anek        | var(--ui-display-size) 28px | bold     | 1.15                    |
| H1      | Anek        | 22px                        | bold     | 1.2                     |
| H2      | Anek        | 17px                        | bold     | 1.3                     |
| H3      | Anek        | 15px                        | semibold | 1.35                    |
| Body    | Inter       | 14px (ui) / 16px (mobile)   | regular  | 1.55                    |
| Eyebrow | Inter       | 11px                        | bold     | 1.2, tracking 0.08em    |
| Mono    | Roboto Mono | 14-16px                     | regular  | —                       |
| KPI     | Inter       | 30px                        | bold     | 1.05, tracking -0.025em |

### Dark/Ink Theme

All tokens override under `[data-theme="ink"]`: surfaces → deep navy, text → light, tints → semi-transparent, borders → darker

---

## NAVIGATION MODEL

**Company (Employer):**

| Section      | Items                     | Icons                      |
| ------------ | ------------------------- | -------------------------- |
| (none)       | Dashboard                 | `squares-four`             |
| Hiring       | Post a job, Postings      | `plus-circle`, `briefcase` |
| Billing      | Plans & capacity, Credits | `chart-donut`, `wallet`    |
| Organisation | Team                      | `users-three`              |

**Agency:**

| Section      | Items                         | Icons                               |
| ------------ | ----------------------------- | ----------------------------------- |
| (none)       | Dashboard                     | `squares-four`                      |
| Demand       | Post a vacancy, Vacancies     | `plus-circle`, `briefcase`          |
| Supply       | Workers, Referrals, QR poster | `users`, `share-network`, `qr-code` |
| Billing      | Plans & capacity, Credits     | `chart-donut`, `wallet`             |
| Organisation | Team                          | `users-three`                       |

---

# SUMMARY TABLE

| Application     | Feature Modules                                                                                                                                                                                 | Total Screens | Shared Widgets                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ---------------------------------- |
| **Workers App** | 15 (splash, auth, consent, name, chat, voice, voice_form, profile, finishing, trade_form, resume, swipe, job_search, profile_tab, settings, notifications, applications, kit, feedback, invite) | 30+ screens   | 18 core widgets                    |
| **Payer App**   | 12 (auth, shell, home, find, jobs, job_posting_chat, credits, account, capacity, org, referral, agency)                                                                                         | 22 screens    | 18 core widgets                    |
| **Payer Web**   | 10+ (auth, dashboard, postings, ai-posting, credits, capacity, plans, account, team, agency/\*)                                                                                                 | 30+ routes    | 12+ DS components, 180+ CSS tokens |

---

# BRAND MIGRATION CHECKLIST

For each of the above screens, you will need to update:

1. **Logo placements** — `BbLogo` (Flutter), `BadaBhaiLogo` (Web), splash screen wordmark
2. **Primary CTA color** — currently haldi `#FFC400` → new blue/red
3. **Header backgrounds** — deep-blue `#123D8C` → new brand blue
4. **Active nav indicators** — haldi pill → new brand accent
5. **Chip selected states** — haldi fill → new brand accent
6. **Button variants** — all `BbButton` primary/haldi instances
7. **Badge colors** — brand/neutral tones
8. **Typography** — Anek/Baloo 2 (display), Inter/Mukta (body), Roboto Mono (data)
9. **CSS custom properties** — `--brand`, `--vermilion-*`, `--blue-*` token families
10. **Dark/ink theme** — `data-theme="ink"` overrides
11. **Rail/progress accents** — haldi left rails, progress fills
12. **Stamp/celebration colors** — green seals, success stamps
