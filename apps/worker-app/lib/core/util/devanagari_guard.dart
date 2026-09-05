import 'package:flutter/services.dart';

/// The Devanagari Unicode block (consonants, vowels, matras, virama, the
/// ०-९ digits, and the danda/double-danda `।॥` sentence terminators) — every
/// character a phone's Hindi keyboard actually emits. Deliberately does NOT
/// touch Latin letters, so Hinglish (the app's own vocabulary throughout —
/// "Kis saal mila", "Machine par kaunsa controller lagaa hai?") types fine;
/// only the SCRIPT is blocked, not the language.
final RegExp devanagariCharPattern = RegExp('[ऀ-ॿ]');

/// True if [text] contains any Devanagari-script character.
bool containsDevanagari(String text) => devanagariCharPattern.hasMatch(text);

/// [text] with every Devanagari character removed.
String stripDevanagari(String text) => text.replaceAll(devanagariCharPattern, '');

/// Shown wherever a worker's Devanagari keystroke just got stripped — every
/// resume-bound free-text field is Roman-script only today (no
/// transliteration step exists on the render path), so a worker typing in
/// Devanagari would otherwise get an untransliterated Hindi line on their
/// printed resume with no warning.
const String kDevanagariBlockedHint =
    'Yahan Hindi (हिंदी) nahi chalega — Roman akshar mein likhein. Jaise: "Turning machine par kaam kiya".';

/// Strips Devanagari as the worker types, so the character never lands in
/// the field at all. [onBlocked] fires once per keystroke that actually
/// removed something, so the caller can surface [kDevanagariBlockedHint] —
/// silently eating input a worker cannot see disappearing would just read as
/// a broken keyboard.
class DevanagariBlockFormatter extends TextInputFormatter {
  DevanagariBlockFormatter({this.onBlocked});

  final VoidCallback? onBlocked;

  @override
  TextEditingValue formatEditUpdate(
    TextEditingValue oldValue,
    TextEditingValue newValue,
  ) {
    if (!containsDevanagari(newValue.text)) return newValue;
    onBlocked?.call();
    final String stripped = stripDevanagari(newValue.text);
    return TextEditingValue(
      text: stripped,
      selection: TextSelection.collapsed(offset: stripped.length),
    );
  }
}
