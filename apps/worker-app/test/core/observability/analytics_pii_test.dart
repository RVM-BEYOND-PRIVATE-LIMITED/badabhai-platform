// B7 Analytics — the no-PII net (BadaBhai invariant #2).
//
// Analytics is the easiest place in the app to leak: a `parameters` map takes
// `Object`, so a worker id, a phone, or a chunk of transcript can be added in
// one line and nothing complains. These tests scan EVERY event this app can
// emit, plus the screen-name normaliser, for anything id- or PII-shaped.

import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/observability/analytics.dart';

/// Parameter KEYS that would name an identifier or a piece of PII. Matched on
/// whole words so `turn_count` and `purpose_count` stay legal.
final RegExp _kPiiKey = RegExp(
  r'(^|_)(id|uuid|guid|worker|payer|user|phone|mobile|msisdn|name|email|'
  r'address|city|pincode|employer|company|token|otp|pin|code|referral|'
  r'transcript|message|text|resume|query)($|_)',
  caseSensitive: false,
);

/// VALUE shapes that are identifiers or personal data.
final Map<String, RegExp> _kPiiValue = <String, RegExp>{
  'uuid': RegExp(
      r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
      caseSensitive: false),
  'long hex token (e.g. a referral code or a hash)':
      RegExp(r'^[0-9a-f]{12,}$', caseSensitive: false),
  'phone number': RegExp(r'(\+?\d[\d\s\-]{8,})'),
  'email': RegExp(r'[^@\s]+@[^@\s]+\.[^@\s]+'),
  'bearer/JWT-ish token': RegExp(r'^[A-Za-z0-9_\-]{20,}\.'),
  'url (can carry a code in its path or query)': RegExp(r'https?://'),
};

