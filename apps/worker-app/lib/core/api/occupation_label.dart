/// The occupation "trust pill" on the profiling screen echoes the worker's
/// trade back to them ("you have been understood"). The backend resolves that
/// trade to an occupation FAMILY and sends the family's label as
/// `occupation_label`.
///
/// One family is NOT a real trade: `fam_universal` — the universal FALLBACK the
/// resolver returns when it could not confidently place the worker's trade (low
/// confidence, an uncovered trade, or a retrieval blip). Its label is the Hindi
/// "सामान्य" (English "General"). Showing it turns the trust moment into a
/// dismissive "General", so we HIDE it everywhere: it is treated as "no
/// occupation pinned yet" (null), exactly like an absent label.
///
/// Source of the labels: `packages/db/data/question-packs/_families.jsonl`
/// (`fam_universal` -> `label_hi: "सामान्य"`, `label_en: "General"`). The backend
/// sends only the label string (no family id / is_universal flag), so matching
/// the known universal labels is the only client-side signal available.
const Set<String> kUniversalOccupationLabels = <String>{'सामान्य', 'General'};

/// True when [label] is the universal-fallback family label (the one to hide).
/// Trimmed + case-insensitive so a stray space or casing variant still matches;
/// blank is treated as universal (nothing to show either way).
bool isUniversalOccupationLabel(String? label) {
  if (label == null) return false;
  final String trimmed = label.trim();
  if (trimmed.isEmpty) return true;
  return kUniversalOccupationLabels
      .any((String u) => u.toLowerCase() == trimmed.toLowerCase());
}

/// The occupation label to DISPLAY: the raw label, or `null` when it is the
/// universal fallback (so the pill's `!= null` guard drops it, and every other
/// consumer of `occupationLabel` — present or future — is hidden too).
String? displayableOccupationLabel(String? raw) =>
    isUniversalOccupationLabel(raw) ? null : raw;
