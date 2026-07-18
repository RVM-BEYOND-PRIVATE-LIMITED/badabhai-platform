# Bundled fonts — asset plan (#350)

## Shipping today

**Roboto Mono** (data font: wages, ₹, IDs, OTP, counts) — `RobotoMono-{Regular,Italic,Bold,BoldItalic}.ttf`,
declared under `flutter: fonts:` in `pubspec.yaml` and consumed via
`AppTypography.mono()`. Self-hosted so figures render identically with no network.

## NOT shipping yet — the #350 gap

**Baloo 2** (display) and **Mukta** (body/UI) are the locked Desi Vernacular Pop
brand families, and they carry all our Devanagari. Their binaries are **not in
this repo**, so `AppTypography.display()/body()/eyebrow()` still go through
`google_fonts`, which fetches them over HTTP on first use. For a worker who
sideloads the APK or first-launches on 2G that means fallback glyphs plus
mid-flow reflow — on the OTP/PIN screens, under their thumb.

`AppTypography.bundledBrandFonts` is the switch that closes this. It ships
`false`; the `true` branch (asset families only, `google_fonts` never called,
`allowRuntimeFetching` forced off) is written and tested — it is waiting on
files, not code.

### Binaries required

Both families are SIL Open Font License 1.1 and must include the **Devanagari**
subset (not the Latin-only builds), sourced from the upstream repos —
[google/fonts/ofl/baloo2](https://github.com/google/fonts/tree/main/ofl/baloo2),
[google/fonts/ofl/mukta](https://github.com/google/fonts/tree/main/ofl/mukta) —
matching the weights `AppTypography` actually asks for:

| File                   | Family  | Weight | Used by                                    |
| ---------------------- | ------- | ------ | ------------------------------------------ |
| `Baloo2-SemiBold.ttf`  | Baloo 2 | 600    | `titleLarge`, `titleMedium`                |
| `Baloo2-Bold.ttf`      | Baloo 2 | 700    | `displaySmall`, all `headline*`, buttons   |
| `Baloo2-ExtraBold.ttf` | Baloo 2 | 800    | `displayLarge`, `displayMedium`            |
| `Mukta-Regular.ttf`    | Mukta   | 400    | `bodyLarge`, `bodyMedium`, `bodySmall`     |
| `Mukta-SemiBold.ttf`   | Mukta   | 600    | `titleSmall`, `labelMedium`                |
| `Mukta-Bold.ttf`       | Mukta   | 700    | `labelLarge` (buttons), `eyebrow()`        |

Baloo 2 upstream is a variable font — export the static instances above, or
bundle the variable file and declare each weight against it.

### Landing them (one commit, in this order)

1. Drop the six `.ttf` files into this directory.
2. Uncomment the `Baloo 2` + `Mukta` families in `pubspec.yaml` (`flutter: fonts:`).
3. Flip `AppTypography.bundledBrandFonts` to `true`.
4. Re-run `flutter test` — `test/core/theme/app_typography_test.dart` asserts
   both sides of the seam.

Do **not** do 3 before 1 and 2: the app would render fallback glyphs for asset
families that do not exist, which is the very failure #350 is about.

`apps/payer-app` has the identical gap and the same fix shape.
