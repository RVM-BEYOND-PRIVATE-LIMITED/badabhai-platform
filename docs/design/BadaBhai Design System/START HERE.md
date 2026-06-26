# START HERE — BadaBhai handoff packet

This is the complete BadaBhai design + build packet. Theme is **Desi Vernacular
Pop** (vermilion + green + saffron, Baloo 2 + Mukta + Roboto Mono).

## 👀 Just want to SEE the app? (no setup)
Double-click **`BadaBhai Worker App (open me).html`** — a self-contained build of
the worker app. Use the top toggle:
- **Interactive flow** — click through all 17 screens.
- **All screens** — every screen at once.
(Needs internet for fonts/icons; everything else is embedded.)

## 📱 For the Android / Flutter developer
Everything is in **`android-build-kit/`**:
- `README.md` — the build brief: full flow, all 17 screen specs, theme tokens,
  component mapping, and Flutter notes. **Read this first.**
- `index.html` — the live, clickable app (source version).
- `screens.jsx` · `app.jsx` · `ui.css` — the screen source.

## 🎨 The design system (for production / brand)
- `readme.md` — the full design guide: brand story, **content/voice rules**,
  **visual foundations** (color, type, motion), iconography.
- `styles.css` — the single stylesheet to link; pulls in everything in `tokens/`
  (colors, typography, spacing, radii, elevation, motion). Build your Flutter
  `ThemeData` from these values.
- `components/` — 24 reusable UI primitives, each with a `.d.ts` (props contract)
  and `.prompt.md` (usage). Treat these as the spec for your widgets.
- `ui_kits/` — full product recreations: `worker-app/` and the role-aware
  `company-web/` (Company + Agency payer web app).
- `templates/` — copyable starting screens.
- `assets/` — `logo/app-icon.svg` and self-hosted Roboto Mono fonts.
- `SKILL.md` — lets an AI agent design on-brand from this folder.

## ▶️ To run the source interactively (recommended for devs)
The `.html` files that use live components load over HTTP, not `file://`. From
this folder:
```
npx serve .          # or:  python3 -m http.server 8080
```
…then open the printed URL and browse to `android-build-kit/index.html`,
`ui_kits/worker-app/index.html`, etc.

## ⚠️ Notes
- Built from BadaBhai's product/strategy doc — a faithful interpretation, not a
  pixel recreation. Share a logo, Figma, or app screenshots to make it exact.
- Worker photos are placeholder avatars (no real imagery was supplied).
- `BadaBhai - Design Directions.html` shows the 12 visual directions explored;
  #5 (Desi Vernacular Pop) is the locked one.
