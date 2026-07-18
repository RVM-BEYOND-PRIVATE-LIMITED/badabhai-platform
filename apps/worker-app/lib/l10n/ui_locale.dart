import 'package:flutter/widgets.dart';

import '../core/auth/locale_store.dart';

/// Bridges the STORED language code ([LocaleStore], a plain string that also
/// travels as the `X-Locale` header) to the [Locale] the widget tree is
/// actually dressed in.
///
/// These two are NOT the same set, and conflating them crashes the app — see
/// [kUiSupportedLocales] below. #315 foundation pass.

/// The locales `MaterialApp` may be handed.
///
/// DELIBERATELY NOT `AppLocalizations.supportedLocales`. gen-l10n derives that
/// list from whatever ARB files exist, which includes `app_bho.arb` — and
/// `bho` is NOT in flutter_localizations' `kMaterialSupportedLanguages`
/// (verified against the pinned 3.35 SDK: zero `'bho'` entries in
/// generated_material_localizations.dart; `hi` and `mr` are both there). Offer
/// a locale the Global* delegates cannot load and the fallback is
/// `DefaultMaterialLocalizations`, which supports English and nothing else
/// (`isSupported(locale) => locale.languageCode == 'en'`). The worker on
/// Bhojpuri would then hit a `No MaterialLocalizations found` assertion — a
/// blank screen on app open, not a mildly untranslated one.
///
/// So this list is CURATED, and test/l10n/l10n_foundation_test.dart asserts
/// every entry is genuinely dressable. If someone later "simplifies" this to
/// `AppLocalizations.supportedLocales`, that test fails on purpose.
const List<Locale> kUiSupportedLocales = <Locale>[
  Locale('hi'),
  Locale('mr'),
  Locale('en'),
];

/// The stored code that has no UI locale of its own and rides Hindi instead.
///
/// Kept as a named constant so the mapping in [uiLocaleFor] reads as a decision
/// rather than a stray string compare.
const String kUiFallbackToHindiCode = 'bho';

/// Resolves the stored [code] to a [Locale] that is in [kUiSupportedLocales].
///
/// Every unknown/unsupported code — including `bho` (see above) and anything a
/// future backend starts sending — lands on [LocaleStore.defaultLocale] (Hindi),
/// which is both the app's shipping default and the gen-l10n template locale,
/// so the fallback is always fully-translated copy rather than blanks.
///
/// Note this does NOT rewrite what gets stored or sent: `LocaleStore.read()`
/// still returns `bho` and the `X-Locale` header still says `bho`, so the
/// server-side half of the worker's choice is untouched. Only the widget tree
/// is downgraded.
Locale uiLocaleFor(String code) {
  final Locale fallback = Locale(LocaleStore.defaultLocale);
  for (final Locale locale in kUiSupportedLocales) {
    if (locale.languageCode == code) return locale;
  }
  return fallback;
}
