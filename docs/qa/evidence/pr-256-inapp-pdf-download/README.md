# PR #256 — in-app PDF download: device verification

**Verified** 2026-07-17 · **Device** OPPO CPH2585, **Android 16 (API 36)** → MediaStore path
**Build** `main` @ `9d896cd` (#256's `7f269a9` is merged into main; verified on main, which
is what ships — the `feat/worker-inapp-pdf-download` branch is stale by #326/#340)
**Mode** `--dart-define=USE_MOCKS=true` (offline smoke; the `mock://` sentinel skips only the
byte-fetch — the MediaStore save + ACTION_VIEW path under test is the REAL one)

## Android 10+ checklist

| # | Check | Result |
|---|---|---|
| 1 | Download stays on the SAME screen; no navigation | ✅ top activity stayed `com.badabhai.workerapp/.MainActivity` |
| 2 | "Download complete — Downloads folder mein hai" SnackBar | ✅ screenshot 02 (public-Downloads copy = correct for API 36) |
| 3 | `BadaBhai-Resume.pdf` in system Downloads | ✅ MediaStore Row 613, 610 B, `application/pdf`; also `/sdcard/Download/` |
| 4 | "Kholein" opens the file in a PDF viewer | ✅ screenshots 03–04 — PDF renders ("BadaBhai sample PDF - mock download") |
| 5 | Re-download → `BadaBhai-Resume (1).pdf` (MediaStore dedup) | ✅ Rows 614/615/616 → `(1)`, `(2)`, `(3)` |
| 6 | Interview kit → `BadaBhai-Interview-Kit-<trade>.pdf` | ✅ `BadaBhai-Interview-Kit-cnc_operator.pdf`, Row 617 |
| 7 | **CRITICAL** no browser / Chrome custom tab opens | ✅ `chrome/customtab` refs in activity stack = **0** |
| 8 | **CRITICAL** signed url never on screen or in logcat | ✅ logcat scan for `https://.*token\|signed\|sig=\|X-Amz\|Signature` = **0 lines**. No url logging was added while debugging (§2). |

### Note on the PDF viewer package
"Kholein" resolves to Android's **"Open with"** chooser → the device's registered PDF handler is
`com.heytap.browser/…plugin.app.multiactivity.pdf.PDFActivity0` (OPPO ships its PDF viewer inside
the browser package). This is **not** a browser hand-off of the signed url: the viewer receives a
local `content://` MediaStore uri, and logcat confirms no url ever appears. Check #7 stands.

## NOT verified here (honest gaps — do not mark these green)

| Check | Why | Needs |
|---|---|---|
| "Download shuru ho gaya…" + button busy for the whole download | mock saves a placeholder instantly (no network leg), so the busy window is sub-frame | real backend |
| Double-tap → exactly one file | same reason: with an instant save, two taps are two *sequential* downloads, not a concurrency test of the busy-guard | real backend |
| Airplane mode → "Server se connect nahi ho pa raha…" (60s bound) | the `mock://` sentinel never touches the network, so airplane mode changes nothing | real backend |
| `resume.downloaded` event in ops console | mock client mints no server url | real backend + ops console |
| **API < 29** fallback (app-external dir, FileProvider, "app ke Download folder" copy) | no Android 7–9 device/emulator available in this session | API 24–28 emulator |

The failure paths above are wired (`TimeoutException` / `ClientException` / `SocketException` /
non-200 → typed copy, `pdf_downloader.dart:214-219`) and covered by **11 passing unit tests**
(`test/core/util/pdf_downloader_test.dart`) — but that is code-level, not device-level, evidence.

## Release build (REMAINING WORK 1)
`flutter build apk --release` → ✅ **green, 52.2 MB**. `lintVitalRelease` raised no `NewApi`
failure, so the proactive `@RequiresApi(Q)` on `saveViaMediaStore` is correctly satisfied.
Re-run green after the `gradle.properties` change below.

## Files
- `01-resume-tab-download-button.png`
- `02-download-complete-snackbar-kholein.png`
- `03-kholein-open-with-pdf-viewer.png`
- `04-pdf-opens-and-renders.png`
- `05-interview-kit-detail.png`
- `downloads-listing.txt` — `ls` + MediaStore query proof
