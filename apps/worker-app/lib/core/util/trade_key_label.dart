/// Humanises a legacy `jobs.trade_key` for display — "cnc_operator" →
/// "CNC Operator".
///
/// WHY IT EXISTS. `GET /workers/me/applications` sends `trade_key` but no
/// display label for it (#1051), so the Applied-jobs row had to fall back to the
/// raw slug and a worker read "cnc_operator · Pune" on screen. Slugs, ids and
/// enums are never worker-facing: they are humanised at the display edge or
/// hidden.
///
/// It is NOT [taxonomyLabel] (`core/util/taxonomy_labels.dart`): that resolver
/// keys on PREFIXED taxonomy ids (`role_*`, `mach_*`, `skill_*`) and passes an
/// unprefixed trade slug straight through unchanged, which is exactly how the
/// raw slug reached the screen. This one takes the bare slug.
///
/// PII-FREE: a trade key is an opaque job-taxonomy string, never worker data.
library;

/// The alpha trades whose display name does NOT fall out of title-casing, taken
/// verbatim from the canonical role names in `packages/taxonomy/src/index.ts`
/// (`role_<key>` → `name`). Everything else is handled by [_prettify], so this
/// map stays small on purpose: a key added here must match the taxonomy's own
/// spelling, not a guess.
const Map<String, String> _kTradeLabels = <String, String>{
  'cnc_turner_operator': 'CNC Turner/Operator',
  'cnc_setter_operator': 'CNC Setter-Operator',
  'cnc_grinding_operator': 'CNC Grinding Operator',
  'cam_programmer': 'CAM Programmer',
  'cnc_programmer': 'CNC Programmer',
  'cnc_operator': 'CNC Operator',
  'vmc_operator': 'VMC Operator',
  'hmc_operator': 'HMC Operator',
  'interior_designer': 'Interior Designer',
  'welder': 'Welder',
  'plumber': 'Plumber',
  'carpenter': 'Carpenter',
  'designer': 'Designer',
};

/// Tokens that are read as letters, not words.
const Set<String> _kAcronyms = <String>{
  'cnc',
  'vmc',
  'hmc',
  'cad',
  'cam',
  'qc',
  'iti',
};

/// An INTERNAL id, not a trade slug: `mskill_mig_welder`, `role_welder`,
/// `mach_vmc`. These must never reach a worker's screen, and this function is
/// not the place to resolve them, so they return '' and the caller hides the
/// line (#1027).
final RegExp _kInternalIdPrefix = RegExp(
  r'^(mskill|skill|role|mach|dom|ind|ctrl|trade)_',
);

/// A readable trade name for [key], or '' when there is nothing honest to show.
///
/// Returns '' for an empty/blank key and for any internal id (see
/// [_kInternalIdPrefix]) — the caller then renders no trade line at all rather
/// than a slug. It NEVER returns the raw key.
String tradeKeyLabel(String key) {
  final String trimmed = key.trim();
  if (trimmed.isEmpty) return '';
  final String lower = trimmed.toLowerCase();
  if (_kInternalIdPrefix.hasMatch(lower)) return '';
  final String? known = _kTradeLabels[lower];
  if (known != null) return known;
  return _prettify(trimmed);
}

/// Title-cases a snake_case (or space-separated) slug, keeping [_kAcronyms] in
/// caps: `quality_inspector` → 'Quality Inspector', `vmc_setter` → 'VMC Setter'.
///
/// A token the worker already typed in caps ("ITI") is left alone — only a
/// lowercase first letter is raised, the same discipline `titleCaseName` keeps.
String _prettify(String slug) {
  final List<String> words = slug
      .split(RegExp(r'[_\s\-]+'))
      .where((String w) => w.isNotEmpty)
      .map((String w) {
        if (_kAcronyms.contains(w.toLowerCase())) return w.toUpperCase();
        return '${w[0].toUpperCase()}${w.substring(1)}';
      })
      .toList();
  return words.join(' ');
}
