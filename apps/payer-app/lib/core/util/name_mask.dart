/// Name masking for the faceless candidate feed — mirrors the kit's
/// `redacted()` + `initials()` helpers.
///
/// The feed only ever shows a [redactedName]; the real name surfaces solely on
/// the Reveal screen after a paid unlock.
class NameMask {
  NameMask._();

  /// "Ramesh Kumar" → "R•••• K." — first initial, a masked run (soft dots, NOT a
  /// solid black block), then the surname initial. Faceless by design: the real
  /// name surfaces only on the Reveal screen after a paid ₹40 unlock. No
  /// demographic signal, no full name.
  static String redacted(String name) {
    final List<String> parts = name.trim().split(RegExp(r'\s+'));
    final String first = parts.isEmpty || parts[0].isEmpty ? '' : parts[0][0];
    final String last =
        parts.length > 1 && parts[1].isNotEmpty ? '${parts[1][0]}.' : '';
    return '$first•••• $last'.trim();
  }

  /// "Ramesh Kumar" → "RK" — up to two uppercased initials for the avatar.
  static String initials(String name) {
    final List<String> parts = name.trim().split(RegExp(r'\s+'));
    final StringBuffer buffer = StringBuffer();
    for (final String part in parts.take(2)) {
      if (part.isNotEmpty) buffer.write(part[0].toUpperCase());
    }
    return buffer.toString();
  }
}
