import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';

import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/core/session/app_session.dart';
import 'package:payer_app/core/session/app_session_cubit.dart';
import 'package:payer_app/core/widgets/bb_bottom_nav.dart';
import 'package:payer_app/core/widgets/bb_card.dart';
import 'package:payer_app/core/widgets/bb_copy_button.dart';
import 'package:payer_app/core/widgets/bb_stamp_celebration.dart';
import 'package:payer_app/core/widgets/bb_success_stamp.dart';
import 'package:payer_app/features/find/presentation/reveal_args.dart';
import 'package:payer_app/features/find/presentation/reveal_screen.dart';
import 'package:payer_app/features/find/presentation/widgets/unlock_button.dart';
import 'package:payer_app/features/shell/presentation/app_shell.dart';

/// #2596 (M8) — the unlock success moment.
///
///  - The stamp plays ONLY right after an unlock: never on a "View" of an
///    earlier one (the acceptance criterion), with ONE medium haptic per
///    unlock, a spoken "unlocked" (live region) and no duplicate "Unlocked!"
///    toast — and never over a relay that came back unavailable / failed:
///    that unlock is confirmed by one "Unlocked!" toast + one medium haptic.
///  - The stamp lands 0.6 → 1.08 → 1 over 520ms, and appears at full size at
///    once with animations disabled.
///  - "Copy relay handle" morphs its icon to a check, then turns back.
const String _medium = 'HapticFeedbackType.mediumImpact';

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

/// The reveal's relay answer, scripted: the neutral deny, or an outage.
class _RelayApi extends MockPayerApiClient {
  _RelayApi({required this.fail});

  /// True → the call throws (an outage); false → `{status:"unavailable"}`.
  final bool fail;

  @override
  Future<RevealResult> reveal(String unlockId) async {
    if (fail) throw const PayerApiException(503);
    return const RevealResult.unavailable();
  }
}

