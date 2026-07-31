// Permanent persona-neutrality regression net for the WORKER APP.
//
// The Dart mirror of `apps/ai-service/tests/test_persona_neutrality.py`. That
// test locks the bot's SERVER-generated copy; this one locks the copy the client
// ships — the openers, nudges, chips, error strings and share text that live as
// Dart string literals and never pass through the ai-service at all. Both halves
// are needed: a worker cannot tell which side a sentence came from.
//
// WHY THIS FILE EXISTS. `kChatNudgeTitle` shipped as 'Ek minute, bhai' and the
// splash tagline as 'Your placement bhai for factory jobs'. `bhai` as a VOCATIVE
// is banned by the Ten Laws — the persona is NAMED Bada Bhai but addresses the
// worker by first name + "ji", always "aap". Nothing could catch that, so it
// shipped. This scans every string literal under `lib/` on every run.
//
// TWO SUBTLETIES BAKED IN ON PURPOSE (both mirroring the Python test):
//
//  - The persona is NAMED "Bada Bhai", so the proper noun legitimately appears
//    in worker-facing copy. The exact bigram is STRIPPED before scanning, so the
//    brand name is exempt while a bare `bhai` vocative is not.
//  - Interpolations (`${…}` / `$ident`) are CODE, not copy. A null-assertion `!`
//    inside one is not an exclamation mark any worker reads, so they are removed
//    before the `!` check.
//
// SCOPE. String LITERALS only, comments stripped. A comment may (and does)
// discuss the banned words in order to explain the rule — exactly as the Python
// test allows the system prompts to name what they forbid.

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

// --- The Ten Laws, as token lists -----------------------------------------

/// Vocatives the persona never uses for the worker. Checked as WHOLE WORDS and
/// AFTER the "Bada Bhai" brand strip.
const List<String> kBannedVocative = <String>[
  'bhai',
  'bhaiya',
  'beta',
  'behen',
  'yaar',
];

/// The persona is always "aap". Whole word only — `tu`/`tum` are substrings of
/// plenty of innocent words ("status", "tumhara" is itself banned but "tumba"
/// style false hits are avoided by the word boundary).
const List<String> kBannedInformal = <String>['tu', 'tum'];

/// Gush. An efficient senior does not squeal. The first six mirror the Python
/// list; the English three are the ones a Flutter dev reaches for by reflex.
const List<String> kBannedGush = <String>[
  'waah',
  'zabardast',
  'shabaash',
  'shabash',
  'bahut acha',
  'bahut accha',
  'great',
  'perfect',
  'awesome',
];

/// Tum-form verbs. The first three mirror the Python list; the bare imperatives
/// after them are the shape that actually shipped in this app (the invite share
/// text read 'banao … pao … shuru karo').
///
/// `chalo` is DELIBERATELY ABSENT. It is a tum/plural imperative, but it appears
/// in the CEO-ratified one-shot opener, and `kChatOpeningText` must stay
/// byte-identical to the ai-service's `ONE_SHOT_OPENER` (drift S4). Banning it
/// here would force the client copy to diverge from the server's — trading a
/// real bug for a cosmetic one. If the persona sheet ever rules on `chalo`, it
/// must change in `question_bank.py` FIRST and here second.
const List<String> kBannedTumForm = <String>[
  'karte ho',
  'karoge',
  'karna pasand karoge',
  'karo',
  'banao',
  'batao',
  'bolo',
  'dekho',
  'suno',
  'likho',
  'bhejo',
];

/// The brand name. Stripped before scanning so "Bada Bhai" / "bada-bhai" never
/// trips the vocative rule.
final RegExp _kBrand = RegExp(r'bada[\s\-_]*bhai', caseSensitive: false);

/// `${expr}` and `$ident` — code inside a string, not copy.
final RegExp _kSimpleInterpolation = RegExp(r'\$[A-Za-z_][A-Za-z0-9_.]*');

// --- Allowlist -------------------------------------------------------------

