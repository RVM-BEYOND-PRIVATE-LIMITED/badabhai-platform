import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/features/jobs/presentation/widgets/job_content_input.dart';

/// #1946 — the payer-app client email mirror is the LINEAR shape, and no verdict
/// moved. `[^\s@]+@` is quadratic on a long run with no "@" (every start
/// position re-scans the run); matching only the character before the "@"
/// changes no verdict for a yes/no `hasMatch`, because a local part always ends
/// in one.
void main() {
  group('looksLikePostingPii — the email shape (#1946)', () {
    // THE PRE-#1924 payer-app oracle: the quadratic email pattern. Its email
    // scan is quadratic, so it only ever sees short strings here.
    final RegExp pre1946EmailLike = RegExp(r'[^\s@]+@[^\s@]+\.[^\s@]+');
    final RegExp phoneSeparators = RegExp(r'[\s().+-]');
    final RegExp phoneDigitRun = RegExp(r'\d{7,}');
    bool pre1946LooksLikePii(String s) =>
        pre1946EmailLike.hasMatch(s) ||
        phoneDigitRun.hasMatch(s.replaceAll(phoneSeparators, ''));

    const List<String> emails = <String>[
      'contact me at foo@bar.com',
      'my email is a@b.co',
      'first.last+tag@mail.example.co.in',
      'Mail ravi.kumar@gmail.com now',
      'x@y.z',
      '@@a@b.co',
      'a@b@c.in',
      'रमेश@उदा.भारत',
    ];

    for (final String s in emails) {
      test('flags the email shape "$s"', () {
        expect(looksLikePostingPii(s), isTrue);
        expect(pre1946LooksLikePii(s), isTrue);
      });
    }

    const List<String> nearMisses = <String>[
      'a@b',
      '@b.com',
      'a @b.com',
      'a@ b.com',
      'a@.com',
      'a@b.',
      'a@@b.com',
      'rate @ 500.00',
      'user@localhost',
    ];

    for (final String s in nearMisses) {
      test('does not flag the near-miss "$s"', () {
        expect(looksLikePostingPii(s), isFalse);
        expect(pre1946LooksLikePii(s), isFalse);
      });
    }

    test('agrees with the pre-#1946 oracle on seeded near-misses', () {
      const List<String> chars = <String>[
        'a', 'b', 'c', 'X', 'Y', 'Z', '0', '1', '9', '.', '_', '+', '-', '@', ' ', 'é', 'क'
      ];
      int seed = 0x1946;
      int next() {
        seed = (seed * 1664525 + 1013904223) & 0xFFFFFFFF;
        return seed;
      }

      String run(int max) {
        final int n = next() % (max + 1);
        final StringBuffer out = StringBuffer();
        for (int i = 0; i < n; i++) {
          out.write(chars[next() % chars.length]);
        }
        return out.toString();
      }

      for (int i = 0; i < 2000; i++) {
        final String s =
            '${run(12)}${next() % 10 < 7 ? '@' : ''}${run(12)}${next() % 10 < 7 ? '.' : ''}${run(6)}';
        expect(looksLikePostingPii(s), pre1946LooksLikePii(s), reason: s);
      }
    });
  });
}
