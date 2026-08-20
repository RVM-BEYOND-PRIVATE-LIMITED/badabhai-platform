// Voice, the 4000-character dead end (#1013), and the two consent dead ends —
// on the ONE screen whose whole job is "tell us what is wrong".
//
// Everything here is about a worker who is not habituated to apps: they cannot
// be asked to type a paragraph, they must not be able to type themselves into an
// error nobody can clear, and they must never be handed a refusal with no way to
// act on it.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/features/feedback/domain/feedback_category.dart';
import 'package:badabhai_worker_app/features/feedback/domain/feedback_limits.dart';
import 'package:badabhai_worker_app/features/feedback/domain/feedback_repository.dart';
import 'package:badabhai_worker_app/features/feedback/presentation/feedback_screen.dart';
import 'package:badabhai_worker_app/features/voice/domain/speech_dictation.dart';
import 'package:badabhai_worker_app/features/voice/presentation/dictation_controller.dart';
import 'package:badabhai_worker_app/features/voice/presentation/widgets/dictation_bar.dart';

// The SAME hand double the controller's own suite drives, on purpose: a second
// copy is a second thing that can drift away from the recogniser's real shape.
import '../voice/dictation_controller_test.dart' show FakeDictation;

class _MockFeedbackRepository extends Mock implements FeedbackRepository {}

/// A finder for the recognised text sitting in the box.
String _fieldText(WidgetTester tester) =>
    tester.widget<TextField>(find.byType(TextField)).controller!.text;