/// Strings that are NOT worker-facing copy and are therefore exempt.
///
/// Every entry needs a one-line reason. Keep this list short and boring: an
/// allowlist entry is a permanent hole in the net, so "the copy is fine as-is"
/// is never a valid reason — fix the copy instead. Nothing here may be a string
/// a worker can read on screen.
///
/// EMPTY TODAY, and that is the intended steady state: the three violations this
/// test was written for were all FIXED rather than exempted. It exists because
/// a future log message or platform-convention semantic label may legitimately
/// need one, and a reviewer should see the reason next to it.
const Map<String, String> kAllowlist = <String, String>{
  // Example of the required shape (a real entry would be an exact literal):
  //   'some_log_tag_with_bhai': 'log tag, never rendered — grep key for X',
};

// --- Scanner ---------------------------------------------------------------

/// One string literal found in the source, with where it came from. Public
/// because the file-scanning helpers below return it.
class PersonaLiteral {
  const PersonaLiteral(this.file, this.line, this.value);

  final String file;
  final int line;
  final String value;

  @override
  String toString() => '$file:$line  ${_quote(value)}';

  static String _quote(String s) =>
      "'${s.replaceAll('\n', r'\n')}'";
}

/// The worker app's `lib/` directory, resolved from the test's own CWD
/// (`flutter test` runs from the package root).
Directory get _libDir => Directory('lib');

List<File> _dartFiles(Directory dir) => dir
    .listSync(recursive: true)
    .whereType<File>()
    .where((File f) => f.path.endsWith('.dart'))
    .toList();

/// Removes `//` and `/* */` comments WITHOUT eating string contents — a naive
/// regex would truncate any literal containing `//` (every url in the codebase).
String stripComments(String source) {
  final StringBuffer out = StringBuffer();
  int i = 0;
  final int n = source.length;
  while (i < n) {
    final String c = source[i];
    final String c2 = i + 1 < n ? source[i + 1] : '';

    if (c == '/' && c2 == '/') {
      while (i < n && source[i] != '\n') {
        i++;
      }
      continue;
    }
    if (c == '/' && c2 == '*') {
      i += 2;
      while (i < n && !(source[i] == '*' && i + 1 < n && source[i + 1] == '/')) {
        if (source[i] == '\n') out.write('\n'); // keep line numbers honest
        i++;
      }
      i += 2;
      continue;
    }
    if (c == "'" || c == '"') {
      i = _copyLiteral(source, i, out);
      continue;
    }
    out.write(c);
    i++;
  }
  return out.toString();
}

/// Copies the literal starting at [start] verbatim into [out]; returns the index
/// just past it.
int _copyLiteral(String source, int start, StringBuffer out) {
  final String quote = source[start];
  final String terminator =
      source.startsWith(quote * 3, start) ? quote * 3 : quote;
  out.write(terminator);
  int i = start + terminator.length;
  while (i < source.length) {
    if (source[i] == r'\') {
      out.write(source.substring(i, (i + 2).clamp(0, source.length)));
      i += 2;
      continue;
    }
    if (source.startsWith(terminator, i)) {
      out.write(terminator);
      return i + terminator.length;
    }
    out.write(source[i]);
    i++;
  }
  return i;
}

/// Every string literal in [source] (comments already stripped), with line
/// numbers.
List<PersonaLiteral> extractLiterals(String source, String file) {
  final List<PersonaLiteral> found = <PersonaLiteral>[];
  int i = 0;
  int line = 1;
  final int n = source.length;
  while (i < n) {
    final String c = source[i];
    if (c == '\n') {
      line++;
      i++;
      continue;
    }
    if (c != "'" && c != '"') {
      i++;
      continue;
    }
    final String quote = c;
    final String terminator =
        source.startsWith(quote * 3, i) ? quote * 3 : quote;
    final int startLine = line;
    i += terminator.length;
    final StringBuffer buf = StringBuffer();
    while (i < n) {
      if (source[i] == r'\') {
        // Keep the ESCAPED character, drop the backslash — `\'` is an
        // apostrophe to the worker, and `\n` must not read as the letter n.
        final String next = i + 1 < n ? source[i + 1] : '';
        if (next == 'n' || next == 't' || next == 'r') {
          buf.write(' ');
        } else {
          buf.write(next);
        }
        if (next == '\n') line++;
        i += 2;
        continue;
      }
      if (source.startsWith(terminator, i)) {
        i += terminator.length;
        break;
      }
      if (source[i] == '\n') line++;
      buf.write(source[i]);
      i++;
    }
    found.add(PersonaLiteral(file, startLine, buf.toString()));
  }
  return found;
}

