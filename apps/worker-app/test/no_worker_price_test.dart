// Permanent "free for workers" regression net for the WORKER APP (#2748, check 8).
//
// THE RULE. Workers never pay: no worker screen may show a price or a payment
// step, and no payment workflow or payment UI may exist in a mobile app at all
// (CLAUDE.md §12 — payment flows belong to the web apps). Sign-up, the chat, the
// résumé and applying are free.
//
// WHAT THIS SCANS, and why it is enough to lock that in:
//  - every string LITERAL under `lib/` (comments stripped). Every word a worker
//    can read in this app, and every route or endpoint it can call, is one. A
//    payment step needs a payment word or an amount somewhere; this finds it.
//  - every message in `lib/l10n/*.arb` — copy that reaches the screen through
//    gen-l10n rather than a Dart literal.
//  - `pubspec.yaml` — a payment SDK is a payment step waiting for a screen.
//
// The literal scanner is the persona test's own (`persona_neutrality_test.dart`),
// so the two nets read the source the same way: comments stripped, literals
// extracted with line numbers, a `//` inside a url never mistaken for a comment.
//
// AMOUNTS VS WAGES. A rupee sign is a price unless it is the worker's OWN pay:
// the band a job offers, the salary he expects, the pay filter. Those few files
// are allowlisted BY FILE below, each with its reason; a ₹ anywhere else fails.
// The payment WORDS have no file exemption at all.
//
// SCOPE. Static only. A price the server sent at runtime is not in the source;
// this net guards what the app itself can show and do.

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'persona_neutrality_test.dart'
    show PersonaLiteral, extractLiterals, stripComments;

// --- What a price or a payment step looks like -------------------------------

/// Words and phrases only a payment step or a price uses, in English and in the
/// app's Hinglish. Case-insensitive, whole words.
final List<RegExp> kPaymentPatterns = <RegExp>[
  RegExp(r'\bpayments?\b', caseSensitive: false),
  RegExp(r'\bcheck-?out\b', caseSensitive: false),
  RegExp(r'\bsubscri(be|bed|bes|bing|ption|ptions)\b', caseSensitive: false),
  RegExp(r'\bpurchas(e|es|ed|ing)\b', caseSensitive: false),
  RegExp(r'\bcredits?\b', caseSensitive: false),
  RegExp(r'\bprice[sd]?\b|\bpricing\b', caseSensitive: false),
  RegExp(r'\bfees?\b', caseSensitive: false),
  RegExp(
    r'\b(billing|invoice|refund|wallet|recharge|premium)\b',
    caseSensitive: false,
  ),
  RegExp(
    r'\b(upi|razorpay|paytm|phonepe|gpay|google pay|stripe|cashfree)\b',
    caseSensitive: false,
  ),
  // "Pay now" and its Hinglish forms — an instruction to pay.
  RegExp(
    r'\bpay\s+(now|karein|kijiye|karo|kare|kar\s+dein)\b',
    caseSensitive: false,
  ),
  // "...paise dekar / dein / bharein": paying money, in Hinglish.
  RegExp(
    r'\b(paise|paisa|rupaye|rupees?)\s+'
    r'(dekar|dein|de|bharein|bharna|jama|bhejein)\b',
    caseSensitive: false,
  ),
  // Buying, in English and in Hinglish ("khareedein / kharidein").
  RegExp(r'\bbuy(s|ing)?\b', caseSensitive: false),
  RegExp(r'\bkh(a|aa)r(i|ee)d(ein|e|na|o)\b', caseSensitive: false),
];

/// An amount of money: the rupee sign, or `Rs` / `INR` before a number or an
/// interpolated value.
final RegExp kAmountPattern = RegExp(
  r'₹|\b(rs\.?|inr)\s*(\d|\$)',
  caseSensitive: false,
);

/// The rupee sign written as an ESCAPE in source. The literal extractor
/// unescapes `\u20b9` into plain letters, so this is checked on the source text.
final RegExp kEscapedRupeePattern = RegExp(
  r'\\u\{?20b9\}?',
  caseSensitive: false,
);

// --- Allowlists --------------------------------------------------------------
//
// Every entry needs a one-line reason, and every entry must still match
// something ("no stale allowlist entry" below): an entry that matches nothing is
// a hole waiting for the wrong string. Keep both lists short.

/// Files whose ₹ is the WORKER'S OWN PAY — never a price. Path → reason.
const Map<String, String> kWageAmountFiles = <String, String>{
  'lib/core/util/pay_format.dart':
      "a job's monthly pay band, on job cards and job details",
  'lib/features/finishing/presentation/finishing_screen.dart':
      'the expected-salary bands the worker picks from',
  'lib/features/trade_form/presentation/widgets/trade_form_preferences_page.dart':
      'the expected-salary bands the worker picks from',
  'lib/features/resume/presentation/widgets/resume_card_slots.dart':
      "the worker's own salary, printed on his résumé card",
  'lib/features/swipe/domain/job_filter.dart':
      'the minimum-pay filter chips over the job feed',
  'lib/features/swipe/presentation/widgets/filters_sheet.dart':
      'the minimum-pay filter label over the job feed',
};

