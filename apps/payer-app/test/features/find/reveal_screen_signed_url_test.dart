import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';

import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/features/find/presentation/reveal_args.dart';
import 'package:payer_app/features/find/presentation/reveal_screen.dart';

/// #354 — the SIGNED masked-résumé url must be LAUNCHED, never copied.
///
/// It is a bearer capability: anyone holding it can fetch the worker's résumé
/// with no BadaBhai auth until the signature expires. The screen used to end
/// `_downloadResume` with `Clipboard.setData(...)` + a "Secure PDF link copied
/// to clipboard" toast — and the OS clipboard is readable by any focused
/// app/IME, is synced off-device by Gboard/Samsung/Windows Phone Link, and
/// persists in clipboard history, so the capability outlived the screen.
///
/// Every assertion below FAILS against that old behaviour. The relay-handle copy
/// is deliberately still asserted as a KEPT affordance: the handle is an opaque
/// in-app relay identifier, not a capability url.

/// The url `MockPayerApiClient.disclose` hands back. Nothing in the UI, the
/// clipboard, or a log may ever contain it.
const String _signedUrl = 'https://mock.badabhai.in/resume/masked.pdf';

const Applicant _applicant = Applicant(
  workerId: 'a1b2c3d4-5566-4777-8888-99990000abcd',
  rank: 1,
  score: 0.92,
  hot: false,
  pushEligible: false,
  tradeLabel: 'CNC Setter',
  experienceBand: '5-8 yrs',
  cityLabel: 'Pune',
  unlocked: true,
  unlockId: 'unlock-1',
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  /// Everything that crossed SystemChannels.platform — the channel
  /// `Clipboard.setData` rides. Spying on the CHANNEL (not on a Clipboard
  /// wrapper) is what makes this a real leak test: any future re-introduction of
  /// a clipboard write, by any code path, shows up here.
  late List<MethodCall> platformCalls;

  /// Urls handed to the launcher seam, in order.
  late List<Uri> launched;

  /// What the fake launcher reports back (false = no app could open it).
  late bool launchSucceeds;

  List<String> clipboardWrites() => platformCalls
      .where((MethodCall c) => c.method == 'Clipboard.setData')
      .map((MethodCall c) => (c.arguments as Map<Object?, Object?>)['text'] as String)
      .toList();

  setUp(() async {
    platformCalls = <MethodCall>[];
    launched = <Uri>[];
    launchSucceeds = true;

    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform,
            (MethodCall call) async {
      platformCalls.add(call);
      return null;
    });

    revealSignedUrlLauncher = (Uri url) async {
      launched.add(url);
      return launchSucceeds;
    };

    await GetIt.instance.reset();
    setupLocator(
      apiClient: MockPayerApiClient(),
      secureStore: InMemoryKeyValueStore(),
    );
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null);
    // Restore the real launcher so a later test can never silently run against
    // this fake.
    revealSignedUrlLauncher = defaultSignedUrlLauncher;
  });

  Future<void> pump(WidgetTester tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: RevealScreen(
            args: const RevealArgs.real(
              applicant: _applicant,
              unlockId: 'unlock-1',
            ),
            onBack: () {},
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  Future<void> tapResumeRow(WidgetTester tester) async {
    final Finder row = find.text('Masked résumé');
    await tester.ensureVisible(row);
    await tester.pumpAndSettle();
    await tester.tap(row);
    await tester.pumpAndSettle();
  }

  testWidgets('tapping the résumé row LAUNCHES the signed url', (
    WidgetTester tester,
  ) async {
    await pump(tester);
    await tapResumeRow(tester);

    expect(launched, <Uri>[Uri.parse(_signedUrl)]);
    expect(find.text('Masked résumé opened'), findsOneWidget);
  });

  testWidgets('the signed url NEVER reaches the clipboard', (
    WidgetTester tester,
  ) async {
    await pump(tester);
    await tapResumeRow(tester);

    // The core regression: pre-fix this was exactly [_signedUrl].
    expect(clipboardWrites(), isEmpty);
    expect(clipboardWrites(), isNot(contains(_signedUrl)));
  });

  testWidgets('the signed url is never rendered on screen either', (
    WidgetTester tester,
  ) async {
    await pump(tester);
    await tapResumeRow(tester);

    // Not in the toast, not in the row subtitle, not anywhere — a url on screen
    // is screenshot-able and shoulder-surf-able, the same capability leak by a
    // different route.
    expect(find.textContaining('mock.badabhai.in'), findsNothing);
    expect(find.textContaining('https://'), findsNothing);
    // And the old copy must be gone from the ready-state subtitle.
    expect(find.textContaining('copied to clipboard'), findsNothing);
    expect(find.text('Secure PDF link copied · tap to refresh'), findsNothing);
  });

  testWidgets(
      'a failed launch shows the honest cause and STILL does not copy — no '
      'clipboard fallback', (WidgetTester tester) async {
    launchSucceeds = false;
    await pump(tester);
    await tapResumeRow(tester);

    expect(launched, hasLength(1));
    expect(find.text('No app to open the résumé'), findsOneWidget);
    // The whole point of #354: "nothing can open it" must be a dead end, not a
    // reason to fall back to the leaky surface.
    expect(clipboardWrites(), isEmpty);
  });

  testWidgets('a THROWING launcher is contained — no crash, no clipboard, no '
      'url in the surfaced message', (WidgetTester tester) async {
    // PlatformException/FormatException both embed the offending url in their
    // message, so the screen must swallow the object rather than surface or log
    // it.
    revealSignedUrlLauncher = (Uri url) async =>
        throw PlatformException(code: 'ACTIVITY_NOT_FOUND', message: '$url');

    await pump(tester);
    await tapResumeRow(tester);

    expect(tester.takeException(), isNull);
    expect(find.text('No app to open the résumé'), findsOneWidget);
    expect(clipboardWrites(), isEmpty);
    expect(find.textContaining('mock.badabhai.in'), findsNothing);
  });

  testWidgets('the relay-handle copy affordance is KEPT (opaque id, not a '
      'capability url)', (WidgetTester tester) async {
    await pump(tester);

    await tester.tap(find.text('Contact via relay'));
    await tester.pumpAndSettle();

    // MockPayerApiClient.reveal returns relay handle 'relay-7Q2X'. This copy is
    // intentionally still allowed — #354 is about the signed url only.
    expect(clipboardWrites(), <String>['relay-7Q2X']);
    expect(find.text('Relay handle copied'), findsOneWidget);
    expect(launched, isEmpty);
  });
}