/// The text actually shown to a worker: brand name removed, interpolated
/// expressions removed.
String scannableText(String literal) {
  String text = literal;
  // `${ ... }` — balanced, so a nested map/closure inside an interpolation is
  // removed whole rather than up to the first `}`.
  final StringBuffer out = StringBuffer();
  int i = 0;
  while (i < text.length) {
    if (text[i] == r'$' && i + 1 < text.length && text[i + 1] == '{') {
      int depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        if (text[i] == '{') depth++;
        if (text[i] == '}') depth--;
        i++;
      }
      continue;
    }
    out.write(text[i]);
    i++;
  }
  text = out.toString().replaceAll(_kSimpleInterpolation, '');
  return text.replaceAll(_kBrand, '');
}

bool _hasWord(String text, String word) =>
    RegExp('\\b${RegExp.escape(word)}\\b', caseSensitive: false)
        .hasMatch(text);

/// Every persona violation in [literal], or `[]`.
List<String> personaViolations(String literal) {
  if (kAllowlist.containsKey(literal)) return const <String>[];
  final String text = scannableText(literal);
  final String lower = text.toLowerCase();
  final List<String> hits = <String>[];

  for (final String w in kBannedVocative) {
    if (_hasWord(text, w)) hits.add('banned vocative "$w"');
  }
  for (final String w in kBannedInformal) {
    if (_hasWord(text, w)) hits.add('informal "$w" (the persona is always aap)');
  }
  for (final String g in kBannedGush) {
    if (lower.contains(g)) hits.add('gush "$g"');
  }
  for (final String t in kBannedTumForm) {
    if (_hasWord(text, t)) hits.add('tum-form "$t"');
  }
  if (text.contains('!')) {
    hits.add('exclamation mark (bot copy is calm, never excited)');
  }
  return hits;
}

/// Every literal under `lib/`.
List<PersonaLiteral> _allLibLiterals() {
  final List<PersonaLiteral> all = <PersonaLiteral>[];
  for (final File file in _dartFiles(_libDir)) {
    final String source = stripComments(file.readAsStringSync());
    all.addAll(extractLiterals(source, file.path));
  }
  return all;
}

