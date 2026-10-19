// #421 (screen half) — the "build my profile" CTA is READY-ONLY: it renders
// if and only if the engine's extraction_ready is set. The not-ready
// "Thodi aur baat karein" invitation and its nudge sheet were removed
// permanently (owner ask): while the interview is incomplete there is no CTA
// at all, and the worker keeps talking until the ready CTA appears. These
// tests pin that absence with the LITERAL copy, so a reintroduction under any
// name still reddens them.
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

import 'package:badabhai_worker_app/core/api/api_models.dart' show ChatOption;
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/session/chat_turn_resume_store.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_free_chat_keys.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_message.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_session_opening.dart';
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
    when(() => repo.ensureSession()).thenAnswer((_) async => null);
  });

  tearDown(() async => locator.reset());

  // ----------------------------------------------------------------- screen

  group('the Done CTA renders only when ready (#421)', () {
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
      await tester.pump(); // composer switches Mic→Send once there is text
      await tester.tap(find.byIcon(Icons.send_rounded));
      await tester.pumpAndSettle();
    }

    testWidgets('NOT ready: no CTA of any kind — the worker keeps talking',
        (WidgetTester tester) async {
      when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => const ChatTurn(reply: 'Aur bataiye.'));
      await pumpChat(tester);
      await sendOneMessage(tester);

      // Neither the ready label nor the removed invitation may render.
      expect(find.text(kChatDoneReadyLabel), findsNothing);
      expect(find.text('Thodi aur baat karein'), findsNothing);
      // And no nudge sheet copy anywhere in the tree.
      expect(find.text('Ek minute ji'), findsNothing);
      expect(find.text('Baat jaari rakhein'), findsNothing);
      expect(find.text('Phir bhi profile banaiye'), findsNothing);
      // The composer is live: talking is the way forward now.
      expect(find.byType(TextField), findsOneWidget);
    });

    testWidgets('READY: the CTA reads done and goes straight to the preview',
        (WidgetTester tester) async {
      when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId'))).thenAnswer(
        (_) async => const ChatTurn(reply: 'Bas ho gaya.', extractionReady: true),
      );
      await pumpChat(tester);
      await sendOneMessage(tester);

      expect(find.text(kChatDoneReadyLabel), findsOneWidget);
      expect(find.text('Thodi aur baat karein'), findsNothing);

      await tester.tap(find.text(kChatDoneReadyLabel));
      await tester.pumpAndSettle();

      expect(find.text(kPreviewMarker), findsOneWidget);
    });

    testWidgets('the READY CTA meets the 48px tap target',
        (WidgetTester tester) async {
      when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId'))).thenAnswer(
        (_) async => const ChatTurn(reply: 'Bas ho gaya.', extractionReady: true),
      );
      await pumpChat(tester);
      await sendOneMessage(tester);

      // The ready CTA is the kit's yellow PrimaryActionButton, which
      // is an ElevatedButton.
      final Finder cta = find.ancestor(
        of: find.text(kChatDoneReadyLabel),
        matching: find.byType(ElevatedButton),
      );
      expect(tester.getSize(cta).height, greaterThanOrEqualTo(48));
    });
  });

  // -------------------------------------------------- cold reopen (#2331)

  // The live close already draws the CTA from the turn's `extraction_ready`
  // (the group above). A COLD REOPEN has only the transcript, so the server's
  // `extraction_ready` on the closing bubble (#2332) must redraw the same CTA —
  // without the worker sending anything. Free chat and companion still hide it
  // (pinned by chat_profiling_screen_test.dart and chat_companion_screen_test.dart).
  group('cold reopen of a finished chat draws the done CTA (#2331)', () {
    Future<void> pumpChat(WidgetTester tester) async {
      tester.view.physicalSize = const Size(500, 1000);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final GoRouter router = GoRouter(
        initialLocation: '/chat',
        routes: <RouteBase>[
          GoRoute(path: '/chat', builder: (_, __) => const ChatProfilingScreen()),
        ],
      );
      await tester.pumpWidget(MaterialApp.router(routerConfig: router));
      await tester.pump();
      await tester.pumpAndSettle();
    }

    const List<ChatMessage> finished = <ChatMessage>[
      ChatMessage(text: 'Kya kaam?', fromWorker: false),
      ChatMessage(text: 'fitter', fromWorker: true),
      ChatMessage(
        text: 'Aapki baat poori ho gayi.',
        fromWorker: false,
        closesSession: true,
        extractionReady: true,
      ),
    ];

    testWidgets('a FINISHED close shows the CTA with no message sent',
        (WidgetTester tester) async {
      when(() => repo.loadHistory()).thenAnswer((_) async => finished);
      await pumpChat(tester);

      expect(find.text(kChatDoneReadyLabel), findsOneWidget);
    });

    testWidgets('a close WITHOUT the field (abandoned / handover) shows none',
        (WidgetTester tester) async {
      when(() => repo.loadHistory()).thenAnswer(
        (_) async => const <ChatMessage>[
          ChatMessage(text: 'Kya kaam?', fromWorker: false),
          ChatMessage(text: 'fitter', fromWorker: true),
          ChatMessage(
            text: 'Aapki baat poori ho gayi.',
            fromWorker: false,
            closesSession: true,
          ),
        ],
      );
      await pumpChat(tester);

      expect(find.text(kChatDoneReadyLabel), findsNothing);
    });
  });

  // -------------------------------------- server-lit CTA outranks free chat

  // #2351 — a finished interview whose transcript still carries `freeChat: true`
  // hid the CTA: `_doneCta` returned the hidden free-chat exit the moment the
  // tap-persisted flag was set, whatever the server's `extraction_ready` said.
  // The server's close is final, so the ready CTA must draw anyway — live, and
  // on a cold reopen that restores the persisted mode. An UNFINISHED free chat
  // still shows nothing (owner ruling 2026-10-16).
  group('the ready CTA outranks a latched free-chat mode (#2351)', () {
    Future<void> pumpChat(WidgetTester tester) async {
      tester.view.physicalSize = const Size(500, 1000);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final GoRouter router = GoRouter(
        initialLocation: '/chat',
        routes: <RouteBase>[
          GoRoute(path: '/chat', builder: (_, __) => const ChatProfilingScreen()),
        ],
      );
      await tester.pumpWidget(MaterialApp.router(routerConfig: router));
      await tester.pump();
      await tester.pumpAndSettle();
    }

    Future<void> pumpGreeting(WidgetTester tester) async {
      when(() => repo.ensureSession()).thenAnswer(
        (_) async => ChatSessionOpening(
          text: 'Namaste, main Bada Bhai hoon. Shuru karein?',
          options: const <ChatOption>[
            ChatOption(optionKey: kFreeChatLaterKey, labelText: 'Baad mein'),
          ],
        ),
      );
      await pumpChat(tester);
      await tester.tap(find.text('Baad mein').first);
      await tester.pumpAndSettle();
    }

    testWidgets('a finished close after a free-chat detour draws the CTA', (
      WidgetTester tester,
    ) async {
      when(
        () => repo.sendMessage(any(), submissionId: any(named: 'submissionId')),
      ).thenAnswer(
        (_) async => const ChatTurn(reply: 'Bas ho gaya.', extractionReady: true),
      );
      await pumpGreeting(tester);

      // The interview finishes while the tap-persisted free-chat mode is set.
      await tester.enterText(find.byType(TextField), 'theek hai');
      await tester.testTextInput.receiveAction(TextInputAction.send);
      await tester.pumpAndSettle();

      expect(find.text(kChatDoneReadyLabel), findsOneWidget);
    });

    testWidgets('an UNFINISHED free chat still shows nothing', (
      WidgetTester tester,
    ) async {
      when(
        () => repo.sendMessage(any(), submissionId: any(named: 'submissionId')),
      ).thenAnswer((_) async => const ChatTurn(reply: 'Baatein karte hain.'));
      await pumpGreeting(tester);

      expect(find.text(kChatDoneReadyLabel), findsNothing);
      expect(find.byKey(kFreeChatResumeCtaKey), findsNothing);
      expect(find.byType(TextField), findsOneWidget);
    });

    testWidgets(
        'a cold reopen restores the free-chat mode AND draws the done CTA', (
      WidgetTester tester,
    ) async {
      // The tap that opened free chat was persisted against the live session;
      // the server then closed the interview. Both flags come back on reopen.
      final InMemoryChatTurnResumeStore store = InMemoryChatTurnResumeStore();
      await store.write(
        const ChatTurnResumeState(
          sessionId: 's1',
          options: <({String optionKey, String labelText})>[
            (optionKey: kFreeChatLaterKey, labelText: 'Baad mein'),
          ],
          freeChat: true,
        ),
      );
      await locator.reset();
      locator.registerFactory<ChatBloc>(
        () => ChatBloc(repo, turnResume: store),
      );
      when(() => repo.latestSessionId()).thenAnswer((_) async => 's1');
      when(() => repo.loadHistory()).thenAnswer(
        (_) async => const <ChatMessage>[
          ChatMessage(text: 'Kya kaam?', fromWorker: false),
          ChatMessage(text: 'fitter', fromWorker: true),
          ChatMessage(
            text: 'Aapki baat poori ho gayi.',
            fromWorker: false,
            closesSession: true,
            extractionReady: true,
          ),
        ],
      );

      await pumpChat(tester);

      expect(find.text(kChatDoneReadyLabel), findsOneWidget);
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

      when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId')))
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