void main() {
  late _MockFeedbackRepository repo;
  late FakeDictation speech;

  setUpAll(() => registerFallbackValue(FeedbackCategory.other));

  setUp(() async {
    await locator.reset();
    repo = _MockFeedbackRepository();
    speech = FakeDictation();
    locator.registerFactory<FeedbackRepository>(() => repo);
    locator.registerSingleton<SpeechDictation>(speech);
    when(() => repo.submit(
          message: any(named: 'message'),
          category: any(named: 'category'),
          screen: any(named: 'screen'),
        )).thenAnswer((_) async {});
  });

  tearDown(() => locator.reset());

  /// Pumps /home → pushes the feedback screen, so `context.pop()` has somewhere
  /// to land and a `go` to /consent has a route to reach.
  Future<GoRouter> pump(WidgetTester tester, {String? fromRoute}) async {
    // A tall canvas: the box is `minLines: 5`, so on the 800x600 test default the
    // mic row falls outside the viewport and the ListView never builds it.
    tester.view.physicalSize = const Size(900, 1900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final GoRouter router = GoRouter(
      initialLocation: '/home',
      routes: <RouteBase>[
        GoRoute(
          path: '/home',
          builder: (_, __) => Scaffold(
            body: Builder(
              builder: (BuildContext c) => TextButton(
                onPressed: () => c.push('/feedback'),
                child: const Text('OPEN'),
              ),
            ),
          ),
        ),
        GoRoute(
          path: '/feedback',
          builder: (_, __) => FeedbackScreen(fromRoute: fromRoute),
        ),
        GoRoute(
          path: '/consent',
          builder: (_, __) =>
              const Scaffold(body: Center(child: Text('Your privacy'))),
        ),
      ],
    );
    await tester.pumpWidget(
        MaterialApp.router(theme: AppTheme.light(), routerConfig: router));
    await tester.tap(find.text('OPEN'));
    await tester.pumpAndSettle();
    return router;
  }

  /// A long report grows the box past the viewport, and a lazy ListView never
  /// BUILDS what is off screen — so scroll the mic/counter row into view before
  /// asserting anything about it.
  Future<void> revealVoiceRow(WidgetTester tester) async {
    await tester.scrollUntilVisible(
      find.text('Bolkar likhein'),
      600,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.pump();
  }

  Future<void> startDictation(WidgetTester tester) async {
    await tester.tap(find.text('Bolkar likhein'));
    await tester.pump();
    await tester.pump();
  }

  group('voice — a worker can SPEAK their report', () {
    testWidgets('the mic starts the DEVICE recogniser and raises the waveform',
        (WidgetTester tester) async {
      await pump(tester);
      expect(find.text('Bolkar likhein'), findsOneWidget);

      await startDictation(tester);

      expect(speech.initCalls, 1, reason: 'permission is asked through init');
      expect(speech.listenCalls, 1);
      expect(find.byKey(const ValueKey<String>('feedbackVoiceWave')),
          findsOneWidget);
      // Same two controls as the chat composer — no second gesture vocabulary.
      expect(find.byType(DictationBar), findsOneWidget);
      expect(find.byTooltip(DictationBar.kStopLabel), findsOneWidget);
    });

    testWidgets('Stop lands the words in the SAME box and sends NOTHING',
        (WidgetTester tester) async {
      await pump(tester);
      await startDictation(tester);

      speech.hear('bijli ka kaam', isFinal: true);
      await tester.pump();
      // Nothing is typed while listening — the words land on Stop.
      expect(_fieldText(tester), isEmpty);

      await tester.tap(find.byTooltip(DictationBar.kStopLabel));
      await tester.pumpAndSettle();

      expect(_fieldText(tester), 'bijli ka kaam');
      // The worker gets to FIX it before sending — that is the whole reason the
      // speech goes to the text box rather than straight to the wire.
      verifyNever(() => repo.submit(
            message: any(named: 'message'),
            category: any(named: 'category'),
            screen: any(named: 'screen'),
          ));
    });

    testWidgets('already-typed text is preserved — dictation APPENDS',
        (WidgetTester tester) async {
      await pump(tester);
      await tester.enterText(find.byType(TextField), 'pehle likha');
      await tester.pump();

      await startDictation(tester);
      speech.hear('phir bola', isFinal: true);
      await tester.pump();
      await tester.tap(find.byTooltip(DictationBar.kStopLabel));
      await tester.pumpAndSettle();

      expect(_fieldText(tester), 'pehle likha phir bola');
    });

    testWidgets('Send on the listening row submits the spoken words in one tap',
        (WidgetTester tester) async {
      await pump(tester);
      await startDictation(tester);
      speech.hear('app khul nahi raha', isFinal: true);
      await tester.pump();

      await tester.tap(find.byTooltip(DictationBar.kSendLabel));
      await tester.pumpAndSettle();

      verify(() => repo.submit(
          message: 'app khul nahi raha',
          category: null,
          screen: null)).called(1);
    });

    testWidgets(
        'the big Bhejein button does not LOSE words still in the recogniser',
        (WidgetTester tester) async {
      await pump(tester);
      await startDictation(tester);
      speech.hear('mera paisa nahi aaya', isFinal: true);
      await tester.pump();

      // The box is still empty here, so a naive `_hasText` gate would have left
      // this button disabled — a dead control, on the screen about dead controls.
      await tester.tap(find.text('Bhejein'));
      await tester.pumpAndSettle();

      verify(() => repo.submit(
          message: 'mera paisa nahi aaya',
          category: null,
          screen: null)).called(1);
    });

    testWidgets('a DENIED mic is an honest notice, never a crash — typing lives',
        (WidgetTester tester) async {
      speech.ready = false;
      await pump(tester);
      await startDictation(tester);
      await tester.pumpAndSettle();

      expect(find.text(const MicPermissionFailure().message), findsOneWidget);
      expect(find.byKey(const ValueKey<String>('feedbackVoiceWave')),
          findsNothing);
      await tester.enterText(find.byType(TextField), 'type karke likh raha hoon');
      await tester.pump();
      expect(_fieldText(tester), 'type karke likh raha hoon');
    });

    testWidgets('NO recogniser registered at all is a silent no-op',
        (WidgetTester tester) async {
      await locator.reset();
      locator.registerFactory<FeedbackRepository>(() => repo);
      await pump(tester);

      await startDictation(tester);
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey<String>('feedbackVoiceWave')),
          findsNothing);
      expect(find.text('Bolkar likhein'), findsOneWidget);
    });
  });

  group('#1013 — the 4000-character dead end', () {
    test('the cap is the SERVER\'s number, pinned as a literal', () {
      // WORKER_FEEDBACK_MESSAGE_MAX in packages/types, and the
      // `worker_feedback_message_len_chk` CHECK. Every other test here derives
      // its expectation FROM the constant, so none of them can catch the
      // constant being wrong — and a client cap that is merely self-consistent
      // is not a client cap, it is a second, different dead end.
      expect(kWorkerFeedbackMessageMax, 4000);
    });

    testWidgets('a SHORT report is never shown a counter', (
      WidgetTester tester,
    ) async {
      await pump(tester);
      await tester.enterText(find.byType(TextField), 'button kaam nahi kar raha');
      await tester.pump();

      // A "25 / 4000" under an empty-ish box reads as a quota to fill. The point
      // of this screen is that four words is a complete report.
      expect(find.textContaining('akshar'), findsNothing);
    });

    testWidgets('the counter appears only as the cap APPROACHES', (
      WidgetTester tester,
    ) async {
      await pump(tester);
      final int justOutside =
          kWorkerFeedbackMessageMax - kFeedbackCounterShowsWithin - 1;
      await tester.enterText(find.byType(TextField), 'a' * justOutside);
      await tester.pump();
      await revealVoiceRow(tester);
      expect(find.textContaining('akshar'), findsNothing);

      await tester.enterText(find.byType(TextField), 'a' * (justOutside + 1));
      await tester.pump();
      await revealVoiceRow(tester);
      expect(find.text('$kFeedbackCounterShowsWithin akshar bache'),
          findsOneWidget);
    });

    testWidgets('the worker CANNOT type past the server bound', (
      WidgetTester tester,
    ) async {
      await pump(tester);
      await tester.enterText(
          find.byType(TextField), 'a' * (kWorkerFeedbackMessageMax + 500));
      await tester.pump();

      expect(_fieldText(tester).length, kWorkerFeedbackMessageMax,
          reason: 'the dead end is closed at the door, not explained after');
      await revealVoiceRow(tester);
      expect(
        find.text('Itna hi likh sakte hain ($kWorkerFeedbackMessageMax akshar).'),
        findsOneWidget,
      );
    });

    testWidgets('spoken words are bounded too', (WidgetTester tester) async {
      await pump(tester);
      await startDictation(tester);
      speech.hear('b' * (kWorkerFeedbackMessageMax + 200), isFinal: true);
      await tester.pump();
      await tester.tap(find.byTooltip(DictationBar.kStopLabel));
      await tester.pumpAndSettle();

      expect(_fieldText(tester).length, kWorkerFeedbackMessageMax);
    });

    testWidgets(
        'a 400 from the server is RECOVERABLE — never "thodi der baad try karein"',
        (WidgetTester tester) async {
      when(() => repo.submit(
            message: any(named: 'message'),
            category: any(named: 'category'),
            screen: any(named: 'screen'),
          )).thenThrow(ApiException(400, 'message is too long'));

      await pump(tester);
      await tester.enterText(find.byType(TextField), 'kuch dikkat hai');
      await tester.pump();
      await tester.tap(find.text('Bhejein'));
      await tester.pumpAndSettle();

      // A 400 is the server's considered answer about THIS content: waiting
      // changes nothing, so the copy must not send the worker away to wait.
      expect(find.textContaining('Thodi der baad'), findsNothing);
      expect(find.text(const InvalidRequestFailure().message), findsOneWidget);
      // And it STAYS on screen — a snackbar the worker must act on vanishes
      // while they are still reading it.
      expect(find.byType(SnackBar), findsNothing);
      expect(find.text('kuch dikkat hai'), findsOneWidget,
          reason: 'their words are never thrown away by a refusal');
      // The server message is NEVER forwarded into the UI.
      expect(find.textContaining('message is too long'), findsNothing);
    });
  });

  group('the consent dead end (tri-state UNKNOWN → a real 403)', () {
    testWidgets('the refusal carries a way OUT, not a snackbar that disappears',
        (WidgetTester tester) async {
      when(() => repo.submit(
            message: any(named: 'message'),
            category: any(named: 'category'),
            screen: any(named: 'screen'),
          )).thenThrow(const ConsentRequiredFailure());

      await pump(tester);
      await tester.enterText(find.byType(TextField), 'paisa nahi mila');
      await tester.pump();
      await tester.tap(find.text('Bhejein'));
      await tester.pumpAndSettle();

      expect(find.byType(SnackBar), findsNothing,
          reason: 'the old dead end WAS a snackbar with nothing to act on');
      expect(find.text('Aage badhne ke liye consent dena hoga.'), findsOneWidget);
      expect(find.text('Consent dein'), findsOneWidget);
      // Honest about the cost: nothing they typed is stored before consent.
      expect(
        find.text('Aapki baat abhi nahi bheji gayi. Consent ke baad Feedback '
            'dobara kholkar bhejein.'),
        findsOneWidget,
      );
    });

    testWidgets('"Consent dein" actually reaches the consent screen',
        (WidgetTester tester) async {
      when(() => repo.submit(
            message: any(named: 'message'),
            category: any(named: 'category'),
            screen: any(named: 'screen'),
          )).thenThrow(const ConsentRequiredFailure());

      final GoRouter router = await pump(tester);
      await tester.enterText(find.byType(TextField), 'paisa nahi mila');
      await tester.pump();
      await tester.tap(find.text('Bhejein'));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Consent dein'));
      await tester.pumpAndSettle();

      expect(router.routerDelegate.currentConfiguration.uri.toString(),
          '/consent');
      expect(find.text('Your privacy'), findsOneWidget);
    });

    testWidgets('a TRANSIENT failure still uses a snackbar and is retryable',
        (WidgetTester tester) async {
      // The counterpart: "that didn't work, try again" is exactly what a
      // snackbar is for, because the next tap may well succeed.
      when(() => repo.submit(
            message: any(named: 'message'),
            category: any(named: 'category'),
            screen: any(named: 'screen'),
          )).thenThrow(const NetworkFailure());

      await pump(tester);
      await tester.enterText(find.byType(TextField), 'net dikkat');
      await tester.pump();
      await tester.tap(find.text('Bhejein'));
      await tester.pumpAndSettle();

      expect(find.byType(SnackBar), findsOneWidget);
      expect(find.text('Consent dein'), findsNothing);
    });
  });

  group('which screen the worker was on', () {
    testWidgets('the route at tap time travels to the repository', (
      WidgetTester tester,
    ) async {
      await pump(tester,
          fromRoute: '/jobs/6f2c04e0-4f89-41d3-9a0c-0305e82c3301/apply');
      await tester.enterText(find.byType(TextField), 'button kaam nahi kar raha');
      await tester.pump();
      await tester.tap(find.text('Bhejein'));
      await tester.pumpAndSettle();

      // RAW here on purpose: normalization is the repository's wire boundary, so
      // no screen can forget it. See feedback_repository_impl_test.dart.
      verify(() => repo.submit(
            message: 'button kaam nahi kar raha',
            category: null,
            screen: '/jobs/6f2c04e0-4f89-41d3-9a0c-0305e82c3301/apply',
          )).called(1);
    });

    testWidgets('no route (a deep link / restored state) still submits', (
      WidgetTester tester,
    ) async {
      await pump(tester);
      await tester.enterText(find.byType(TextField), 'seedha likha');
      await tester.pump();
      await tester.tap(find.text('Bhejein'));
      await tester.pumpAndSettle();

      verify(() => repo.submit(
          message: 'seedha likha', category: null, screen: null)).called(1);
    });
  });

  /// The two ways this screen could still hand a worker nothing: swallow the
  /// words they typed, or absorb a tap on the primary control.
  group('voice — no silent losses, no dead controls', () {
    testWidgets('the box stops accepting edits while the mic is live', (
      WidgetTester tester,
    ) async {
      await pump(tester);
      await tester.enterText(find.byType(TextField), 'Search kaam nahi');
      await tester.pump();
      await revealVoiceRow(tester);
      await startDictation(tester);

      // The recognised block is assigned over the field WHOLESALE, built on the
      // text snapshotted when the mic started — so anything typed in between
      // would be destroyed without a word. The field goes read-only instead.
      expect(tester.widget<TextField>(find.byType(TextField)).readOnly, isTrue);
      await tester.enterText(find.byType(TextField), 'Search kaam nahi kar raha');
      await tester.pump();
      expect(_fieldText(tester), 'Search kaam nahi');

      speech.hear('button dabane par', isFinal: true);
      await tester.tap(find.byTooltip(DictationBar.kStopLabel));
      await tester.pump();
      await tester.pump();

      expect(_fieldText(tester), 'Search kaam nahi button dabane par');
      expect(tester.widget<TextField>(find.byType(TextField)).readOnly, isFalse);
    });

    testWidgets('Stop with nothing heard says so instead of going quiet', (
      WidgetTester tester,
    ) async {
      await pump(tester);
      await revealVoiceRow(tester);
      await startDictation(tester);

      // Too quiet, too loud a workshop, or no local model: the mic ran and
      // produced nothing. Dropping the waveform in silence reads as a broken app.
      await tester.tap(find.byTooltip(DictationBar.kStopLabel));
      await tester.pump();
      await tester.pump();

      expect(find.text(kVoiceToTextUnavailable), findsOneWidget);
    });

    testWidgets('Send with nothing heard notices, and posts nothing', (
      WidgetTester tester,
    ) async {
      await pump(tester);
      await revealVoiceRow(tester);
      await startDictation(tester);

      // Before: this landed an empty string, [_submit] returned on the empty
      // field, and the worker got NO snackbar, no busy state, no reaction at all
      // from the primary control — the dead control this screen exists to remove.
      await tester.tap(find.byTooltip(DictationBar.kSendLabel));
      await tester.pump();
      await tester.pump();

      expect(find.text(kVoiceToTextUnavailable), findsOneWidget);
      verifyNever(() => repo.submit(
            message: any(named: 'message'),
            category: any(named: 'category'),
            screen: any(named: 'screen'),
          ));
    });
  });
}
