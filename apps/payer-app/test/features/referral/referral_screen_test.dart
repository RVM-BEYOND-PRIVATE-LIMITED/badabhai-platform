import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';

import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/features/agency/util/whatsapp_share.dart';
import 'package:payer_app/features/referral/presentation/referral_screen.dart';

/// The agency Refer-&-earn screen renders the real invite link + funnel summary
/// (mock seam) and the copy action puts the link on the clipboard. PII-free:
/// only an opaque code/link + aggregate counts, never a per-worker row.
void main() {
  // An in-memory fake for the Clipboard platform channel — the real plugin is
  // absent under `flutter test`, so Clipboard.setData would otherwise throw.
  final Map<String, Object?> clipboard = <String, Object?>{'text': null};

  setUp(() async {
    clipboard['text'] = null;
    TestWidgetsFlutterBinding.ensureInitialized();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform,
            (MethodCall call) async {
      switch (call.method) {
        case 'Clipboard.setData':
          clipboard['text'] =
              (call.arguments as Map<Object?, Object?>)['text'];
          return null;
        case 'Clipboard.getData':
          return <String, Object?>{'text': clipboard['text']};
        default:
          return null;
      }
    });

    await GetIt.instance.reset();
    setupLocator(
      apiClient: MockPayerApiClient(),
      secureStore: InMemoryKeyValueStore(),
    );
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null);
  });

  Future<void> pump(WidgetTester tester) async {
    await tester.pumpWidget(const MaterialApp(home: ReferralScreen()));
    await tester.pumpAndSettle();
  }

  testWidgets('renders the invite link and the funnel counts', (
    WidgetTester tester,
  ) async {
    await pump(tester);

    expect(find.text('Refer & earn'), findsOneWidget);
    // The mock returns the wire shape (`/i/<code>`, path-only); the screen
    // renders the ABSOLUTE url, because that is what it copies and shares.
    expect(find.text('https://app.badabhai.in/i/APEX-7K2'), findsOneWidget);
    expect(find.textContaining('APEX-7K2'), findsWidgets);
    // Funnel section + the mock aggregate counts (24 / 11 / 6).
    expect(find.text('Your funnel'), findsOneWidget);
    expect(find.text('24'), findsOneWidget);
    expect(find.text('11'), findsOneWidget);
    expect(find.text('6'), findsOneWidget);
  });

  testWidgets('copying the link puts the invite URL on the clipboard + toasts', (
    WidgetTester tester,
  ) async {
    await pump(tester);

    await tester.tap(find.text('Copy link'));
    await tester.pump(); // run the async copy handler
    await tester.pump(const Duration(milliseconds: 400)); // toast animates in

    final ClipboardData? data = await Clipboard.getData(Clipboard.kTextPlain);
    // ABSOLUTE, not the raw `/i/APEX-7K2` the wire carries — a bare path on the
    // clipboard resolves to nothing once pasted into WhatsApp.
    expect(data?.text, 'https://app.badabhai.in/i/APEX-7K2');
    expect(find.text('Link copied'), findsOneWidget);

    // Let the ~2.4s auto-dismiss timer fire so it does not outlive the test.
    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
  });

  testWidgets('Share on WhatsApp opens wa.me with the ABSOLUTE link pre-filled', (
    WidgetTester tester,
  ) async {
    final List<Uri> launched = <Uri>[];
    whatsAppLauncher = (Uri url) async {
      launched.add(url);
      return true;
    };
    addTearDown(() => whatsAppLauncher = defaultWhatsAppLauncher);

    await pump(tester);
    await tester.tap(find.text('Share on WhatsApp'));
    await tester.pump();

    expect(launched, hasLength(1));
    final Uri uri = launched.single;
    expect(uri.scheme, 'https');
    expect(uri.host, 'wa.me');
    // The message must carry the ABSOLUTE link — the whole point of the fix.
    expect(uri.queryParameters['text'], contains('https://app.badabhai.in/i/APEX-7K2'));
    // …and no phone number in the path, so WhatsApp opens the contact picker.
    expect(uri.path, '/');

    await tester.pumpAndSettle();
  });

  testWidgets('a WhatsApp launch that fails says so instead of silently no-oping', (
    WidgetTester tester,
  ) async {
    whatsAppLauncher = (Uri url) async => false;
    addTearDown(() => whatsAppLauncher = defaultWhatsAppLauncher);

    await pump(tester);
    await tester.tap(find.text('Share on WhatsApp'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.text('WhatsApp not available'), findsOneWidget);

    await tester.pump(const Duration(seconds: 3));
    await tester.pumpAndSettle();
  });
}
