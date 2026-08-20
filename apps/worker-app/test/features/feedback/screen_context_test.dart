import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/features/feedback/domain/screen_context.dart';

/// THE CLIENT HALF OF A CROSS-LANGUAGE CONTRACT.
///
/// `normalizeScreenContext` (Dart) and `sanitizeScreenContext` (TypeScript,
/// `apps/api/src/common/screen-context.ts`) must make the SAME decision about the
/// same string. Nothing in either build can check that — there is no shared test
/// runner and no shared type — so this file pins the same constant and, case for
/// case, the same EXAMPLE STRINGS as `apps/api/src/common/screen-context.test.ts`.
/// A repo that has been bitten by a mock which accepted anything does not get to
/// call "the server normalizes too" a test.
///
/// And it is written for what the normalizer PERMITS as much as for what it
/// strips: a rule that rejects everything passes every "does it catch X" test and
/// is discovered only when it silently deletes the screen label off every real
/// report.
void main() {
  test('the bound is the SERVER\'s number, pinned as a literal', () {
    // WORKER_FEEDBACK_SCREEN_MAX in packages/types, and the
    // `worker_feedback_screen_context_len_chk` CHECK. Every other test in this
    // file reads the constant, so none of them can catch the constant itself
    // being wrong — which is exactly how a hand-copied cross-language number
    // drifts.
    expect(kWorkerFeedbackScreenMax, 128);
  });

  group('the four shapes the contract turns on', () {
    // ── 1. A UUID SEGMENT. Every entity id on this platform is a uuid in a
    // path, and `/jobs/<uuid>/apply` ties a feedback row to ONE specific job —
    // a fact about the worker nobody asked them to disclose, and the reason the
    // stored value is a pattern at all.
    test('a uuid segment becomes :id', () {
      expect(
        normalizeScreenContext(
            '/jobs/6f2c04e0-4f89-41d3-9a0c-0305e82c3301/apply'),
        '/jobs/:id/apply',
      );
    });

    // ── 2. AN ALL-NUMERIC SEGMENT. Not every id is a uuid.
    test('an all-numeric segment becomes :id', () {
      expect(normalizeScreenContext('/orders/91723'), '/orders/:id');
    });

    // ── 3. A QUERY STRING — the likeliest place a client parks worker input.
    test('the query string is dropped', () {
      expect(
        normalizeScreenContext('/search?q=welder%20mumbai&page=2'),
        '/search',
      );
    });

    // ── 4. AN ORDINARY ROUTE, WHICH MUST SURVIVE UNCHANGED. This is the case
    // that stops the whole feature from quietly becoming "screen: unknown" on
    // every row — a normalizer that only ever strips is indistinguishable from a
    // normalizer that always returns null until someone reads the admin list.
    test('an ordinary route survives byte for byte', () {
      expect(normalizeScreenContext('/settings/notifications'),
          '/settings/notifications');
    });
  });

  group('identifiers never survive (mirrors screen-context.test.ts)', () {
    test('EVERY id in a path, not only the first', () {
      // A single-substitution implementation passes the uuid case above and leaks
      // the second id — which on this platform is the session id.
      expect(
        normalizeScreenContext(
          '/workers/6f2c04e0-4f89-41d3-9a0c-0305e82c3301'
          '/sessions/11111111-2222-4333-8444-555555555555',
        ),
        '/workers/:id/sessions/:id',
      );
    });

    test('a uuid whose version nibble is not one we mint today', () {
      // v7, or one a client generated loosely, is still an IDENTIFIER.
      expect(normalizeScreenContext('/jobs/018f4c7a-9b21-7c3d-0e5f-0a1b2c3d4e5f'),
          '/jobs/:id');
    });

    test('an UPPERCASE uuid', () {
      expect(
        normalizeScreenContext(
            '/workers/6F2C04E0-4F89-41D3-9A0C-0305E82C3301/profile'),
        '/workers/:id/profile',
      );
    });

    test('BOTH the fragment and the query are dropped, in either order', () {
      // What is load-bearing is that BOTH cuts exist — not their order. Measured:
      // swapping them changes no result, because each cut keeps the prefix before
      // its marker, so whichever marker comes FIRST truncates the value either
      // way. The test that used to sit here asserted the order was load-bearing
      // and passed under both orders, which is a test that cannot fail.
      expect(normalizeScreenContext('/profile#section?tab=skills'), '/profile');
      expect(normalizeScreenContext('/a#b?c'), '/a');
      expect(normalizeScreenContext('/a?b#c'), '/a');
      expect(normalizeScreenContext('/a#b?c#d'), '/a');
      expect(normalizeScreenContext('/a?b#c?d'), '/a');
    });

    test('a long query string does not cost the route its name', () {
      // The pre-bound is measured against the CUT path, not the raw value. Held
      // against `raw` it discarded ordinary short routes: the query cut and the
      // trim are unbounded shrinks that run after it, so a 1281-character
      // `/jobs?<...>` normalized to null — "unknown screen" for a worker who was
      // plainly on /jobs.
      expect(normalizeScreenContext('/jobs?${'x' * 1275}'), '/jobs');
      expect(normalizeScreenContext('/jobs#${'x' * 1275}'), '/jobs');
      expect(normalizeScreenContext('/search?q=${'a' * 1400}'), '/search');
      expect(normalizeScreenContext('/jobs${' ' * 1300}'), '/jobs');
      // The bound still exists, on the part that survives the cuts.
      expect(normalizeScreenContext('/${'a' * 1300}'), isNull);
    });

    test('the charset is exactly what the server pattern admits', () {
      // A BACKSTOP for `_kScreenCharset`. Widening it is the drift that happens
      // the first time a route needs one of these, and it costs data on the
      // SERVER side (the value is stored NULL), which no client test would ever
      // see. Every one of these is a legal RFC 3986 path character that the
      // shared `WORKER_FEEDBACK_SCREEN_PATTERN` nonetheless refuses.
      const List<String> refused = <String>[
        '/jobs/~me', '/jobs/@me', '/jobs/a+b', '/jobs/a,b', '/jobs/a;b',
        r'/jobs/a$b', "/jobs/a'b", '/jobs/a(b', '/jobs/a)b', '/jobs/a*b',
        '/jobs/a=b', '/jobs/a!b', '/jobs/a&b', '/jobs/a[b', '/jobs/a]b',
        '/jobs/a^b', '/jobs/a`b', '/jobs/a{b', '/jobs/a}b', '/jobs/a|b',
        r'/jobs/a\b', '/jobs/a%20b', '/jobs/a b', '/jobs/a"b', '/jobs/a<b',
        '/jobs/a>b',
      ];
      for (final String input in refused) {
        expect(normalizeScreenContext(input), isNull, reason: input);
      }
      // ...and the ones it DOES admit stay admitted.
      expect(normalizeScreenContext('/a.b/C_d-e'), '/a.b/C_d-e');
      expect(normalizeScreenContext('/jobs/:id/apply'), '/jobs/:id/apply');
    });

    test('no output ever contains a uuid or a bare digit run', () {
      // The structural version, so it keeps holding for a shape nobody has
      // written a case for yet.
      const List<String> inputs = <String>[
        '/jobs/6f2c04e0-4f89-41d3-9a0c-0305e82c3301',
        '/a/1/b/22/c/333',
        '/chat/6f2c04e0-4f89-41d3-9a0c-0305e82c3301?from=/jobs/9',
        '/workers/6F2C04E0-4F89-41D3-9A0C-0305E82C3301/profile',
      ];
      final RegExp uuid = RegExp(
        r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
        caseSensitive: false,
      );
      for (final String input in inputs) {
        final String? out = normalizeScreenContext(input);
        expect(out, isNotNull, reason: input);
        expect(uuid.hasMatch(out!), isFalse, reason: input);
        expect(
          out.split('/').any((String s) => RegExp(r'^[0-9]+$').hasMatch(s)),
          isFalse,
          reason: input,
        );
      }
    });
  });

  group('sanitize, never reject — a bad route never costs a message', () {
    const Map<String, String?> cases = <String, String?>{
      'null': null,
      'an empty string': '',
      'whitespace only': '   ',
      'an unrooted path': 'jobs/apply',
      'a full URL': 'https://badabhai.ai/jobs',
      // A rooted path by every naive check, and a SCHEME-RELATIVE URL to a host
      // we do not control — rendered as a link on the admin screen it is an
      // outbound navigation an attacker chose.
      'a scheme-relative URL': '//evil.example/jobs',
      'a doubled slash anywhere': '/jobs//apply',
      'markup': '/jobs/<script>alert(1)</script>',
      'whitespace inside': '/jobs/my job',
      'percent-encoding': '/jobs/%2e%2e%2fadmin',
      'a newline': '/jobs\n/admin',
      'non-ASCII': '/नौकरी/आवेदन',
    };
    cases.forEach((String label, String? raw) {
      test('returns null for $label', () {
        expect(normalizeScreenContext(raw), isNull);
      });
    });

    test('null past the bound rather than a truncation', () {
      // A truncated route pattern names a screen nobody can navigate to and
      // looks authoritative on the admin list. Null reads as "unknown screen".
      expect(
        normalizeScreenContext('/${'a' * kWorkerFeedbackScreenMax}'),
        isNull,
      );
      expect(
        normalizeScreenContext('/${'a' * (kWorkerFeedbackScreenMax - 1)}'),
        isNotNull,
      );
    });

    test('the bound is measured AFTER substitution', () {
      // Four uuid segments is 148 raw characters — over the bound — and 20 once
      // normalized. The deep screens are exactly the ones a "button kaam nahi kar
      // raha" report is about, so measuring before substitution would discard the
      // reports that matter most.
      final String raw = '/a/6f2c04e0-4f89-41d3-9a0c-0305e82c3301' * 4;
      expect(raw.length, greaterThan(kWorkerFeedbackScreenMax));
      expect(normalizeScreenContext(raw), '/a/:id/a/:id/a/:id/a/:id');
    });

    test('never throws', () {
      for (final String? raw in <String?>[
        null,
        '/',
        '?',
        '#',
        '/' * 5000,
      ]) {
        expect(() => normalizeScreenContext(raw), returnsNormally);
      }
    });
  });

  group('what it PERMITS — the half a strip-everything bug would pass', () {
    test('the root, a plain route, a trailing slash, and surrounding spaces', () {
      expect(normalizeScreenContext('/'), '/');
      expect(normalizeScreenContext('/home'), '/home');
      expect(normalizeScreenContext('/jobs/'), '/jobs/');
      expect(normalizeScreenContext('  /settings/notifications  '),
          '/settings/notifications');
    });

    test('REAL worker-app routes reach the admin unchanged', () {
      // If these did not survive, every feedback row would read "unknown screen"
      // and the whole change would be inert while looking like it shipped.
      const List<String> routes = <String>[
        '/resume',
        '/jobs',
        '/profile',
        '/chat',
        '/alerts',
        '/settings',
        '/applied',
        '/invite',
        '/consent',
        '/name',
      ];
      for (final String route in routes) {
        expect(normalizeScreenContext(route), route, reason: route);
      }
    });

    test('a route pattern that already carries :id is left alone', () {
      // `:` is in the charset for exactly one reason — the substitution marker —
      // so a value that has already been normalized must be idempotent.
      expect(normalizeScreenContext('/jobs/:id/apply'), '/jobs/:id/apply');
      expect(
        normalizeScreenContext(normalizeScreenContext('/orders/91723')),
        '/orders/:id',
      );
    });

    test('a hyphenated, dotted or capitalised segment is structure, not an id',
        () {
      expect(normalizeScreenContext('/jobs/detail/job-1'), '/jobs/detail/job-1');
      expect(normalizeScreenContext('/pin/set'), '/pin/set');
      // The shared charset is `[A-Za-z0-9._:/-]` — dot, UNDERSCORE, colon,
      // slash, hyphen. Read it wrong in either language and the two halves
      // disagree about a perfectly ordinary route, which is precisely the drift
      // this file exists to catch.
      expect(normalizeScreenContext('/a.b/C_d-e'), '/a.b/C_d-e');
    });
  });
}
