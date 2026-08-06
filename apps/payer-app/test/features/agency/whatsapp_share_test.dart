import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/features/agency/util/whatsapp_share.dart';

void main() {
  group('whatsAppShareUri', () {
    test('builds the contact-picker form — no phone number in the path', () {
      final Uri uri = whatsAppShareUri('hello https://app.badabhai.in/i/abc123');
      expect(uri.scheme, 'https');
      expect(uri.host, 'wa.me');
      // A number here would open a chat with THAT number instead of letting the
      // agent choose a recipient.
      expect(uri.path, '/');
      expect(uri.queryParameters['text'], 'hello https://app.badabhai.in/i/abc123');
    });

    test('percent-encodes the text so the link survives the query string', () {
      // `&`, `#`, `?` and `+` all terminate or alter a query if left raw — a
      // referral url carrying one would arrive at WhatsApp truncated.
      final Uri uri = whatsAppShareUri('a&b#c?d+e https://x.test/i/1');
      expect(uri.queryParameters['text'], 'a&b#c?d+e https://x.test/i/1');
      expect(uri.toString(), contains('%26'));
      expect(uri.toString(), contains('%23'));
    });

    test('handles Hinglish/Devanagari text without mangling it', () {
      final Uri uri = whatsAppShareUri('नौकरी https://x.test/i/1');
      expect(uri.queryParameters['text'], 'नौकरी https://x.test/i/1');
    });
  });

  group('inviteShareText', () {
    test('carries the url and nothing that could identify a person', () {
      final String text = inviteShareText('https://app.badabhai.in/i/abc123');
      expect(text, contains('https://app.badabhai.in/i/abc123'));
      // The agency has no recipient identity at mint time and none may appear.
      expect(text, isNot(contains('@')));
      expect(RegExp(r'\d{10}').hasMatch(text), isFalse);
    });
  });

  group('shareOnWhatsApp', () {
    tearDown(() => whatsAppLauncher = defaultWhatsAppLauncher);

    test('returns true and passes the composed uri to the launcher', () async {
      Uri? seen;
      whatsAppLauncher = (Uri url) async {
        seen = url;
        return true;
      };
      expect(await shareOnWhatsApp('hi /i/1'), isTrue);
      expect(seen?.host, 'wa.me');
    });

    test('returns false when the launcher declines', () async {
      whatsAppLauncher = (Uri url) async => false;
      expect(await shareOnWhatsApp('hi'), isFalse);
    });

    test('SWALLOWS a throwing launcher and reports false', () async {
      // `launchUrl` raises MissingPluginException/PlatformException depending on
      // the device; a share button must never surface a raw platform crash.
      whatsAppLauncher = (Uri url) async => throw Exception('no activity found');
      expect(await shareOnWhatsApp('hi'), isFalse);
    });
  });
}