/// Exact literals that use a payment word without being a price or a payment
/// step. Literal → reason.
const Map<String, String> kNonPriceLiterals = <String, String>{
  '100% Safe & Secure • No agent fees':
      'says the worker pays NO fee (the SecureNote default)',
  'Agar koi company paise dekar aapki profile ':
      'the approved employer-sharing notice (versioned, verbatim): what a '
      'COMPANY pays — the worker pays nothing',
};

/// `_`-separated name parts that only a payment SDK's package name carries.
const Set<String> kPaymentSdkNameParts = <String>{
  'pay',
  'payment',
  'payments',
  'purchase',
  'purchases',
  'billing',
  'checkout',
  'upi',
  'razorpay',
  'stripe',
  'paytm',
  'phonepe',
  'cashfree',
  'payu',
  'braintree',
};

// --- Detector ------------------------------------------------------------------

/// Why [literal] reads as a price or a payment step, or `[]`. [wageFile] says
/// whether its file may show the worker's own pay.
List<String> priceViolations(String literal, {bool wageFile = false}) {
  if (kNonPriceLiterals.containsKey(literal)) return const <String>[];
  final List<String> hits = <String>[
    for (final RegExp p in kPaymentPatterns)
      if (p.hasMatch(literal)) 'payment word "${p.firstMatch(literal)![0]}"',
  ];
  if (!wageFile && kAmountPattern.hasMatch(literal)) {
    hits.add('amount "${kAmountPattern.firstMatch(literal)![0]}"');
  }
  return hits;
}

/// Whether a dependency named [name] is a payment SDK.
bool isPaymentSdk(String name) =>
    name.split('_').any(kPaymentSdkNameParts.contains);

// --- Sources -------------------------------------------------------------------

