# UI Kit · Worker mobile app

A high-fidelity, click-through recreation of the **BadaBhai worker app** (the
Flutter product). Chat-first, low-literacy-first, Hinglish.

**Open:** `index.html`

### Flow
`Login (phone → OTP)` → `Chat onboarding (bada bhai profiles you)` →
`Resume ready` → tabbed app: `Jobs (swipe-to-apply)` · `Resume` · `Profile`.

### Files
- `index.html` — loads the design-system bundle + fonts, mounts the app
- `screens.jsx` — `LoginScreen`, `ChatScreen`, `ResumeScreen`, `FeedScreen`, `ProfileScreen`, `DeviceFrame`
- `app.jsx` — the flow controller
- `worker-app.css` — kit-only shell styling (device frame, screen layout)

### Design-system components used
`BadaBhaiLogo`, `ChatBubble`, `JobCard`, `BottomNav`, `OtpInput`, `Input`,
`Button`, `IconButton`, `Chip`, `Badge`, `Avatar`, `Card`, `ProgressBar`,
`Switch`, `Toast` — all from `window.BadaBhaiDesignSystem_01ff85`.

### Caveats
- No Flutter source or screenshots were provided — this is built from the product
  description in the context doc, not a pixel recreation. Share the real app and
  it can be matched exactly.
- Worker photos use placeholder avatars (no real imagery supplied).