void main() {
  group('no event parameter is id- or PII-shaped', () {
    test('every funnel event passes the scan', () {
      for (final BbAnalyticsEvent event in BbAnalytics.debugAllFunnelEvents) {
        event.parameters.forEach((String key, Object value) {
          expect(_kPiiKey.hasMatch(key), isFalse,
              reason: '${event.name}: parameter key "$key" names an '
                  'identifier or personal field');

          // Numbers and booleans cannot carry PII — counts and flags are the
          // whole point. Only STRINGS need shape checking.
          if (value is num || value is bool) return;
          expect(value, isA<String>(),
              reason: '${event.name}.$key must be a count, a flag, or a short '
                  'fixed token — never a structured object');

          final String text = value as String;
          _kPiiValue.forEach((String label, RegExp pattern) {
            expect(pattern.hasMatch(text), isFalse,
                reason: '${event.name}.$key looks like $label: "$text"');
          });
          // A short fixed token (an enum-like value) is fine; free text is not.
          expect(text.length, lessThanOrEqualTo(32),
              reason: '${event.name}.$key is long enough to be free text, '
                  'which is where worker content leaks in');
          expect(text.contains(' '), isFalse,
              reason: '${event.name}.$key contains a space — a fixed token '
                  'never does, a sentence always does');
        });
      }
    });

    test('the scan covers a non-empty, complete set of events', () {
      final List<BbAnalyticsEvent> events = BbAnalytics.debugAllFunnelEvents;
      // The four milestones that mirror the server event spine.
      expect(
        events.map((BbAnalyticsEvent e) => e.name),
        containsAll(<String>[
          'bb_consent_done',
          'bb_chat_wrap_up',
          'bb_resume_ready',
          'bb_invite_shared',
          // Voice-form action signals (#639).
          'question_audio_played',
          'profiling_answer_spoken',
          // Finishing-form funnel (#1315).
          'bb_finishing_entered',
          'bb_finishing_page',
          'bb_finishing_submitted',
        ]),
      );
    });

    test('event names are legal Firebase names and use our own prefix', () {
      for (final BbAnalyticsEvent event in BbAnalytics.debugAllFunnelEvents) {
        expect(event.name, matches(RegExp(r'^[a-z][a-z0-9_]*$')),
            reason: '${event.name} is not a legal Firebase event name');
        expect(event.name.length, lessThanOrEqualTo(40));
        // Firebase silently DROPS events using its reserved prefixes.
        for (final String reserved in <String>['firebase_', 'google_', 'ga_']) {
          expect(event.name.startsWith(reserved), isFalse,
              reason: '${event.name} uses the reserved prefix "$reserved"');
        }
      }
    });

    test('the PII detector itself bites', () {
      // A net that cannot fail is not a net. These are the exact shapes the
      // scan above must reject if someone adds them.
      expect(_kPiiKey.hasMatch('worker_id'), isTrue);
      expect(_kPiiKey.hasMatch('phone'), isTrue);
      expect(_kPiiKey.hasMatch('referral_code'), isTrue);
      expect(_kPiiKey.hasMatch('full_name'), isTrue);
      expect(_kPiiKey.hasMatch('transcript'), isTrue);
      // The voice-form events (#639) MUST NOT carry a question id — if someone
      // ever swapped the count for one, the detector has to bite.
      expect(_kPiiKey.hasMatch('question_id'), isTrue);
      // The finishing funnel (#1315) MUST NOT carry a page id either.
      expect(_kPiiKey.hasMatch('page_id'), isTrue);
      // …and must NOT reject the legitimate ones.
      expect(_kPiiKey.hasMatch('turn_count'), isFalse);
      expect(_kPiiKey.hasMatch('purpose_count'), isFalse);
      expect(_kPiiKey.hasMatch('question_index'), isFalse);
      expect(_kPiiKey.hasMatch('page_index'), isFalse);

      expect(
          _kPiiValue['uuid']!
              .hasMatch('9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f'),
          isTrue);
      expect(_kPiiValue['phone number']!.hasMatch('+919812345678'), isTrue);
      expect(_kPiiValue['email']!.hasMatch('a@b.co'), isTrue);
      expect(_kPiiValue['long hex token (e.g. a referral code or a hash)']!
          .hasMatch('abcdef012345'), isTrue);
    });
  });

  group('screen names are id-free templates', () {
    test('an id in the path is masked', () {
      expect(
        analyticsScreenName('/jobs/detail/9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f'),
        '/jobs/detail/:id',
      );
      expect(analyticsScreenName('/i/abcdef012345'), '/i/:id');
      expect(analyticsScreenName('/jobs/detail/12345'), '/jobs/detail/:id');
    });

    test('real route names survive unmasked', () {
      expect(analyticsScreenName('/resume'), '/resume');
      expect(analyticsScreenName('/profile/settings/devices'),
          '/profile/settings/devices');
      expect(analyticsScreenName('/profile/kit/detail/cnc_vmc'),
          '/profile/kit/detail/cnc_vmc');
      expect(analyticsScreenName('/'), '/');
      expect(analyticsScreenName(''), '/');
    });

    test('query and fragment are dropped whole', () {
      // The most likely place for something identifying to ride along.
      expect(analyticsScreenName('/jobs?code=abcdef012345'), '/jobs');
      expect(analyticsScreenName('/resume#section'), '/resume');
    });

    test('no screen name the app can produce carries an id shape', () {
      const List<String> locations = <String>[
        '/',
        '/login',
        '/otp',
        '/pin',
        '/consent',
        '/name',
        '/chat',
        '/voice',
        '/invite',
        '/profiling',
        '/building',
        '/jobs',
        '/jobs/detail/9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f',
        '/resume',
        '/resume/edit',
        '/profile',
        '/profile/settings',
        '/profile/applied',
        '/profile/kit',
        '/alerts',
        '/i/abcdef012345',
      ];
      for (final String location in locations) {
        final String name = analyticsScreenName(location);
        _kPiiValue.forEach((String label, RegExp pattern) {
          expect(pattern.hasMatch(name), isFalse,
              reason: 'screen name "$name" (from "$location") looks like $label');
        });
      }
    });
  });
}
