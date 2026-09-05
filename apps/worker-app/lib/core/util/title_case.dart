/// Capitalizes the first letter of each whitespace-separated word — for the
/// small set of PROPER-NOUN fields (a worker's own name, an institute name)
/// where "rvm cad pvt lt" printing verbatim on the resume/PDF reads as
/// careless. Deliberately narrow: never applied to free-text description
/// fields (work-done, certificate name, etc.), where a worker's own
/// capitalization is the actual content and not a mistake to "fix".
///
/// NEVER touches any character beyond a word's first — only uppercases a
/// LOWERCASE first letter, and leaves every other character exactly as
/// typed. A worker who deliberately typed an abbreviation in caps ("RVM",
/// "ITI", "NIFT") keeps it exactly as typed; this only fixes the case this
/// feature exists for, an all-lowercase (or partially lowercase) entry.
String titleCaseName(String text) {
  if (text.isEmpty) return text;
  final StringBuffer out = StringBuffer();
  bool atWordStart = true;
  for (final int rune in text.runes) {
    final String char = String.fromCharCode(rune);
    if (char.trim().isEmpty) {
      out.write(char);
      atWordStart = true;
      continue;
    }
    out.write(atWordStart ? char.toUpperCase() : char);
    atWordStart = false;
  }
  return out.toString();
}
