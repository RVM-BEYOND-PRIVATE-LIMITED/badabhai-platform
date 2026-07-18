import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/widgets/bb_chat_bubble.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_turn.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';
import 'package:badabhai_worker_app/features/chat/presentation/chat_profiling_screen.dart';
import 'package:badabhai_worker_app/router.dart';

class MockChatRepository extends Mock implements ChatRepository {}

void main() {
  late MockChatRepository repo;

  setUp(() async {
    repo = MockChatRepository();
    // Swap the real graph for a ChatBloc backed by a mock repo we control. The
    // screen resolves `locator<ChatBloc>()` exactly as in production.
    // `GetIt.reset()` is async — await it so the re-registration below is in
    // place before the screen mounts and the BlocProvider calls
    // `locator<ChatBloc>()` (otherwise the factory can be momentarily absent).
    await locator.reset();
    locator.registerFactory<ChatBloc>(() => ChatBloc(repo));
    // Session opens instantly so the spinner drops and the list mounts.
    when(() => repo.ensureSession()).thenAnswer((_) async {});
  });

  tearDown(() async => locator.reset());

  /// A scroll controller hanging off the message ListView (the long transcript)
  /// — there is no separate controller in the composer, so the only attached
  /// `Scrollable` is the chat list.
  ScrollController listController(WidgetTester tester) {
    final Scrollable scrollable = tester.widget<Scrollable>(
      find.byType(Scrollable).first,
    );
    return scrollable.controller!;
  }

  /// Pumps the screen at a small surface so a handful of bubbles overflow the
  /// viewport and the list is actually scrollable.
  Future<void> pumpScreen(WidgetTester tester) async {
    tester.view.physicalSize = const Size(400, 700);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(const MaterialApp(home: ChatProfilingScreen()));
    await tester.pump(); // ChatStarted -> ensureSession resolves, spinner drops
    await tester.pumpAndSettle();
  }

  /// Fills the transcript with worker messages so the list overflows. Each send
  /// resolves its bot reply immediately.
  Future<void> fillTranscript(WidgetTester tester, int count) async {
    when(() => repo.sendMessage(any()))
        .thenAnswer((_) async => const ChatTurn(reply: 'ok bhai'));
    for (int i = 0; i < count; i++) {
      await tester.enterText(find.byType(TextField), 'msg $i');
      await tester.testTextInput.receiveAction(TextInputAction.send);
      await tester.pumpAndSettle();
    }
  }

  testWidgets('own message always snaps the list to the bottom', (
    WidgetTester tester,
  ) async {
    await pumpScreen(tester);
    await fillTranscript(tester, 12);

    // Scroll up so we are well away from the bottom.
    final ScrollController controller = listController(tester);
    controller.jumpTo(0);
    await tester.pumpAndSettle();
    expect(controller.position.pixels, 0);

    // Send the worker's own message — it must follow them down regardless.
    when(() => repo.sendMessage(any()))
        .thenAnswer((_) async => const ChatTurn(reply: 'ok bhai'));
    await tester.enterText(find.byType(TextField), 'my own line');
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await tester.pumpAndSettle();

    expect(
      controller.position.pixels,
      controller.position.maxScrollExtent,
      reason: 'own message should animate to the bottom',
    );
    // No pill — we are pinned to the bottom.
    expect(find.text('Naye message'), findsNothing);
  });

  testWidgets(
    'received message while scrolled up shows the pill and does not auto-scroll',
    (WidgetTester tester) async {
      await pumpScreen(tester);
      await fillTranscript(tester, 12);

      // Hold the bot reply open so we can scroll up before it lands.
      final Completer<ChatTurn> reply = Completer<ChatTurn>();
      when(() => repo.sendMessage(any())).thenAnswer((_) => reply.future);

      await tester.enterText(find.byType(TextField), 'trigger');
      await tester.testTextInput.receiveAction(TextInputAction.send);
      await tester.pumpAndSettle(); // worker message appended + scrolled down

      // Scroll up, away from the bottom.
      final ScrollController controller = listController(tester);
      controller.jumpTo(0);
      await tester.pumpAndSettle();
      final double before = controller.position.pixels;
      expect(before, 0);

      // Bot reply lands while we are scrolled up.
      reply.complete(const ChatTurn(reply: 'bada bhai replies'));
      await tester.pumpAndSettle();

      // Pill appears, list stays put (no auto-scroll).
      expect(find.text('Naye message'), findsOneWidget);
      expect(controller.position.pixels, before);
      expect(
        controller.position.pixels,
        lessThan(controller.position.maxScrollExtent),
      );
    },
  );

  testWidgets(
      'renders suggested_followups as chips and tapping one sends that answer',
      (WidgetTester tester) async {
    when(() => repo.sendMessage(any())).thenAnswer((_) async => const ChatTurn(
        reply: 'Kaunsa control?', followups: <String>['Fanuc', 'Siemens']));
    await pumpScreen(tester);

    await tester.enterText(find.byType(TextField), 'cnc');
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await tester.pumpAndSettle();

    // The backend's tap-to-answer suggestions are surfaced as chips.
    expect(find.text('Fanuc'), findsOneWidget);
    expect(find.text('Siemens'), findsOneWidget);

    // Tapping a chip sends it exactly like a typed answer.
    await tester.tap(find.text('Fanuc'));
    await tester.pumpAndSettle();
    verify(() => repo.sendMessage('Fanuc')).called(1);
  });

  testWidgets('shows the typing indicator while a reply is in flight', (
    WidgetTester tester,
  ) async {
    final Completer<ChatTurn> reply = Completer<ChatTurn>();
    when(() => repo.sendMessage(any())).thenAnswer((_) => reply.future);
    await pumpScreen(tester);

    await tester.enterText(find.byType(TextField), 'cnc');
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await tester.pumpAndSettle();

    // Reply still pending → the "typing…" cue is visible.
    expect(find.text('Bada Bhai type kar raha hai…'), findsOneWidget);

    reply.complete(const ChatTurn(reply: 'Theek hai.'));
    await tester.pumpAndSettle();

    // Reply landed → indicator gone, reply shown.
    expect(find.text('Bada Bhai type kar raha hai…'), findsNothing);
    expect(find.text('Theek hai.'), findsOneWidget);
  });

  testWidgets('tapping the pill scrolls to the bottom and hides it', (
    WidgetTester tester,
  ) async {
    await pumpScreen(tester);
    await fillTranscript(tester, 12);

    final Completer<ChatTurn> reply = Completer<ChatTurn>();
    when(() => repo.sendMessage(any())).thenAnswer((_) => reply.future);

    await tester.enterText(find.byType(TextField), 'trigger');
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await tester.pumpAndSettle();

    final ScrollController controller = listController(tester);
    controller.jumpTo(0);
    await tester.pumpAndSettle();

    reply.complete(const ChatTurn(reply: 'bada bhai replies'));
    await tester.pumpAndSettle();
    expect(find.text('Naye message'), findsOneWidget);

    // Tap the pill -> animate to bottom + clear the flag.
    await tester.tap(find.text('Naye message'));
    await tester.pumpAndSettle();

    expect(find.text('Naye message'), findsNothing);
    expect(controller.position.pixels, controller.position.maxScrollExtent);
  });

  // #343 — an undelivered message used to render exactly like a delivered one.
  group('send-failure surface (#343)', () {
    testWidgets('a failed send marks the bubble and offers retry',
        (WidgetTester tester) async {
      when(() => repo.sendMessage(any())).thenThrow(const NetworkFailure());
      await pumpScreen(tester);

      await tester.enterText(find.byType(TextField), 'cnc');
      await tester.tap(find.byIcon(Icons.send_rounded));
      await tester.pumpAndSettle();

      // The worker's text is still there — but no longer pretending it arrived.
      expect(find.text('cnc'), findsOneWidget);
      expect(find.text(kChatSendFailedLabel), findsOneWidget);
    });

    testWidgets('tapping a failed bubble re-sends it', (WidgetTester tester) async {
      int calls = 0;
      when(() => repo.sendMessage('cnc')).thenAnswer((_) async {
        calls++;
        if (calls == 1) throw const NetworkFailure();
        return const ChatTurn(reply: 'Got it.');
      });
      await pumpScreen(tester);

      await tester.enterText(find.byType(TextField), 'cnc');
      await tester.tap(find.byIcon(Icons.send_rounded));
      await tester.pumpAndSettle();
      expect(find.text(kChatSendFailedLabel), findsOneWidget);

      // Tap the failed bubble itself — the whole bubble is the retry control.
      await tester.tap(find.text(kChatSendFailedLabel));
      await tester.pumpAndSettle();

      expect(calls, 2);
      expect(find.text(kChatSendFailedLabel), findsNothing,
          reason: 'the bubble healed');
      expect(find.text('Got it.'), findsOneWidget);
      expect(find.text('cnc'), findsOneWidget,
          reason: 'retry must not duplicate the bubble');
    });

    testWidgets('a failed session-open shows the banner',
        (WidgetTester tester) async {
      when(() => repo.ensureSession()).thenThrow(const NetworkFailure());
      await pumpScreen(tester);

      expect(find.byIcon(Icons.cloud_off), findsOneWidget);
      // The worker can still type — the banner informs, it does not block.
      expect(find.byType(TextField), findsOneWidget);
    });
  });

  // #372 — the Done push was unguarded, and ProfilePreviewScreen builds a fresh
  // ProfileCubit that fires extract() on EVERY mount. A double-tap therefore
  // stacked two preview screens and enqueued two concurrent extraction AI jobs
  // (duplicate real spend). Counting preview MOUNTS is the assertion that
  // matters: one mount == one POST /profile/extract.
  group('ready-CTA double-tap guard (#372)', () {
    /// Mounts the chat screen on a real router whose `/profiling` route counts
    /// its mounts — a stand-in for ProfilePreviewScreen's extract-on-mount.
    Future<({GoRouter router, int Function() mounts})> pumpRouted(
      WidgetTester tester,
    ) async {
      tester.view.physicalSize = const Size(400, 700);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      int mounts = 0;
      final GoRouter router = GoRouter(
        initialLocation: Routes.chatProfiling,
        routes: <RouteBase>[
          GoRoute(
            path: Routes.chatProfiling,
            builder: (_, __) => const ChatProfilingScreen(),
          ),
          GoRoute(
            path: Routes.profilePreview,
            builder: (_, __) {
              mounts++;
              return const Scaffold(body: Center(child: Text('PREVIEW')));
            },
          ),
        ],
      );
      await tester.pumpWidget(MaterialApp.router(routerConfig: router));
      await tester.pump();
      await tester.pumpAndSettle();

      // #421 gates the ready CTA on the engine's `extraction_ready`. Drive one
      // ready turn so the button under test is the PRIMARY path — the
      // not-ready path opens the nudge sheet instead, which is its own guard.
      when(() => repo.sendMessage(any())).thenAnswer(
        (_) async => const ChatTurn(reply: 'bas ho gaya', extractionReady: true),
      );
      await tester.enterText(find.byType(TextField), 'CNC operator hun');
      await tester.testTextInput.receiveAction(TextInputAction.send);
      await tester.pumpAndSettle();

      return (router: router, mounts: () => mounts);
    }

    testWidgets('a double-tap opens the preview exactly once',
        (WidgetTester tester) async {
      final int Function() mounts = (await pumpRouted(tester)).mounts;
      final Finder done = find.text(kChatDoneReadyLabel);

      // Both taps land inside the SAME frame — the real double-tap on a laggy
      // low-end device. Nothing is pumped between them, so the disabled state
      // has not painted yet and only the synchronous guard can stop the second.
      await tester.tap(done);
      await tester.tap(done, warnIfMissed: false);
      await tester.pumpAndSettle();

      expect(mounts(), 1,
          reason: 'a second mount is a second POST /profile/extract');
      expect(find.text('PREVIEW'), findsOneWidget);
    });

    testWidgets('the guard re-arms after the preview pops back',
        (WidgetTester tester) async {
      final ({GoRouter router, int Function() mounts}) harness =
          await pumpRouted(tester);
      final int Function() mounts = harness.mounts;
      final Finder done = find.text(kChatDoneReadyLabel);

      await tester.tap(done);
      await tester.pumpAndSettle();
      expect(mounts(), 1);

      // Back out of the preview — the worker must be able to try again.
      harness.router.pop();
      await tester.pumpAndSettle();
      expect(find.text(kChatDoneReadyLabel), findsOneWidget);

      await tester.tap(done);
      await tester.pumpAndSettle();
      expect(mounts(), 2, reason: 'the guard must not latch permanently');
    });
  });
}
