/// Turns a raw `missing_fields` slug into a worker-readable Hinglish label.
///
/// `missing_fields` (GET /workers/me/profile-summary) is a closed set of nine
/// short canonical keys the server emits, ordered largest-missing-weight first:
///  `role` | `trade` | `skills` | `machines` | `experience` | `salary` |
///  `location` | `availability` | `photo`.
///
/// A low-literacy worker must NEVER see a raw slug on screen (the "no raw ids in
/// UI" rule), so this normalises at the presentation edge — exactly like
/// [humanizeEducationLevel]:
///  - a KNOWN slug maps to a fixed Hinglish label written to slot into
///    "... <label> jodein" (aap-form, no exclamation, no tum-form verbs — the
///    persona net in `test/persona_neutrality_test.dart` scans every literal
///    here),
///  - any UNKNOWN token (defensive only — the set is closed) is prettified
///    (`snake_case` → "Snake Case") rather than shown as a raw id.
///
/// PII-free: `missing_fields` carries field NAMES, never a worker's values.
String humanizeMissingField(String slug) {
  final String value = slug.trim();
  if (value.isEmpty) return value;

  // Object-form noun phrases so the caller can build a natural, verb-light nudge
  // ("... <label> jodein") that reads correctly for every slug — including
  // `photo`, which is not something a worker "tells".
  const Map<String, String> known = <String, String>{
    'role': 'apna kaam / role',
    'trade': 'apni industry',
    'skills': 'apni skills',
    'machines': 'apni machines',
    'experience': 'apna kaam-anubhav',
    'salary': 'salary ki ummeed',
    'location': 'kaam ki jagah',
    'availability': 'kaam ki availability',
    'photo': 'apni photo',
  };
  final String? mapped = known[value.toLowerCase()];
  if (mapped != null) return mapped;

  // Defensive fallback for a slug the backend adds later: prettify rather than
  // ever leak a raw `snake_case` id onto a worker's screen.
  return value
      .split(RegExp(r'[_\s]+'))
      .where((String w) => w.isNotEmpty)
      .map((String w) => '${w[0].toUpperCase()}${w.substring(1)}')
      .join(' ');
}