void main() {
  late List<String> haptics;
  late List<String> clipboard;

  setUp(() async {
    haptics = <String>[];
    clipboard = <String>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform,
            (MethodCall call) async {
      if (call.method == 'HapticFeedback.vibrate') {
        haptics.add(call.arguments as String);
      }
      if (call.method == 'Clipboard.setData') {
        clipboard.add(
          (call.arguments as Map<Object?, Object?>)['text'] as String,
        );
      }
      return null;
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

  /// [reduced] mirrors the OS "remove animations" switch.
  Widget host(Widget child, {bool reduced = true}) => MaterialApp(
        builder: (BuildContext context, Widget? app) => MediaQuery(
          data: MediaQuery.of(context).copyWith(disableAnimations: reduced),
          child: app!,
        ),
        home: Scaffold(body: child),
      );

  Future<void> pumpReveal(
    WidgetTester tester,
    RevealArgs args, {
    bool reduced = true,
  }) async {
    await tester.pumpWidget(
      host(RevealScreen(args: args, onBack: () {}), reduced: reduced),
    );
    await tester.pumpAndSettle();
  }

  Future<void> useApi(MockPayerApiClient api) async {
    await GetIt.instance.reset();
    setupLocator(apiClient: api, secureStore: InMemoryKeyValueStore());
  }

  group('RevealScreen — the stamp is gated on "just unlocked"', () {
    testWidgets('right after an unlock: the stamp plays with ONE medium haptic',
        (WidgetTester tester) async {
      await pumpReveal(
        tester,
        const RevealArgs.real(
          applicant: _applicant,
          unlockId: 'unlock-1',
          justUnlocked: true,
        ),
      );

      expect(find.byType(BbStampCelebration), findsOneWidget);
      expect(haptics.where((String h) => h == _medium), hasLength(1));

      // A rebuild (here: the résumé row's state change) never replays it.
      await tester.tap(find.text('Masked résumé'));
      await tester.pumpAndSettle();
      expect(haptics.where((String h) => h == _medium), hasLength(1));
    });

    for (final bool fail in <bool>[false, true]) {
      testWidgets(
          'right after an unlock, a relay that comes back '
          '${fail ? 'FAILED' : 'unavailable'}: no stamp over that card, but '
          'ONE spoken "Unlocked!" toast and ONE medium haptic',
          (WidgetTester tester) async {
        final SemanticsHandle semantics = tester.ensureSemantics();
        await useApi(_RelayApi(fail: fail));
        await tester.pumpWidget(host(
          RevealScreen(
            args: const RevealArgs.real(
              applicant: _applicant,
              unlockId: 'unlock-1',
              justUnlocked: true,
            ),
            onBack: () {},
          ),
        ));
        await tester.pump(); // the relay resolves (to nothing)
        await tester.pump(); // the toast is up

        // No seal over the "not available" card (#1077)…
        expect(find.byType(BbStampCelebration), findsNothing);
        expect(find.byType(BbSuccessStamp), findsNothing);
        expect(
          find.descendant(
            of: find.byType(BbCard),
            matching: find.text(kRelayUnavailableMessage),
          ),
          findsOneWidget,
        );
        // …but the credit the payer just spent is confirmed, exactly once.
        expect(find.text(kUnlockedToastTitle), findsOneWidget);
        expect(
          find.descendant(
            of: find.byType(SnackBar),
            matching: find.text(kRelayUnavailableMessage),
          ),
          findsOneWidget,
        );
        expect(haptics.where((String h) => h == _medium), hasLength(1));
        // A SnackBar is a live region: TalkBack / VoiceOver read it out (once
        // its own entrance fade has put it into the semantics tree).
        await tester.pump(const Duration(milliseconds: 500));
        expect(
          find.semantics.byLabel(RegExp(kUnlockedToastTitle)),
          findsOneWidget,
        );
        expect(
          tester.getSemantics(find.text(kUnlockedToastTitle)),
          containsSemantics(isLiveRegion: true),
        );
        // The header badge says it too.
        expect(find.text('Unlocked'), findsOneWidget);

        // A rebuild (the résumé row's state change) never repeats it.
        await tester.pumpAndSettle();
        await tester.tap(find.text('Masked résumé'));
        await tester.pumpAndSettle();
        expect(haptics.where((String h) => h == _medium), hasLength(1));
        semantics.dispose();
      });

      testWidgets(
          '"View" of an earlier unlock whose relay comes back '
          '${fail ? 'FAILED' : 'unavailable'}: no toast, no haptic',
          (WidgetTester tester) async {
        await useApi(_RelayApi(fail: fail));
        await pumpReveal(
          tester,
          const RevealArgs.real(applicant: _applicant, unlockId: 'unlock-1'),
        );

        expect(find.text(kRelayUnavailableMessage), findsOneWidget);
        expect(find.text(kUnlockedToastTitle), findsNothing);
        expect(find.byType(SnackBar), findsNothing);
        expect(find.byType(BbStampCelebration), findsNothing);
        expect(haptics, isNot(contains(_medium)));
      });
    }

    testWidgets('the stamp SAYS it: a live region a screen reader announces',
        (WidgetTester tester) async {
      final SemanticsHandle semantics = tester.ensureSemantics();
      await tester.pumpWidget(host(
        RevealScreen(
          args: const RevealArgs.real(
            applicant: _applicant,
            unlockId: 'unlock-1',
            justUnlocked: true,
          ),
          onBack: () {},
        ),
      ));
      // The relay resolves; the stamp lands (and has not faded yet).
      await tester.pump();
      await tester.pump();
      expect(find.byType(BbStampCelebration), findsOneWidget);
      expect(find.semantics.byLabel(kUnlockedAnnouncement), findsOneWidget);
      expect(
        tester.getSemantics(find.bySemanticsLabel(kUnlockedAnnouncement)),
        containsSemantics(label: kUnlockedAnnouncement, isLiveRegion: true),
      );
      await tester.pumpAndSettle();
      semantics.dispose();
    });

    testWidgets('a "View" announces nothing', (WidgetTester tester) async {
      final SemanticsHandle semantics = tester.ensureSemantics();
      await tester.pumpWidget(host(
        RevealScreen(
          args: const RevealArgs.real(applicant: _applicant, unlockId: 'u-1'),
          onBack: () {},
        ),
      ));
      await tester.pump();
      await tester.pump();
      expect(find.semantics.byLabel(kUnlockedAnnouncement), findsNothing);
      await tester.pumpAndSettle();
      semantics.dispose();
    });

    testWidgets('"View" of an earlier unlock: no stamp, no haptic',
        (WidgetTester tester) async {
      await pumpReveal(
        tester,
        const RevealArgs.real(applicant: _applicant, unlockId: 'unlock-1'),
      );

      expect(find.byType(BbStampCelebration), findsNothing);
      expect(find.byType(BbSuccessStamp), findsNothing);
      expect(haptics, isNot(contains(_medium)));
      // The reveal itself is unchanged.
      expect(find.text('relay-7Q2X'), findsOneWidget);
    });

    testWidgets('a search-row View has no stamp; its unlock does',
        (WidgetTester tester) async {
      await pumpReveal(
        tester,
        const RevealArgs.relay(
          workerId: 'w-1',
          unlockId: 'u-1',
          title: 'Worker ••8a90',
        ),
      );
      expect(find.byType(BbStampCelebration), findsNothing);

      await pumpReveal(
        tester,
        const RevealArgs.relay(
          workerId: 'w-2',
          unlockId: 'u-2',
          title: 'Worker ••1b2c',
          justUnlocked: true,
        ),
      );
      expect(find.byType(BbStampCelebration), findsOneWidget);
    });

    testWidgets('MOCK reveal: same gate', (WidgetTester tester) async {
      const Candidate candidate = Candidate(
        id: 1,
        name: 'Ramesh Kumar',
        trade: 'CNC Setter',
        exp: '6 yrs',
        loc: 'Pune',
        skill: 'Fanuc',
        avail: 'Available now',
        hot: false,
        fit: FitLabel.strong,
        phone: '+91 98•• ••• 210',
        unlocked: true,
      );
      await pumpReveal(tester, const RevealArgs.mock(candidate));
      expect(find.byType(BbStampCelebration), findsNothing);

      await pumpReveal(
        tester,
        const RevealArgs.mock(candidate, justUnlocked: true),
      );
      expect(find.byType(BbStampCelebration), findsOneWidget);
      expect(haptics.where((String h) => h == _medium), hasLength(1));
    });

    testWidgets('the stamp never blocks the actions beneath it',
        (WidgetTester tester) async {
      await pumpReveal(
        tester,
        const RevealArgs.real(
          applicant: _applicant,
          unlockId: 'unlock-1',
          justUnlocked: true,
        ),
        reduced: false,
      );
      // Mid-celebration, the relay copy still takes the tap.
      await tester.tap(find.text(kCopyRelayHandleLabel));
      await tester.pump();
      expect(clipboard, <String>['relay-7Q2X']);
      await tester.pumpAndSettle();
    });
  });

  group('BbSuccessStamp — 0.6 → 1.08 → 1 over 520ms', () {
    double scaleOf(WidgetTester tester) => tester
        .widget<ScaleTransition>(find.descendant(
          of: find.byType(BbSuccessStamp),
          matching: find.byType(ScaleTransition),
        ))
        .scale
        .value;

    testWidgets('lands with the overshoot, once', (WidgetTester tester) async {
      await tester.pumpWidget(host(const BbSuccessStamp(), reduced: false));
      expect(scaleOf(tester), closeTo(0.6, 0.001));

      // The overshoot peaks at 60% of the land (312ms).
      await tester.pump(const Duration(milliseconds: 312));
      expect(scaleOf(tester), closeTo(1.08, 0.001));

      await tester.pump(const Duration(milliseconds: 208));
      expect(scaleOf(tester), closeTo(1.0, 0.001));

      // Nothing loops.
      await tester.pump(const Duration(seconds: 2));
      expect(scaleOf(tester), closeTo(1.0, 0.001));
      expect(tester.hasRunningAnimations, isFalse);
    });

    testWidgets('with animations disabled it is simply there at full size',
        (WidgetTester tester) async {
      await tester.pumpWidget(host(const BbSuccessStamp()));
      await tester.pump();
      expect(scaleOf(tester), 1.0);
    });

    test('the land token is the issue\'s 520ms', () {
      expect(BbSuccessStamp.landScale.transform(0), closeTo(0.6, 0.001));
      expect(BbSuccessStamp.landScale.transform(0.6), closeTo(1.08, 0.001));
      expect(BbSuccessStamp.landScale.transform(1), closeTo(1.0, 0.001));
    });
  });

  group('Copy relay handle — icon morphs to a check, then back', () {
    testWidgets('copies, shows the check for ~1.2s, no toast, then turns back',
        (WidgetTester tester) async {
      await pumpReveal(
        tester,
        const RevealArgs.real(applicant: _applicant, unlockId: 'unlock-1'),
      );

      expect(find.byIcon(BbCopyButton.copyIcon), findsOneWidget);
      await tester.tap(find.text(kCopyRelayHandleLabel));
      await tester.pump();
      await tester.pump();

      expect(clipboard, <String>['relay-7Q2X']);
      expect(find.byIcon(BbCopyButton.copiedIcon), findsOneWidget);
      expect(find.byIcon(BbCopyButton.copyIcon), findsNothing);
      expect(find.text('Copied'), findsOneWidget);
      // The morph IS the confirmation — no toast on top of it.
      expect(find.byType(SnackBar), findsNothing);
      expect(find.text('Relay handle copied'), findsNothing);

      // Still the check just before the hold ends…
      await tester.pump(const Duration(milliseconds: 1100));
      expect(find.byIcon(BbCopyButton.copiedIcon), findsOneWidget);

      // …and back to the copy icon after it.
      await tester.pump(const Duration(milliseconds: 150));
      await tester.pump();
      expect(find.byIcon(BbCopyButton.copyIcon), findsOneWidget);
      expect(find.byIcon(BbCopyButton.copiedIcon), findsNothing);
      expect(find.text(kCopyRelayHandleLabel), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('the icon morphs (scale + fade) with animations on',
        (WidgetTester tester) async {
      await pumpReveal(
        tester,
        const RevealArgs.real(applicant: _applicant, unlockId: 'unlock-1'),
        reduced: false,
      );
      await tester.tap(find.text(kCopyRelayHandleLabel));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 70));

      // Mid-morph both icons are on screen, crossing over.
      expect(find.byIcon(BbCopyButton.copiedIcon), findsOneWidget);
      expect(find.byIcon(BbCopyButton.copyIcon), findsOneWidget);
      await tester.pumpAndSettle();
      expect(find.byIcon(BbCopyButton.copyIcon), findsOneWidget);
    });
  });

  group('the real flow, through the shell', () {
    const AppSession session = AppSession(
      role: PayerRole.company,
      account: PayerAccount(
        name: 'Kalyani Industries',
        plan: 'Starter',
        initials: 'KI',
      ),
    );

    Future<void> pumpShell(WidgetTester tester) async {
      await tester.pumpWidget(
        MaterialApp(
          builder: (BuildContext context, Widget? app) => MediaQuery(
            data: MediaQuery.of(context).copyWith(disableAnimations: true),
            child: app!,
          ),
          home: BlocProvider<AppSessionCubit>.value(
            value: locator<AppSessionCubit>(),
            child: const AppShell(session: session),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.descendant(
        of: find.byType(BbBottomNav),
        matching: find.text('Find'),
      ));
      await tester.pumpAndSettle();
    }

    testWidgets(
        'unlock → the stamp, no "Unlocked!" toast; back → View of that '
        'unlock → NO stamp', (WidgetTester tester) async {
      await pumpShell(tester);

      await tester.tap(find.text(kUnlockLabel).first);
      await tester.pumpAndSettle();
      haptics.clear();
      await tester.tap(find.text('Unlock for 1 credit'));
      await tester.pumpAndSettle();

      expect(find.byType(RevealScreen), findsOneWidget);
      expect(find.byType(BbStampCelebration), findsOneWidget);
      // ONE medium impact per unlock — the stamp's, as it lands. The dialog's
      // confirm press is BbButton's light tap only.
      expect(haptics.where((String h) => h == _medium), hasLength(1));
      expect(find.text('Unlocked!'), findsNothing);
      expect(find.byType(SnackBar), findsNothing);

      await tester.tap(find.descendant(
        of: find.byType(RevealScreen),
        matching: find.byIcon(Icons.arrow_back_rounded),
      ));
      await tester.pumpAndSettle();
      expect(find.byType(RevealScreen, skipOffstage: false), findsNothing);

      haptics.clear();
      await tester.tap(find.text('View').first);
      await tester.pumpAndSettle();

      expect(find.byType(RevealScreen), findsOneWidget);
      expect(find.byType(BbStampCelebration), findsNothing);
      expect(haptics, isNot(contains(_medium)));
    });
  });
}