/// `lib/...` with forward slashes, whatever the host.
String _path(File f) => f.path.replaceAll(r'\', '/');

List<File> _libFiles(String extension) => Directory('lib')
    .listSync(recursive: true)
    .whereType<File>()
    .where((File f) => f.path.endsWith(extension))
    .toList();

/// Every literal under `lib/` — the persona scanner's view of the app.
List<PersonaLiteral> _allLibLiterals() => <PersonaLiteral>[
  for (final File file in _libFiles('.dart'))
    ...extractLiterals(stripComments(file.readAsStringSync()), _path(file)),
];

/// Every message in the ARB files. `@`-prefixed keys are translator notes,
/// never shown.
Map<String, String> _arbMessages() => <String, String>{
  for (final File file in _libFiles('.arb'))
    for (final MapEntry<String, dynamic> e
        in (jsonDecode(file.readAsStringSync()) as Map<String, dynamic>)
            .entries)
      if (!e.key.startsWith('@') && e.value is String)
        '${_path(file)}#${e.key}': e.value as String,
};

/// The package names under `dependencies:` and `dev_dependencies:`.
List<String> _pubspecPackages() {
  final List<String> names = <String>[];
  bool inDependencies = false;
  for (final String line in File('pubspec.yaml').readAsLinesSync()) {
    if (line.trim().isEmpty || line.trimLeft().startsWith('#')) continue;
    if (!line.startsWith(' ')) {
      inDependencies =
          line.startsWith('dependencies:') ||
          line.startsWith('dev_dependencies:');
      continue;
    }
    final RegExpMatch? m = RegExp(r'^  ([a-z0-9_]+):').firstMatch(line);
    if (inDependencies && m != null) names.add(m[1]!);
  }
  return names;
}

void main() {
  group('no worker screen shows a price or a payment step', () {
    test('no string literal under lib/ is a price or a payment step', () {
      final List<String> failures = <String>[
        for (final PersonaLiteral literal in _allLibLiterals())
          if (priceViolations(
            literal.value,
            wageFile: kWageAmountFiles.containsKey(literal.file),
          ).isNotEmpty)
            '$literal\n    → ${priceViolations(literal.value, wageFile: kWageAmountFiles.containsKey(literal.file)).join('; ')}',
      ];
      expect(
        failures,
        isEmpty,
        reason:
            'Workers never pay, so no worker screen may show a price or '
            'a payment step (CLAUDE.md §12). A ₹ that is the worker\'s OWN pay '
            'belongs in a file listed in kWageAmountFiles, with its reason.\n\n'
            '${failures.join('\n')}',
      );
    });

    test('no escaped rupee sign hides outside a wage file', () {
      final List<String> failures = <String>[
        for (final File file in _libFiles('.dart'))
          if (!kWageAmountFiles.containsKey(_path(file)) &&
              kEscapedRupeePattern.hasMatch(
                stripComments(file.readAsStringSync()),
              ))
            _path(file),
      ];
      expect(failures, isEmpty);
    });

    test('no l10n message is a price or a payment step', () {
      final Map<String, List<String>> failures = <String, List<String>>{
        for (final MapEntry<String, String> m in _arbMessages().entries)
          if (priceViolations(m.value).isNotEmpty)
            m.key: priceViolations(m.value),
      };
      expect(failures, isEmpty);
    });

    test('pubspec.yaml carries no payment SDK', () {
      final List<String> packages = _pubspecPackages();
      expect(
        packages,
        contains('flutter_bloc'),
        reason: 'the pubspec reader found no dependencies at all',
      );
      expect(packages.where(isPaymentSdk), isEmpty);
    });

    test('the scan actually reaches the whole app', () {
      // A scanner that silently found nothing would pass every test above.
      expect(_libFiles('.dart').length, greaterThan(100));
      expect(_allLibLiterals().length, greaterThan(1000));
      expect(_arbMessages(), isNotEmpty);
    });

    test('no stale allowlist entry', () {
      final List<PersonaLiteral> literals = _allLibLiterals();
      for (final String file in kWageAmountFiles.keys) {
        expect(
          literals.any(
            (PersonaLiteral l) =>
                l.file == file && kAmountPattern.hasMatch(l.value),
          ),
          isTrue,
          reason: '$file shows no ₹ any more — drop it from kWageAmountFiles',
        );
      }
      for (final String allowed in kNonPriceLiterals.keys) {
        expect(
          literals.any((PersonaLiteral l) => l.value == allowed),
          isTrue,
          reason:
              '"$allowed" is no longer in lib/ — drop it from '
              'kNonPriceLiterals',
        );
      }
    });
  });

  // --- The net must be able to FAIL ---------------------------------------------
  // The detector runs over strings written HERE, so the rules are proven to bite
  // without a price ever being committed to lib/.

  group('the detector bites', () {
    test('catches a payment step', () {
      for (final String s in <String>[
        'Payment karein',
        'Checkout',
        'Check-out',
        'Subscription lein',
        'Subscribe karein',
        'Purchase credits',
        'Aapke credits khatam',
        'Price dekhein',
        'Registration fee',
        'Wallet recharge karein',
        'UPI se bhejein',
        'Pay now',
        'Pay karein',
        'Paise dekar unlock karein',
        'Premium plan',
        'Buy now',
        'Abhi khareedein',
        '/payments/checkout',
      ]) {
        expect(priceViolations(s), isNotEmpty, reason: s);
      }
    });

    test('catches an amount outside a wage file', () {
      for (final String s in <String>[
        '₹1',
        'Sirf ₹1 mein',
        r'₹${amount}',
        'Rs. 1',
        'Rs 1',
        r'Rs. $price',
        'INR 1',
      ]) {
        expect(priceViolations(s), isNotEmpty, reason: s);
      }
      expect(kEscapedRupeePattern.hasMatch(r"'\u20b91'"), isTrue);
      expect(kEscapedRupeePattern.hasMatch(r"'\u{20B9}1'"), isTrue);
    });

    test("a wage file may show the worker's pay, never a payment word", () {
      expect(priceViolations('₹1+', wageFile: true), isEmpty);
      expect(priceViolations('₹1–2 hazaar', wageFile: true), isEmpty);
      expect(priceViolations('₹1 payment karein', wageFile: true), isNotEmpty);
    });

    test('does NOT fire on ordinary worker copy', () {
      for (final String s in <String>[
        'BadaBhai workers ke liye bilkul free hai.',
        'Bilkul free',
        'Minimum pay',
        'Overtime pay',
        'Trade, city, shift, pay dhoondein',
        'Mahine ki salary kitni chahte hain?',
        'BadaBhai unlock karein',
        'Payer',
        'Status',
        'Check out these jobs',
      ]) {
        expect(priceViolations(s), isEmpty, reason: s);
      }
    });

    test('an allowlisted literal is exempt only verbatim', () {
      expect(priceViolations('100% Safe & Secure • No agent fees'), isEmpty);
      expect(priceViolations('Agent fees: ₹1'), isNotEmpty);
    });

    test('flags a payment SDK by its package name', () {
      expect(isPaymentSdk('razorpay_flutter'), isTrue);
      expect(isPaymentSdk('flutter_stripe'), isTrue);
      expect(isPaymentSdk('in_app_purchase'), isTrue);
      expect(isPaymentSdk('purchases_flutter'), isTrue);
      expect(isPaymentSdk('pay'), isTrue);
      expect(isPaymentSdk('flutter_bloc'), isFalse);
      expect(isPaymentSdk('play_install_referrer'), isFalse);
      expect(isPaymentSdk('firebase_remote_config'), isFalse);
    });
  });
}
