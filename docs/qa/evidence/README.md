# QA Evidence Artifacts

This folder is the canonical home for manual QA artifacts: screenshots, logcat
captures, staging event exports, API responses, and smoke-test output.

The tracker file `docs/tracker/QA_EVIDENCE.md` is the written index. Keep large
artifacts here and link to them from the tracker.

## 2026-06-30 Verification

### `b1/`

Verified files present:

| File | What it shows | Status |
| ---- | ------------- | ------ |
| `01-splash-language.jpeg` | Splash/language screen | Present |
| `02-login-phone.jpeg` | Phone login screen | Present |
| `03-profile-tab-logout.jpeg` | Profile/logout tab | Present |
| `04-jobs-filter.jpeg` | Jobs filter UI | Present |
| `05-alerts.jpeg` | Alerts tab | Present |
| `06-profile-tab-kit.jpeg` | Profile/interview-kit surface | Present |
| `07-resume-text.jpeg` | Resume text preview + Download PDF button | Present |
| `08-jobs-swipe-card-1.jpeg` | Jobs swipe card | Present |
| `09-jobs-swipe-card-2.jpeg` | Jobs swipe card | Present |

What this proves:

- Worker-app UI screens are rendering on a handset/simulator capture.
- Resume text preview is visible.
- The Download PDF control is present in the app.
- Jobs/swipe UI is visible.

What this does not prove yet:

- A real staging `API_BASE_URL` was used.
- `/health` was green for the run.
- Real OTP delivery happened.
- The required B1 staging `events` chain exists.
- Logcat is clean of raw phone/name/OTP/PIN/token.
- The PDF download opened successfully and emitted `resume.downloaded`.

Current B1 evidence status: **PARTIAL**. Do not mark B1 GO until screenshots,
staging events, and clean logcat are all present.
