import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart'
    show
        ChatInputMode,
        ChatOption,
        ChatProgress,
        ChatQuestionKind,
        PredictedQuestion;
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/session/known_worker_facts_store.dart';
import 'package:badabhai_worker_app/core/widgets/bb_chat_bubble.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_session_opening.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_turn.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';
import 'package:badabhai_worker_app/features/chat/presentation/chat_profiling_screen.dart';
import 'package:badabhai_worker_app/router.dart';
import 'package:badabhai_worker_app/core/util/devanagari_guard.dart';

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
    when(() => repo.ensureSession()).thenAnswer((_) async => null);
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
    when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId')))
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
    when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId')))
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
      when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId'))).thenAnswer((_) => reply.future);

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
      'REGRESSION: two option taps in one frame send ONE answer, not two '
      '(#649)', (WidgetTester tester) async {
    // The options row is only removed on the NEXT rebuild, and `state.sending`
    // is false at build time — so without a synchronous latch both taps
    // dispatch. The server is not idempotent across DIFFERENT text (Layer A
    // replay only catches a byte-identical message), so the second lands as a
    // bogus answer against whatever question the engine has just served.
    final Completer<ChatTurn> reply = Completer<ChatTurn>();
    int sends = 0;
    when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId'))).thenAnswer((Invocation i) {
      sends++;
      if (sends == 1) {
        return Future<ChatTurn>.value(const ChatTurn(
            reply: 'Kaunsa control?',
            followups: <String>['Fanuc', 'Siemens']));
      }
      return reply.future; // never completes — a second send would hang here
    });
    await pumpScreen(tester);

    await tester.enterText(find.byType(TextField), 'cnc');
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await tester.pumpAndSettle();
    expect(sends, 1);

    // Two taps on DIFFERENT options before any rebuild lands.
    await tester.tap(find.text('Fanuc'));
    await tester.tap(find.text('Siemens'));
    await tester.pump();

    expect(sends, 2,
        reason: 'the first option tap sends; the second must be swallowed');
  });

  testWidgets(
      'renders suggested_followups as chips and tapping one sends that answer',
      (WidgetTester tester) async {
    when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId'))).thenAnswer((_) async => const ChatTurn(
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
    verify(() => repo.sendMessage('Fanuc', submissionId: any(named: 'submissionId'))).called(1);
  });

  testWidgets('shows the typing indicator while a reply is in flight', (
    WidgetTester tester,
  ) async {
    final Completer<ChatTurn> reply = Completer<ChatTurn>();
    when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId'))).thenAnswer((_) => reply.future);
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
    when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId'))).thenAnswer((_) => reply.future);

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

  // The SERVED opener is far taller than the canned one — twelve lines against
  // two. `_kBottomSettleSteps` was measured against the canned bubble, and the
  // overshoot it corrects grows with the height of the off-screen content the
  // `ListView.builder` has to estimate. So the budget is re-measured HERE with
  // the real served copy rather than assumed to still hold.
  testWidgets('the tall served opener still settles exactly at the bottom',
      (WidgetTester tester) async {
    // Byte-for-byte `ONE_SHOT_OPENER` from `question_bank.py` — a paraphrase
    // would measure a bubble the worker never sees.
    const String served = 'Namaste. Main Bada Bhai. Koi test nahi, bas baat.\n'
        'Ek hi message mein itna bata sakte hain?\n'
        'aap kaunsa kaam karte hain\n'
        'kaunsi machine\n'
        'kitne saal ka experience hai\n'
        'kya-kya aata hai\n'
        'controller kaunsa\n'
        'abhi kis sheher mein hain\n'
        'kahan kaam kar sakte hain\n'
        'abhi salary kitni hai\n'
        'kitni salary expect karte hain\n'
        'join karne mein kitne din lagenge\n'
        'padhai ya training kaunsi hai\n'
        'Jitna yaad hai utna hi likhiye. Baaki hum ek-ek karke pooch lenge.';
    when(() => repo.ensureSession())
        .thenAnswer((_) async => const ChatSessionOpening(text: served));

    await pumpScreen(tester);
    expect(find.textContaining('Jitna yaad hai'), findsOneWidget,
        reason: 'the served opener is what is on screen');

    // 20 turns is the worst row in the original measurement table (+808.8px of
    // overshoot with the SHORT opener), so it is the right stress point.
    await fillTranscript(tester, 20);

    final ScrollController controller = listController(tester);
    controller.jumpTo(0); // worker scrolled up: the estimate is at its worst
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), 'meri baat');
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await tester.pumpAndSettle();

    expect(
      controller.position.pixels,
      controller.position.maxScrollExtent,
      reason: 'the settle budget must still converge with a 14-line bubble 0 — '
          'if this fails, raise _kBottomSettleSteps, do not delete the test',
    );
  });

  // #343 — an undelivered message used to render exactly like a delivered one.
  group('send-failure surface (#343)', () {
    testWidgets('a failed send marks the bubble and offers retry',
        (WidgetTester tester) async {
      when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId'))).thenThrow(const NetworkFailure());
      await pumpScreen(tester);

      await tester.enterText(find.byType(TextField), 'cnc');
      await tester.pump(); // composer switches Mic→Send once there is text
      await tester.tap(find.byIcon(Icons.send_rounded));
      await tester.pumpAndSettle();

      // The worker's text is still there — but no longer pretending it arrived.
      expect(find.text('cnc'), findsOneWidget);
      expect(find.text(kChatSendFailedLabel), findsOneWidget);
    });

    testWidgets('tapping a failed bubble re-sends it', (WidgetTester tester) async {
      int calls = 0;
      when(() => repo.sendMessage('cnc', submissionId: any(named: 'submissionId'))).thenAnswer((_) async {
        calls++;
        if (calls == 1) throw const NetworkFailure();
        return const ChatTurn(reply: 'Got it.');
      });
      await pumpScreen(tester);

      await tester.enterText(find.byType(TextField), 'cnc');
      await tester.pump(); // composer switches Mic→Send once there is text
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
      when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId'))).thenAnswer(
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

  // #770, narrowed: the ONLY options_only turn that locks the keyboard is the
  // engine's experience gate (Haan / Nahi). A model-chosen options_only turn
  // keeps the composer — the server accepts typed text and the worker's
  // profile may not be one of the chips.
  group('options_only locks the composer only for the yes/no gate (#770)', () {
    testWidgets(
      'the Haan/Nahi gate hides the composer, the chips are the only answer '
      'path, and the composer returns once answered',
      (WidgetTester tester) async {
        when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId'))).thenAnswer(
          (_) async => const ChatTurn(
            reply: 'Aur koi experience jodna hai?',
            followups: <String>['Haan', 'Nahi'],
            inputMode: ChatInputMode.optionsOnly,
          ),
        );

        await pumpScreen(tester);
        await tester.enterText(find.byType(TextField), 'CNC operator');
        await tester.testTextInput.receiveAction(TextInputAction.send);
        await tester.pumpAndSettle();

        // The free-text composer is gone; a locked hint stands in its place.
        expect(
          find.byType(TextField),
          findsNothing,
          reason: 'no typing on an options_only turn',
        );
        expect(find.text(kChatOptionsOnlyHint), findsOneWidget);
        expect(find.text(kChatCustomAnswerLabel), findsNothing,
            reason: 'the yes/no pair is the full answer — no escape chip');

        // The chips are present and actually submit.
        expect(find.text('Haan'), findsOneWidget);
        when(() => repo.sendMessage('Haan', submissionId: any(named: 'submissionId')))
            .thenAnswer((_) async => const ChatTurn(reply: 'Theek hai'));
        await tester.tap(find.text('Haan'));
        await tester.pumpAndSettle();
        verify(() => repo.sendMessage('Haan', submissionId: any(named: 'submissionId'))).called(1);

        // The next turn is a normal text turn — the composer must come back so
        // the worker is not locked out for the rest of the interview.
        expect(
          find.byType(TextField),
          findsOneWidget,
          reason: 'options_only is turn-scoped, not latched',
        );
        expect(find.text(kChatOptionsOnlyHint), findsNothing);
      },
    );

    testWidgets(
      'a default text turn keeps the composer unchanged (byte-identical path)',
      (WidgetTester tester) async {
        when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId'))).thenAnswer(
          // inputMode omitted -> defaults to text.
          (_) async => const ChatTurn(
            reply: 'Aur batayein',
            followups: <String>['Lathe', 'CNC'],
          ),
        );

        await pumpScreen(tester);
        await tester.enterText(find.byType(TextField), 'hi');
        await tester.testTextInput.receiveAction(TextInputAction.send);
        await tester.pumpAndSettle();

        expect(
          find.byType(TextField),
          findsOneWidget,
          reason: 'a text turn shows the composer exactly as today',
        );
        expect(find.text(kChatOptionsOnlyHint), findsNothing);
        expect(find.text('Lathe'), findsOneWidget); // chips still offered too
      },
    );

    testWidgets(
      'the gate served as LLM suggested_options (llm_ keys) still locks and '
      'gains no Kuch aur chip', (WidgetTester tester) async {
        when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId'))).thenAnswer(
          (_) async => const ChatTurn(
            reply: 'Aur koi experience jodna hai?',
            followups: <String>['Haan', 'Nahi'],
            suggestedOptions: <ChatOption>[
              ChatOption(optionKey: 'llm_a', labelText: 'Haan'),
              ChatOption(optionKey: 'llm_b', labelText: 'Nahi'),
            ],
            inputMode: ChatInputMode.optionsOnly,
          ),
        );

        await pumpScreen(tester);
        await tester.enterText(find.byType(TextField), 'CNC operator');
        await tester.testTextInput.receiveAction(TextInputAction.send);
        await tester.pumpAndSettle();

        expect(find.byType(TextField), findsNothing);
        expect(find.text(kChatOptionsOnlyHint), findsOneWidget);
        expect(find.text('Haan'), findsOneWidget);
        expect(find.text('Nahi'), findsOneWidget);
        expect(find.text(kChatCustomAnswerLabel), findsNothing);
      },
    );

    testWidgets(
      'a model-chosen options_only turn (LLM role chips) KEEPS the composer and '
      'offers the Kuch aur chip', (WidgetTester tester) async {
        when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId'))).thenAnswer(
          (_) async => const ChatTurn(
            reply: 'Aap kaunsa kaam karte hain?',
            followups: <String>['CNC operator', 'Helper'],
            suggestedOptions: <ChatOption>[
              ChatOption(optionKey: 'llm_a', labelText: 'CNC operator'),
              ChatOption(optionKey: 'llm_b', labelText: 'Helper'),
            ],
            inputMode: ChatInputMode.optionsOnly,
          ),
        );

        await pumpScreen(tester);
        await tester.enterText(find.byType(TextField), 'mujhe job chahiye');
        await tester.testTextInput.receiveAction(TextInputAction.send);
        await tester.pumpAndSettle();

        expect(find.byType(TextField), findsOneWidget,
            reason: 'the worker profile may not be a chip — typing stays open');
        expect(find.text(kChatOptionsOnlyHint), findsNothing);
        expect(find.text(kChatCustomAnswerLabel), findsOneWidget);
      },
    );

    testWidgets(
      'a deterministic options_only turn whose chips are not a yes/no pair '
      'keeps the composer', (WidgetTester tester) async {
        when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId'))).thenAnswer(
          (_) async => const ChatTurn(
            reply: 'Kaunsi machine?',
            followups: <String>['Lathe', 'CNC'],
            inputMode: ChatInputMode.optionsOnly,
          ),
        );

        await pumpScreen(tester);
        await tester.enterText(find.byType(TextField), 'hi');
        await tester.testTextInput.receiveAction(TextInputAction.send);
        await tester.pumpAndSettle();

        expect(find.byType(TextField), findsOneWidget);
        expect(find.text(kChatOptionsOnlyHint), findsNothing);
        expect(find.text('Lathe'), findsOneWidget);
        expect(find.text(kChatCustomAnswerLabel), findsNothing,
            reason: 'no Kuch aur chip on a deterministic (non-llm) row');
      },
    );

    testWidgets(
      'options_only with NO chips still shows the composer — never trap the '
      'worker with no way to answer',
      (WidgetTester tester) async {
        when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId'))).thenAnswer(
          (_) async => const ChatTurn(
            reply: 'Hmm',
            followups: <String>[],
            inputMode: ChatInputMode.optionsOnly,
          ),
        );

        await pumpScreen(tester);
        await tester.enterText(find.byType(TextField), 'hi');
        await tester.testTextInput.receiveAction(TextInputAction.send);
        await tester.pumpAndSettle();

        expect(
          find.byType(TextField),
          findsOneWidget,
          reason: 'a hidden composer with no chips would strand the worker',
        );
        expect(find.text(kChatOptionsOnlyHint), findsNothing);
      },
    );

    testWidgets(
      "a model's own Haan/Nahi options_only question is not the gate: the "
      'composer stays so a qualified answer can be typed',
      (WidgetTester tester) async {
        when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId'))).thenAnswer(
          (_) async => const ChatTurn(
            reply: 'Kya aap raat ki shift mein kaam karenge?',
            followups: <String>['Haan', 'Nahi'],
            suggestedOptions: <ChatOption>[
              ChatOption(optionKey: 'llm_a', labelText: 'Haan'),
              ChatOption(optionKey: 'llm_b', labelText: 'Nahi'),
            ],
            inputMode: ChatInputMode.optionsOnly,
          ),
        );

        await pumpScreen(tester);
        await tester.enterText(find.byType(TextField), 'CNC operator');
        await tester.testTextInput.receiveAction(TextInputAction.send);
        await tester.pumpAndSettle();

        expect(find.byType(TextField), findsOneWidget,
            reason: 'only the experience gate prompt locks the keyboard');
        expect(find.text(kChatOptionsOnlyHint), findsNothing);
        expect(find.text('Haan'), findsOneWidget);
      },
    );
  });

  // Review round 2: a tapped none-of-above chip is still an answer the server
  // keeps (shift `any`), so the shift is recorded and the form does not ask it.
  testWidgets(
      "tapping the shift question's 'Koi bhi chalegi' chip records the shift",
      (WidgetTester tester) async {
    final InMemoryKnownWorkerFactsStore facts = InMemoryKnownWorkerFactsStore();
    locator.unregister<ChatBloc>();
    locator.registerFactory<ChatBloc>(() => ChatBloc(repo, knownFacts: facts));
    when(() => repo.sendMessage('cnc', submissionId: any(named: 'submissionId')))
        .thenAnswer((_) async => const ChatTurn(
              reply: 'Aap din ki shift chahte hain ya raat ki?',
              askedQuestionId: 'shift_preference',
              followups: <String>['Din ki shift', 'Raat ki shift', 'Koi bhi chalegi'],
              suggestedOptions: <ChatOption>[
                ChatOption(optionKey: 'day', labelText: 'Din ki shift'),
                ChatOption(optionKey: 'night', labelText: 'Raat ki shift'),
                ChatOption(
                  optionKey: 'any',
                  labelText: 'Koi bhi chalegi',
                  isNoneOfAbove: true,
                ),
              ],
            ));
    when(() => repo.sendMessage('Koi bhi chalegi',
            submissionId: any(named: 'submissionId')))
        .thenAnswer((_) async => const ChatTurn(reply: 'Theek hai'));

    await pumpScreen(tester);
    await tester.enterText(find.byType(TextField), 'cnc');
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await tester.pumpAndSettle();
    expect(await facts.knownFacts(), isEmpty);

    // The third chip sits past the 400px edge of the horizontal chip row.
    await tester.ensureVisible(find.text('Koi bhi chalegi'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Koi bhi chalegi'));
    await tester.pumpAndSettle();

    verify(() => repo.sendMessage('Koi bhi chalegi',
        submissionId: any(named: 'submissionId'))).called(1);
    expect(await facts.knownFacts(), <WorkerFact>{WorkerFact.shift});
  });
  // #761 — a predicted chip renders the next prompt + chips instantly, before the
  // round trip. The optimistic render must not break the one-tap-per-turn latch.
  group('optimistic lookahead (#761)', () {
    const PredictedQuestion predSkills = PredictedQuestion(
      questionKey: 'skills',
      promptText: 'Aapko kaunse kaam aate hain?',
      options: <String>['Welding', 'Fitting'],
      progress: ChatProgress(answered: 4, total: 12),
    );

    testWidgets(
        'tapping a predicted chip shows the next prompt+chips with NO network '
        'wait, and the one-tap latch still holds', (WidgetTester tester) async {
      // Turn 1 establishes the chips + the lookahead for the next tap.
      when(() => repo.sendMessage('cnc', submissionId: any(named: 'submissionId'))).thenAnswer((_) async => const ChatTurn(
            reply: 'Kaunsa control?',
            followups: <String>['Fanuc', 'Siemens'],
            askedQuestionId: 'controller',
            lookahead: <String, PredictedQuestion?>{'Fanuc': predSkills},
          ));
      // Turn 2 (the chip tap) is HELD open — nothing may need it to render.
      final Completer<ChatTurn> pending = Completer<ChatTurn>();
      when(() => repo.sendMessage('Fanuc', submissionId: any(named: 'submissionId'))).thenAnswer((_) => pending.future);

      await pumpScreen(tester);
      await tester.enterText(find.byType(TextField), 'cnc');
      await tester.testTextInput.receiveAction(TextInputAction.send);
      await tester.pumpAndSettle();
      expect(find.text('Fanuc'), findsOneWidget);
      expect(find.text('Siemens'), findsOneWidget);

      // Tap the predicted chip. The reply future is held, so we only PUMP — the
      // render must not depend on the network.
      await tester.tap(find.text('Fanuc'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 350)); // finish auto-scroll

      expect(pending.isCompleted, isFalse,
          reason: 'the repo has not replied — this render is optimistic');
      expect(find.text(predSkills.promptText), findsOneWidget,
          reason: 'the predicted question is on screen');
      expect(find.text('Welding'), findsOneWidget);
      expect(find.text('Fitting'), findsOneWidget);
      expect(find.text('Bada Bhai type kar raha hai…'), findsNothing,
          reason: 'predicted chips replace the typing indicator');

      // The one-tap latch still holds: a second option tap while the turn is
      // unsettled is swallowed (no second send).
      await tester.tap(find.text('Welding'));
      await tester.pump();
      verifyNever(() => repo.sendMessage('Welding', submissionId: any(named: 'submissionId')));
      verify(() => repo.sendMessage('Fanuc', submissionId: any(named: 'submissionId'))).called(1);
    });

    // #761 THE FIX (end-to-end) — on the LLM chat the chip LABEL differs from
    // the stable `option_key` that `lookahead` is keyed by. The screen used to
    // render chips from the label list and index `lookahead` by the label, so
    // the lookup missed and the optimistic render silently never fired. It now
    // renders chips from `suggested_options` and indexes by the option_key.
    testWidgets(
        'a chip whose option_key differs from its label fires the prediction on '
        'tap AND submits the label (byte-identical)',
        (WidgetTester tester) async {
      // Turn 1 serves options whose key != label, with a lookahead keyed by the
      // KEY. `suggested_followups` is served alongside (and stays the same list).
      when(() => repo.sendMessage('kaam', submissionId: any(named: 'submissionId'))).thenAnswer((_) async => const ChatTurn(
            reply: 'Kaunsa kaam karte hain?',
            followups: <String>['Salad bar attendant', 'Cook'],
            suggestedOptions: <ChatOption>[
              ChatOption(
                optionKey: 'role_salad_bar',
                labelText: 'Salad bar attendant',
              ),
              ChatOption(optionKey: 'role_cook', labelText: 'Cook'),
            ],
            askedQuestionId: 'role',
            lookahead: <String, PredictedQuestion?>{'role_salad_bar': predSkills},
          ));
      // The chip tap (submitted as the LABEL) is HELD open — the render must not
      // depend on the network.
      final Completer<ChatTurn> pending = Completer<ChatTurn>();
      when(() => repo.sendMessage('Salad bar attendant', submissionId: any(named: 'submissionId')))
          .thenAnswer((_) => pending.future);

      await pumpScreen(tester);
      await tester.enterText(find.byType(TextField), 'kaam');
      await tester.testTextInput.receiveAction(TextInputAction.send);
      await tester.pumpAndSettle();

      // The chip DISPLAYS the label_text (never the option_key).
      expect(find.text('Salad bar attendant'), findsOneWidget);
      expect(find.text('role_salad_bar'), findsNothing);

      // Tap the option chip. Only PUMP — no network settle — so the render is
      // provably optimistic.
      await tester.tap(find.text('Salad bar attendant'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 350)); // finish auto-scroll

      expect(pending.isCompleted, isFalse,
          reason: 'the repo has not replied — this render is optimistic');
      // THE FIX: the predicted next question is on screen with no round trip.
      expect(find.text(predSkills.promptText), findsOneWidget,
          reason: 'indexing lookahead by the option_key made the prediction fire');
      expect(find.text('Welding'), findsOneWidget);
      expect(find.text('Fitting'), findsOneWidget);
      expect(find.text('Bada Bhai type kar raha hai…'), findsNothing);

      // And the wire submit is the LABEL, verbatim — the option_key never leaves
      // the client.
      verify(() => repo.sendMessage('Salad bar attendant', submissionId: any(named: 'submissionId'))).called(1);
      verifyNever(() => repo.sendMessage('role_salad_bar', submissionId: any(named: 'submissionId')));
    });

    // A `suggested_options` turn where the option is flagged none-of-above maps
    // to the '__declined' lookahead key, even though its label is a phrase.
    testWidgets(
        'a none-of-above option chip fires the __declined prediction and submits '
        'its label', (WidgetTester tester) async {
      when(() => repo.sendMessage('kaam', submissionId: any(named: 'submissionId'))).thenAnswer((_) async => const ChatTurn(
            reply: 'Kaunsa kaam?',
            followups: <String>['Cook', 'Kuch aur'],
            suggestedOptions: <ChatOption>[
              ChatOption(optionKey: 'role_cook', labelText: 'Cook'),
              ChatOption(
                optionKey: '__none',
                labelText: 'Kuch aur',
                isNoneOfAbove: true,
              ),
            ],
            lookahead: <String, PredictedQuestion?>{'__declined': predSkills},
          ));
      final Completer<ChatTurn> pending = Completer<ChatTurn>();
      when(() => repo.sendMessage('Kuch aur', submissionId: any(named: 'submissionId'))).thenAnswer((_) => pending.future);

      await pumpScreen(tester);
      await tester.enterText(find.byType(TextField), 'kaam');
      await tester.testTextInput.receiveAction(TextInputAction.send);
      await tester.pumpAndSettle();

      // A deterministic (non-llm, non-disambiguation) row keeps its own
      // none-of-above chip as a real decline — no custom-answer escape here.
      expect(find.text(kChatCustomAnswerLabel), findsNothing);

      await tester.tap(find.text('Kuch aur'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 350));

      expect(pending.isCompleted, isFalse);
      expect(find.text(predSkills.promptText), findsOneWidget,
          reason: 'the __declined prediction rendered on the escape tap');
      verify(() => repo.sendMessage('Kuch aur', submissionId: any(named: 'submissionId'))).called(1);
      verifyNever(() => repo.sendMessage('__declined', submissionId: any(named: 'submissionId')));
    });

    // Back-compat: a turn with NO `suggested_options` (deterministic/older API)
    // still renders from `suggested_followups` and the label-keyed path works.
    testWidgets(
        'with no suggested_options the label-keyed fallback still fires the '
        'prediction (label == key)', (WidgetTester tester) async {
      when(() => repo.sendMessage('cnc', submissionId: any(named: 'submissionId'))).thenAnswer((_) async => const ChatTurn(
            reply: 'Kaunsa control?',
            followups: <String>['Fanuc', 'Siemens'],
            askedQuestionId: 'controller',
            lookahead: <String, PredictedQuestion?>{'Fanuc': predSkills},
          ));
      final Completer<ChatTurn> pending = Completer<ChatTurn>();
      when(() => repo.sendMessage('Fanuc', submissionId: any(named: 'submissionId'))).thenAnswer((_) => pending.future);

      await pumpScreen(tester);
      await tester.enterText(find.byType(TextField), 'cnc');
      await tester.testTextInput.receiveAction(TextInputAction.send);
      await tester.pumpAndSettle();
      expect(find.text('Fanuc'), findsOneWidget);

      await tester.tap(find.text('Fanuc'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 350));

      expect(pending.isCompleted, isFalse);
      expect(find.text(predSkills.promptText), findsOneWidget,
          reason: 'the fallback path still indexes by the label (label == key)');
      verify(() => repo.sendMessage('Fanuc', submissionId: any(named: 'submissionId'))).called(1);
    });
  });

  // "Kuch aur — khud likhein": when the chat suggests profiles, the worker can
  // always type their own instead. The escape opens a focused composer and
  // sends NOTHING; the typed answer goes out as a plain message (no optionKey,
  // so no '__declined' that would stop the server identifying the trade).
  group('Kuch aur — custom answer', () {
    const PredictedQuestion predDeclined = PredictedQuestion(
      questionKey: 'skills',
      promptText: 'Aapko kaunse kaam aate hain?',
      options: <String>['Welding', 'Fitting'],
    );

    /// A realistic disambiguation turn: job-profile rows from retrieval plus
    /// the server's escape row, served options_only.
    const ChatTurn disambiguation = ChatTurn(
      reply: 'Inme se aapka kaam kaunsa hai?',
      followups: <String>['CNC machine operator', 'VMC operator', 'Kuch aur'],
      suggestedOptions: <ChatOption>[
        ChatOption(optionKey: 'jp_cnc', labelText: 'CNC machine operator'),
        ChatOption(optionKey: 'jp_vmc', labelText: 'VMC operator'),
        ChatOption(
          optionKey: 'kuch_aur',
          labelText: 'Kuch aur',
          isNoneOfAbove: true,
        ),
      ],
      questionKind: ChatQuestionKind.disambiguate,
      inputMode: ChatInputMode.optionsOnly,
      lookahead: <String, PredictedQuestion?>{
        '__declined': predDeclined,
        'kuch_aur': predDeclined,
      },
    );

    TextField composer(WidgetTester tester) =>
        tester.widget<TextField>(find.byType(TextField));

    testWidgets(
        'the disambiguation escape opens a focused composer with the custom '
        'hint and sends NOTHING', (WidgetTester tester) async {
      int sends = 0;
      when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async {
        sends++;
        return disambiguation;
      });
      await pumpScreen(tester);
      await tester.enterText(find.byType(TextField), 'mujhe job chahiye');
      await tester.testTextInput.receiveAction(TextInputAction.send);
      await tester.pumpAndSettle();
      expect(sends, 1);

      // The escape row reads as an invitation to type, not the bare label.
      expect(find.text(kChatCustomAnswerLabel), findsOneWidget);
      expect(find.text('Kuch aur'), findsNothing);
      expect(find.bySemanticsLabel(kChatCustomAnswerSemantics), findsOneWidget);
      expect(composer(tester).focusNode!.hasFocus, isFalse);

      await tester.tap(find.text(kChatCustomAnswerLabel));
      await tester.pumpAndSettle();

      expect(sends, 1, reason: 'the escape tap must not submit anything');
      expect(find.byType(TextField), findsOneWidget);
      expect(composer(tester).decoration!.hintText, kChatCustomAnswerHint);
      expect(composer(tester).focusNode!.hasFocus, isTrue,
          reason: 'the keyboard lands straight on the composer');
      // The profile rows stay on screen and tappable.
      expect(find.text('CNC machine operator'), findsOneWidget);
      expect(find.text('VMC operator'), findsOneWidget);
    });

    testWidgets(
        'typing a custom profile sends exactly that text with no optionKey, '
        'then custom mode resets', (WidgetTester tester) async {
      when(() => repo.sendMessage('mujhe job chahiye',
          submissionId: any(named: 'submissionId'))).thenAnswer(
        (_) async => disambiguation,
      );
      // Held open, so an optimistic (optionKey-driven) render would be visible.
      final Completer<ChatTurn> pending = Completer<ChatTurn>();
      when(() => repo.sendMessage('CNC operator',
          submissionId: any(named: 'submissionId'))).thenAnswer(
        (_) => pending.future,
      );
      await pumpScreen(tester);
      await tester.enterText(find.byType(TextField), 'mujhe job chahiye');
      await tester.testTextInput.receiveAction(TextInputAction.send);
      await tester.pumpAndSettle();

      await tester.tap(find.text(kChatCustomAnswerLabel));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'CNC operator');
      await tester.pump();
      await tester.tap(find.byIcon(Icons.send_rounded));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 350));

      verify(() => repo.sendMessage('CNC operator',
          submissionId: any(named: 'submissionId'))).called(1);
      verifyNever(() => repo.sendMessage('Kuch aur',
          submissionId: any(named: 'submissionId')));
      expect(find.text(predDeclined.promptText), findsNothing,
          reason: 'a typed send carries no optionKey, so no __declined / '
              'kuch_aur prediction may render');
      expect(find.text('Bada Bhai type kar raha hai…'), findsOneWidget);

      pending.complete(const ChatTurn(reply: 'Kitne saal ka experience hai?'));
      await tester.pumpAndSettle();
      expect(composer(tester).decoration!.hintText, isNot(kChatCustomAnswerHint),
          reason: 'custom mode is turn-scoped');
    });

    testWidgets('a profile row is still tappable while custom mode is open',
        (WidgetTester tester) async {
      when(() => repo.sendMessage('mujhe job chahiye',
          submissionId: any(named: 'submissionId'))).thenAnswer(
        (_) async => disambiguation,
      );
      when(() => repo.sendMessage('VMC operator',
          submissionId: any(named: 'submissionId'))).thenAnswer(
        (_) async => const ChatTurn(reply: 'Theek hai'),
      );
      await pumpScreen(tester);
      await tester.enterText(find.byType(TextField), 'mujhe job chahiye');
      await tester.testTextInput.receiveAction(TextInputAction.send);
      await tester.pumpAndSettle();

      await tester.tap(find.text(kChatCustomAnswerLabel));
      await tester.pumpAndSettle();
      await tester.tap(find.text('VMC operator'));
      await tester.pumpAndSettle();

      verify(() => repo.sendMessage('VMC operator',
          submissionId: any(named: 'submissionId'))).called(1);
      expect(composer(tester).decoration!.hintText, isNot(kChatCustomAnswerHint));
    });

    testWidgets(
        'the label-only disambiguation path (no suggested_options) also opens '
        'custom mode instead of declining', (WidgetTester tester) async {
      int sends = 0;
      when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async {
        sends++;
        return const ChatTurn(
          reply: 'Inme se aapka kaam kaunsa hai?',
          followups: <String>['CNC machine operator', 'Kuch aur'],
          questionKind: ChatQuestionKind.disambiguate,
        );
      });
      await pumpScreen(tester);
      await tester.enterText(find.byType(TextField), 'job');
      await tester.testTextInput.receiveAction(TextInputAction.send);
      await tester.pumpAndSettle();

      await tester.tap(find.text(kChatCustomAnswerLabel));
      await tester.pumpAndSettle();

      expect(sends, 1);
      expect(composer(tester).decoration!.hintText, kChatCustomAnswerHint);
      expect(composer(tester).focusNode!.hasFocus, isTrue);
    });

    testWidgets(
        'an LLM suggestion row gains a trailing Kuch aur chip that enters '
        'custom mode without sending', (WidgetTester tester) async {
      int sends = 0;
      when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async {
        sends++;
        return const ChatTurn(
          reply: 'Aap kaunsa kaam karte hain?',
          followups: <String>['CNC operator', 'Welder', 'Helper'],
          suggestedOptions: <ChatOption>[
            ChatOption(optionKey: 'llm_a', labelText: 'CNC operator'),
            ChatOption(optionKey: 'llm_b', labelText: 'Welder'),
            ChatOption(optionKey: 'llm_c', labelText: 'Helper'),
          ],
        );
      });
      await pumpScreen(tester);
      await tester.enterText(find.byType(TextField), 'I need job');
      await tester.testTextInput.receiveAction(TextInputAction.send);
      await tester.pumpAndSettle();

      final Finder chip = find.text(kChatCustomAnswerLabel);
      expect(chip, findsOneWidget);
      expect(find.bySemanticsLabel(kChatCustomAnswerGenericSemantics),
          findsOneWidget);
      await tester.ensureVisible(chip);
      await tester.pumpAndSettle();
      await tester.tap(chip);
      await tester.pumpAndSettle();

      expect(sends, 1, reason: 'the Kuch aur chip opens typing, never sends');
      // A chip row can be about a skill or a duration: a neutral hint.
      expect(
          composer(tester).decoration!.hintText, kChatCustomAnswerGenericHint);
      expect(composer(tester).focusNode!.hasFocus, isTrue);
    });

    testWidgets(
        'the server escape (kuch_aur) on an LLM chip ASK turn is the one '
        'escape chip and never sends "Kuch aur"', (WidgetTester tester) async {
      final List<String> sent = <String>[];
      when(() => repo.sendMessage(any(),
          submissionId: any(named: 'submissionId'))).thenAnswer(
        (Invocation call) async {
          sent.add(call.positionalArguments.first as String);
          return const ChatTurn(
            reply: 'Aap kaunsa kaam karte hain?',
            followups: <String>['CNC operator', 'Welder', 'Kuch aur'],
            suggestedOptions: <ChatOption>[
              ChatOption(optionKey: 'llm_a', labelText: 'CNC operator'),
              ChatOption(optionKey: 'llm_b', labelText: 'Welder'),
              ChatOption(
                optionKey: 'kuch_aur',
                labelText: 'Kuch aur',
                isNoneOfAbove: true,
              ),
            ],
          );
        },
      );
      await pumpScreen(tester);
      await tester.enterText(find.byType(TextField), 'mujhe job chahiye');
      await tester.testTextInput.receiveAction(TextInputAction.send);
      await tester.pumpAndSettle();

      expect(find.text('Kuch aur'), findsNothing);
      final Finder chip = find.text(kChatCustomAnswerLabel);
      expect(chip, findsOneWidget, reason: 'one escape, never a double');
      await tester.ensureVisible(chip);
      await tester.pumpAndSettle();
      await tester.tap(chip);
      await tester.pumpAndSettle();

      expect(sent, <String>['mujhe job chahiye'],
          reason: '"Kuch aur" must never be recorded as the worker\'s role');
      expect(
          composer(tester).decoration!.hintText, kChatCustomAnswerGenericHint);
      expect(composer(tester).focusNode!.hasFocus, isTrue);
    });

    testWidgets(
        'the escape raises the keyboard even when the composer kept focus '
        'from the send icon', (WidgetTester tester) async {
      when(() => repo.sendMessage(any(),
              submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => disambiguation);
      await pumpScreen(tester);
      await tester.enterText(find.byType(TextField), 'mujhe job chahiye');
      await tester.pump();
      await tester.tap(find.byIcon(Icons.send_rounded));
      await tester.pumpAndSettle();
      expect(composer(tester).focusNode!.hasFocus, isTrue);
      // The worker closes the keyboard with back to read the rows.
      tester.testTextInput.hide();
      expect(tester.testTextInput.isVisible, isFalse);

      await tester.tap(find.text(kChatCustomAnswerLabel));
      await tester.pumpAndSettle();

      expect(tester.testTextInput.isVisible, isTrue);
    });

    testWidgets(
        'no overflow at 320x568 with text scale 2.0 on a disambiguation turn '
        'in custom mode', (WidgetTester tester) async {
      when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => disambiguation);
      tester.view.physicalSize = const Size(320, 568);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      await tester.pumpWidget(MaterialApp(
        builder: (BuildContext context, Widget? child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: const TextScaler.linear(2.0)),
          child: child!,
        ),
        home: const ChatProfilingScreen(),
      ));
      await tester.pump();
      await tester.pumpAndSettle();

      await tester.enterText(find.byType(TextField), 'job');
      await tester.testTextInput.receiveAction(TextInputAction.send);
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);

      final Finder escape = find.text(kChatCustomAnswerLabel);
      await tester.ensureVisible(escape);
      await tester.pumpAndSettle();
      await tester.tap(escape);
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull,
          reason: 'custom mode must not overflow a short phone at 2.0x');
      expect(find.byType(TextField), findsOneWidget);
      expect(composer(tester).focusNode!.hasFocus, isTrue);
    });
  });

  group('Devanagari is blocked in the composer (#1411)', () {
    testWidgets(
        'typing Devanagari strips it from the composer and shows the notice',
        (WidgetTester tester) async {
      await pumpScreen(tester);

      await tester.enterText(find.byType(TextField), 'मेने काम किया');
      await tester.pump();

      final TextField field = tester.widget<TextField>(find.byType(TextField));
      expect(field.controller!.text, isNot(contains(RegExp('[ऀ-ॿ]'))));
      expect(find.text(kDevanagariBlockedHint), findsOneWidget);
    });

    testWidgets('plain Hinglish typing never shows the notice',
        (WidgetTester tester) async {
      await pumpScreen(tester);

      await tester.enterText(
          find.byType(TextField), 'Turning machine par kaam kiya');
      await tester.pump();

      expect(find.text(kDevanagariBlockedHint), findsNothing);
    });
  });
}
