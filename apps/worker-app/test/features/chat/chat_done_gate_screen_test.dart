// #421 (screen half) — the "build my profile" CTA is GATED on the engine's
// extraction_ready, softly: not-ready relabels the CTA and routes it through a
// warm nudge sheet that still offers a way through. A hard-disabled button
// would be worse than the bug for a first-time, low-literacy worker.
//
// Split out from chat_extraction_ready_test.dart (the parse/bloc half) because
// anything that imports the screen pulls in router.dart -> the resume photo
// picker -> image_cropper, which does not compile on the Flutter version pinned
// in pubspec.lock's transitive image_cropper_platform_interface 7.2.0. That is a
// PRE-EXISTING toolchain gap shared with chat_profiling_screen_test.dart and 15
// other suites, not something this change introduced.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_turn.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';
import 'package:badabhai_worker_app/features/chat/presentation/chat_profiling_screen.dart';
import 'package:badabhai_worker_app/router.dart';

class MockChatRepository extends Mock implements ChatRepository {}

/// Marker for the screen the CTA must reach.
const String kPreviewMarker = 'PROFILE-PREVIEW';

void main() {
  late MockChatRepository repo;

  setUp(() async {
    repo = MockChatRepository();
    await locator.reset();
    locator.registerFactory<ChatBloc>(() => ChatBloc(repo));
    when(() => repo.ensureSession()).thenAnswer((_) async {});
  });

  tearDown(() async => locator.reset());

  // ----------------------------------------------------------------- screen

  group('the Done CTA is gated on extraction_ready (#421)', () {
    Future<GoRouter> pumpChat(WidgetTester tester) async {
      tester.view.physicalSize = const Size(500, 1000);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final GoRouter router = GoRouter(
        initialLocation: '/chat',
        routes: <RouteBase>[
          GoRoute(
            path: '/chat',
            builder: (_, __) => const ChatProfilingScreen(),
          ),
          GoRoute(
            path: Routes.profilePreview,
            builder: (_, __) => const Scaffold(body: Text(kPreviewMarker)),
          ),
        ],
      );
      await tester.pumpWidget(MaterialApp.router(routerConfig: router));
      await tester.pump();
      await tester.pumpAndSettle();
      return router;
    }

    Future<void> sendOneMessage(WidgetTester tester) async {
      await tester.enterText(find.byType(TextField), 'CNC operator');
      await tester.tap(find.byIcon(Icons.send_rounded));
      await tester.pumpAndSettle();
    }

    testWidgets('NOT ready: softened label + helper, and no straight-through '
        'navigation', (WidgetTester tester) async {
      when(() => repo.sendMessage(any()))
          .thenAnswer((_) async => const ChatTurn(reply: 'Aur bataiye.'));
      await pumpChat(tester);
      await sendOneMessage(tester);

      expect(find.text(kChatDoneNotReadyLabel), findsOneWidget);
      expect(find.text(kChatDoneReadyLabel), findsNothing);
      // The worker is TOLD what is still missing — no silent dead button.
      expect(find.text(kChatNotReadyHelper), findsOneWidget);

      await tester.tap(find.text(kChatDoneNotReadyLabel));
      await tester.pumpAndSettle();

      // Tapping opens the nudge instead of jumping to the preview.
      expect(find.text(kChatNudgeTitle), findsOneWidget);
      expect(find.text(kPreviewMarker), findsNothing);
    });

    testWidgets('READY: the CTA reads done and goes straight to the preview',
        (WidgetTester tester) async {
      when(() => repo.sendMessage(any())).thenAnswer(
        (_) async => const ChatTurn(reply: 'Bas ho gaya.', extractionReady: true),
      );
      await pumpChat(tester);
      await sendOneMessage(tester);

      expect(find.text(kChatDoneReadyLabel), findsOneWidget);
      expect(find.text(kChatDoneNotReadyLabel), findsNothing);
      expect(find.text(kChatNotReadyHelper), findsNothing,
          reason: 'nothing is missing any more');

      await tester.tap(find.text(kChatDoneReadyLabel));
      await tester.pumpAndSettle();

      expect(find.text(kPreviewMarker), findsOneWidget);
      expect(find.text(kChatNudgeTitle), findsNothing,
          reason: 'a ready worker is never nudged');
    });

    testWidgets('the nudge can be dismissed back into the chat',
        (WidgetTester tester) async {
      when(() => repo.sendMessage(any()))
          .thenAnswer((_) async => const ChatTurn(reply: 'Aur bataiye.'));
      await pumpChat(tester);
      await sendOneMessage(tester);

      await tester.tap(find.text(kChatDoneNotReadyLabel));
      await tester.pumpAndSettle();
      await tester.tap(find.text(kChatNudgeContinueLabel));
      await tester.pumpAndSettle();

      expect(find.text(kChatNudgeTitle), findsNothing);
      expect(find.text(kPreviewMarker), findsNothing);
      expect(find.byType(TextField), findsOneWidget, reason: 'back in the chat');
    });

    testWidgets('the ESCAPE HATCH works — a not-ready worker can still build '
        'their profile', (WidgetTester tester) async {
      // The whole reason the gate is soft: if readiness never arrives (an older
      // API, a lost field, a stubborn interview), the worker must still be able
      // to finish. A hard-disabled button would strand them here.
      when(() => repo.sendMessage(any()))
          .thenAnswer((_) async => const ChatTurn(reply: 'Aur bataiye.'));
      await pumpChat(tester);
      await sendOneMessage(tester);

      await tester.tap(find.text(kChatDoneNotReadyLabel));
      await tester.pumpAndSettle();
      await tester.tap(find.text(kChatNudgeProceedLabel));
      await tester.pumpAndSettle();

      expect(find.text(kPreviewMarker), findsOneWidget);
    });

    testWidgets('every CTA/nudge control meets the 48px tap target',
        (WidgetTester tester) async {
      when(() => repo.sendMessage(any()))
          .thenAnswer((_) async => const ChatTurn(reply: 'Aur bataiye.'));
      await pumpChat(tester);
      await sendOneMessage(tester);

      expect(tester.getSize(find.text(kChatDoneNotReadyLabel)).height,
          greaterThan(0));
      final Finder cta = find.ancestor(
        of: find.text(kChatDoneNotReadyLabel),
        matching: find.byType(OutlinedButton),
      );
      expect(tester.getSize(cta).height, greaterThanOrEqualTo(48));

      await tester.tap(find.text(kChatDoneNotReadyLabel));
      await tester.pumpAndSettle();
      for (final String label in <String>[
        kChatNudgeContinueLabel,
        kChatNudgeProceedLabel,
      ]) {
        // byWidgetPredicate, not byType: ButtonStyleButton is abstract and
        // byType matches the EXACT runtime type (FilledButton / TextButton).
        final Finder button = find.ancestor(
          of: find.text(label),
          matching:
              find.byWidgetPredicate((Widget w) => w is ButtonStyleButton),
        );
        expect(tester.getSize(button.first).height, greaterThanOrEqualTo(48),
            reason: '$label must be thumb-sized');
      }
    });
  });

  // -------------------------------------------------------- scroll overshoot

  // #422 fallout, not a pre-existing bug: the longer opener made the FIRST
  // bubble multi-line, and a `ListView.builder` estimates `maxScrollExtent`
  // from the items it has laid out. Scrolled UP (opener on screen, one-line
  // answers below unbuilt) the estimate is inflated, the auto-scroll targets
  // it, and the old single corrective jump measured against a still-stale
  // figure — leaving the worker parked past the last bubble in blank space.
  //
  // Verified by measurement, not assumption. With the old single-step settle
  // and the CURRENT opener: 6 turns overshoot +24.7px, 12 turns +360.7px, 20
  // turns +808.8px. With a single-line opener (main's), and with the worker
  // already at the bottom, overshoot is 0.0 in every one of those fixtures —
  // which is why this only became reachable with #422 and is fixed with it.
  //
  // The scrolled-UP step is the load-bearing ingredient; a fixture that sends
  // from the bottom measures 0.0 and proves nothing.
  group('auto-scroll does not overshoot the end (#422 fallout)', () {
    /// Small viewport so a handful of bubbles overflow and the list scrolls.
    Future<ScrollController> pumpTranscript(
      WidgetTester tester, {
      required int turns,
    }) async {
      tester.view.physicalSize = const Size(400, 700);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      when(() => repo.sendMessage(any()))
          .thenAnswer((_) async => const ChatTurn(reply: 'ok bhai'));

      await tester.pumpWidget(const MaterialApp(home: ChatProfilingScreen()));
      await tester.pump();
      await tester.pumpAndSettle();

      for (int i = 0; i < turns; i++) {
        await tester.enterText(find.byType(TextField), 'msg $i');
        await tester.testTextInput.receiveAction(TextInputAction.send);
        await tester.pumpAndSettle();
      }
      return tester
          .widget<Scrollable>(find.byType(Scrollable).first)
          .controller!;
    }

    for (final int turns in <int>[6, 12, 20]) {
      testWidgets(
          'a reply landing while the worker is scrolled UP settles exactly at '
          'the end ($turns turns)', (WidgetTester tester) async {
        final ScrollController scroll =
            await pumpTranscript(tester, turns: turns);

        // The ingredient: the worker has scrolled back to re-read something.
        scroll.jumpTo(0);
        await tester.pumpAndSettle();

        await tester.enterText(find.byType(TextField), 'final line');
        await tester.testTextInput.receiveAction(TextInputAction.send);
        await tester.pumpAndSettle();

        final double overshoot =
            scroll.position.pixels - scroll.position.maxScrollExtent;
        expect(
          overshoot,
          lessThan(0.5),
          reason: 'the transcript must not park past its last bubble '
              '(single-step settle overshot by up to 808px here)',
        );
        expect(scroll.position.pixels, scroll.position.maxScrollExtent);
      });
    }
  });
}