void main() {
  group('persona neutrality — every string literal under lib/', () {
    test('no worker-facing string breaks the Ten Laws', () {
      final List<String> failures = <String>[];
      for (final PersonaLiteral literal in _allLibLiterals()) {
        final List<String> hits = personaViolations(literal.value);
        if (hits.isNotEmpty) {
          failures.add('$literal\n    → ${hits.join('; ')}');
        }
      }
      expect(
        failures,
        isEmpty,
        reason: 'Persona violations found. The persona addresses the worker by '
            'first name + "ji", always "aap", never bhai/bhaiya/beta/behen/yaar, '
            'never tu/tum, never gushes, and never uses an exclamation mark.\n\n'
            '${failures.join('\n')}',
      );
    });

    test('the scan actually reaches the whole app', () {
      // A scanner that silently found nothing would pass the test above forever.
      final List<PersonaLiteral> literals = _allLibLiterals();
      expect(_dartFiles(_libDir).length, greaterThan(100),
          reason: 'lib/ should have well over 100 dart files');
      expect(literals.length, greaterThan(1000),
          reason: 'the extractor should be finding thousands of literals');
    });
  });

  // --- The net must be able to FAIL -----------------------------------------
  // These run the detector over strings written HERE, so the rules are proven
  // to bite without a violation ever being committed to lib/.

  group('the detector bites', () {
    test('catches the exact strings this test was written for', () {
      expect(personaViolations('Ek minute, bhai'), isNotEmpty);
      expect(personaViolations('Your placement bhai for factory jobs'),
          isNotEmpty);
      expect(
        personaViolations('BadaBhai par apna profile banao aur jobs pao'),
        isNotEmpty,
      );
      expect(personaViolations('Namaste! Main aapka Bada Bhai.'), isNotEmpty);
    });

    test('catches each banned category', () {
      expect(personaViolations('Suno beta, ek baat'), isNotEmpty);
      expect(personaViolations('Arre yaar phir se'), isNotEmpty);
      expect(personaViolations('Tum kya karte ho'), isNotEmpty);
      expect(personaViolations('tu kaun hai'), isNotEmpty);
      expect(personaViolations('Waah, kya baat'), isNotEmpty);
      expect(personaViolations('Zabardast profile'), isNotEmpty);
      expect(personaViolations('Great job'), isNotEmpty);
      expect(personaViolations('Perfect'), isNotEmpty);
      expect(personaViolations('Awesome'), isNotEmpty);
      expect(personaViolations('Shabaash'), isNotEmpty);
      expect(personaViolations('Yahan se shuru karo'), isNotEmpty);
      expect(personaViolations('Bahut acha'), isNotEmpty);
      expect(personaViolations('Ho gaya!'), isNotEmpty);
    });

    test('does NOT fire on the brand name, or on aap-form copy', () {
      expect(personaViolations('Main aapka Bada Bhai'), isEmpty);
      expect(personaViolations('BadaBhai · v1.0'), isEmpty);
      expect(personaViolations('bada-bhai bubble'), isEmpty);
      expect(personaViolations('Aap kaunsa kaam karte hain?'), isEmpty);
      expect(personaViolations('Dobara bolein ya type karke bhejein.'), isEmpty);
      expect(personaViolations('Yeh theek hai?'), isEmpty);
      expect(personaViolations('Ek minute ji'), isEmpty);
    });

    test('an interpolated null-assertion is code, not an exclamation mark', () {
      expect(personaViolations(r'Aakhri baar: ${_ago(device.lastSeenAt!)}'),
          isEmpty);
      expect(personaViolations(r'Anubhav: ${_label(s.years!)}'), isEmpty);
      // …but a real bang OUTSIDE the interpolation is still caught.
      expect(personaViolations(r'Ho gaya ${name}!'), isNotEmpty);
    });

    test('a word merely CONTAINING a banned token is not a violation', () {
      // Whole-word matching: these must not trip `tu` / `tum` / `beta`.
      expect(personaViolations('Status update'), isEmpty);
      expect(personaViolations('Beta version ka nahi'), isNotEmpty); // 'Beta' IS a word here
      expect(personaViolations('Betaal'), isEmpty);
      expect(personaViolations('Autumn'), isEmpty);
    });
  });

  group('comment / literal extraction', () {
    test('comments are stripped, so a rule can be explained in prose', () {
      const String source = '''
// This comment says bhai and tum and Waah! on purpose.
/* So does this one: beta, yaar! */
const String a = 'Aap theek hain';
''';
      final List<PersonaLiteral> literals =
          extractLiterals(stripComments(source), 'x.dart');
      expect(literals.map((PersonaLiteral l) => l.value), <String>['Aap theek hain']);
    });

    test('a literal containing // is not truncated', () {
      const String source = "const String u = 'https://app.badabhai.in/i/x';";
      final List<PersonaLiteral> literals =
          extractLiterals(stripComments(source), 'x.dart');
      expect(literals.single.value, 'https://app.badabhai.in/i/x');
    });

    test('adjacent-string concatenation is scanned piece by piece', () {
      const String source = "const String s = 'Aap ' 'theek ' 'hain';";
      final List<PersonaLiteral> literals =
          extractLiterals(stripComments(source), 'x.dart');
      expect(literals.length, 3);
    });
  });
}
