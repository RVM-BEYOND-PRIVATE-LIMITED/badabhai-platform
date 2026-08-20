// Voice, the 4000-character dead end (#1013), and the two consent dead ends —
// on the ONE screen whose whole job is "tell us what is wrong".
//
// Everything here is about a worker who is not habituated to apps: they cannot
// be asked to type a paragraph, they must not be able to type themselves into an
// error nobody can clear, and they must never be handed a refusal with no way to
// act on it.
//
// ── THE CANVAS IS THE POINT ──────────────────────────────────────────────────
// Every test in this file runs at [_kBudgetPhone] — 360x640dp, a typical budget
// Android viewport — because the previous round of this suite asked for a
// 900x1900 canvas "so the mic row falls outside the viewport". That canvas was
// not a test detail; it was the bug, written into the setup. On the hardware
// these workers own, the mic sat ~100dp past the fold inside a lazy ListView and
// was never BUILT at all, and the screen's own hint pointed at it. A test whose
// surface exists to hide a defect is worse than no test, so the surface is now
// the device, and the first group below asserts the thing that used to be false.
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/theme/app_spacing.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/features/consent/presentation/consent_screen.dart';
import 'package:badabhai_worker_app/features/feedback/domain/feedback_category.dart';
import 'package:badabhai_worker_app/features/feedback/domain/feedback_limits.dart';
import 'package:badabhai_worker_app/features/feedback/domain/feedback_repository.dart';
import 'package:badabhai_worker_app/features/feedback/presentation/feedback_screen.dart';
import 'package:badabhai_worker_app/features/voice/domain/speech_dictation.dart';
import 'package:badabhai_worker_app/features/voice/presentation/dictation_controller.dart';

// The SAME hand double the controller's own suite drives, on purpose: a second
// copy is a second thing that can drift away from the recogniser's real shape.
import '../voice/dictation_controller_test.dart' show FakeDictation;

class _MockFeedbackRepository extends Mock implements FeedbackRepository {}

/// A typical budget Android phone, in logical pixels at dpr 1.
const Size _kBudgetPhone = Size(360, 640);

/// How much of that screen a soft keyboard eats. Deliberately generous: the
/// keyboard is the state the worker is IN while they write a report.
const double _kKeyboardInset = 300;

/// A finder for the recognised text sitting in the box.
String _fieldText(WidgetTester tester) =>
    tester.widget<TextField>(find.byType(TextField)).controller!.text;

void main() {
  late _MockFeedbackRepository repo;
  late FakeDictation speech;

  /// What the consent route was handed, so a test can prove the feedback screen
  /// declares itself a RECOVERY rather than the first onboarding step.
  Object? consentExtra;

  setUpAll(() => registerFallbackValue(FeedbackCategory.other));

  setUp(() async {
    await locator.reset();
    repo = _MockFeedbackRepository();
    speech = FakeDictation();
    consentExtra = null;
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
  /// to land and a push to /consent has a route to reach.
  ///
  /// [keyboard] raises a soft keyboard of [_kKeyboardInset] before the first
  /// frame — the state a worker writing a report is actually in.
  Future<GoRouter> pump(
    WidgetTester tester, {
    String? fromRoute,
    bool keyboard = false,
  }) async {
    tester.view.physicalSize = _kBudgetPhone;
    tester.view.devicePixelRatio = 1.0;
    if (keyboard) {
      tester.view.viewInsets =
          const FakeViewPadding(bottom: _kKeyboardInset);
    }
    addTearDown(tester.view.reset);
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
        // A stand-in for the real consent screen that records what it was handed
        // and offers the two ways out the real one now has: accept (pop true) and
        // decline (pop false). The real screen's own half is asserted in
        // test/features/consent/consent_screen_test.dart.
        GoRoute(
          path: '/consent',
          builder: (BuildContext c, GoRouterState s) {
            consentExtra = s.extra;
            return Scaffold(
              body: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: <Widget>[
                  const Text('Your privacy'),
                  TextButton(
                    onPressed: () => c.pop(true),
                    child: const Text('ACCEPT'),
                  ),
                  TextButton(
                    onPressed: () => c.pop(false),
                    child: const Text('DECLINE'),
                  ),
                ],
              ),
            );
          },
        ),
      ],
    );
    await tester.pumpWidget(
        MaterialApp.router(theme: AppTheme.light(), routerConfig: router));
    await tester.tap(find.text('OPEN'));
    await tester.pumpAndSettle();
    return router;
  }

  /// The ONE voice control: the mic inside the box, which becomes Stop while the
  /// recogniser runs.
  final Finder voiceControl = find.byKey(kFeedbackVoiceControlKey);

  Future<void> startDictation(WidgetTester tester) async {
    await tester.tap(voiceControl);
    await tester.pump();
    await tester.pump();
  }

  /// A long report grows the box past the viewport, and a lazy ListView never
  /// BUILDS what is off screen — so scroll the counter into view before
  /// asserting anything about it.
  Future<void> revealCounter(WidgetTester tester, Finder counter) async {
    await tester.scrollUntilVisible(
      counter,
      400,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.pump();
  }

  group('the mic is on the screen the worker actually owns', () {
    testWidgets(
        'BUILT and TAPPABLE at 360x640 with the keyboard up — not merely present',
        (WidgetTester tester) async {
      await pump(tester, keyboard: true);

      // (1) Built at all, and hit-testable — `hitTestable()` rejects a widget the
      // lazy list only kept in its cache, which is exactly what the old layout
      // produced: built-at-all=1, on-screen=0.
      expect(voiceControl.hitTestable(), findsOneWidget,
          reason: 'the mic must exist on a 360x640 viewport, keyboard up');

      // (2) And ABOVE the keyboard. A widget test paints no keyboard, so
      // hit-testing alone would happily "tap" a control the soft keyboard is
      // sitting on top of. Measure it instead.
      final Rect mic = tester.getRect(voiceControl);
      final double fold = _kBudgetPhone.height - _kKeyboardInset;
      expect(mic.bottom, lessThanOrEqualTo(fold),
          reason: 'the whole control must clear the keyboard line ($fold)');
      expect(mic.top, greaterThanOrEqualTo(0.0));

      // (3) And it is there AS THE SCREEN OPENS, not somewhere the list had to
      // be scrolled to. Without this the assertions above pass on the strength
      // of the autofocused caret dragging the viewport down to the box — which
      // is a lucky side effect, not a layout, and it evaporates the moment
      // `autofocus` or the caret position changes.
      final ScrollPosition scroll = tester
          .state<ScrollableState>(find.byType(Scrollable).first)
          .position;
      expect(scroll.pixels, 0.0,
          reason: 'the mic must be above the fold unscrolled');

      // (4) And it is a 48dp+ target for a gloved thumb (AppSpacing.tap).
      expect(mic.width, greaterThanOrEqualTo(AppSpacing.tap));
      expect(mic.height, greaterThanOrEqualTo(AppSpacing.tap));

      // (5) And tapping it really starts the device recogniser.
      await tester.tap(voiceControl);
      await tester.pump();
      await tester.pump();
      expect(speech.listenCalls, 1);
    });

    testWidgets('starting dictation puts the keyboard away', (
      WidgetTester tester,
    ) async {
      await pump(tester, keyboard: true);
      expect(tester.state<EditableTextState>(find.byType(EditableText))
          .widget.focusNode.hasFocus, isTrue,
          reason: 'the box autofocuses, so the keyboard is up to begin with');

      await startDictation(tester);

      // This is what makes the listening state's own geometry honest: while the
      // mic runs the worker is not typing, so the keyboard is not there.
      expect(tester.state<EditableTextState>(find.byType(EditableText))
          .widget.focusNode.hasFocus, isFalse);
    });

    testWidgets('the listening cue AND its stop are on screen at 360x640', (
      WidgetTester tester,
    ) async {
      // Keyboard down, because the test above proves dictation dismisses it.
      await pump(tester);
      await startDictation(tester);

      final Size screen = _kBudgetPhone;
      final Rect wave = tester.getRect(find.byKey(kFeedbackVoiceWaveKey));
      expect(wave.bottom, lessThanOrEqualTo(screen.height),
          reason: 'a worker must be able to SEE that the mic is live');
      // The same slot the mic was in is now Stop — one control, one place.
      expect(voiceControl.hitTestable(), findsOneWidget);
      final Rect stop = tester.getRect(voiceControl);
      expect(stop.bottom, lessThanOrEqualTo(screen.height),
          reason: 'a worker must always be able to STOP the mic');
      expect(find.text(kFeedbackStopLabel), findsOneWidget);
      expect(find.text(kFeedbackSpeakLabel), findsNothing);
    });
  });

  group('accessibility — the labels a worker who cannot read icons needs', () {
    testWidgets('the voice control carries a real accessible NAME, both states',
        (WidgetTester tester) async {
      final SemanticsHandle handle = tester.ensureSemantics();
      await pump(tester);

      // A tooltip is not a name: it needs a long-press to appear, and a worker
      // who cannot read a mic glyph has no reason to try one.
      expect(find.bySemanticsLabel(kFeedbackSpeakSemantics), findsOneWidget);
      // ...and it is printed on the control too, not hidden behind a gesture.
      expect(find.text(kFeedbackSpeakLabel), findsOneWidget);

      await startDictation(tester);

      expect(find.bySemanticsLabel(kFeedbackStopSemantics), findsOneWidget);
      expect(find.bySemanticsLabel(kFeedbackSpeakSemantics), findsNothing);
      handle.dispose();
    });

    testWidgets('the waveform is announced, not just painted', (
      WidgetTester tester,
    ) async {
      final SemanticsHandle handle = tester.ensureSemantics();
      await pump(tester);
      await startDictation(tester);

      // A CustomPaint has no semantics of its own, so before this the most
      // important state on the screen reached a screen reader as nothing at all.
      final SemanticsNode node = tester.getSemantics(
          find.bySemanticsLabel(kFeedbackListeningLabel).first);
      expect(node.label, kFeedbackListeningLabel);
      expect(node.flagsCollection.isLiveRegion, isTrue,
          reason: 'the mic going hot must be ANNOUNCED, not waited for');
      handle.dispose();
    });

    testWidgets('the consent way-out clears the 48dp worker touch floor', (
      WidgetTester tester,
    ) async {
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

      // MEASURED, because the naive assertion here cannot fail: Material pads
      // every button's HIT BOX out to 48dp (`MaterialTapTargetSize.padded`), so
      // `getSize(FilledButton)` reads 48 even at BbButtonSize.md. What is 44dp
      // at md is the button the worker can actually SEE and aim at, and that is
      // the number this design system's spacing tokens put a floor under. So
      // measure the PAINTED control, not the invisible padding around it.
      final Size painted = tester.getSize(find
          .descendant(
            of: find.widgetWithText(FilledButton, 'Consent dein'),
            matching: find.byType(Material),
          )
          .first);
      expect(painted.height, greaterThanOrEqualTo(AppSpacing.tap));
    });
  });

  group('voice — a worker can SPEAK their report', () {
    testWidgets('the mic starts the DEVICE recogniser and raises the waveform',
        (WidgetTester tester) async {
      await pump(tester);
      expect(voiceControl, findsOneWidget);
      expect(find.byKey(kFeedbackVoiceWaveKey), findsNothing);

      await startDictation(tester);

      expect(speech.initCalls, 1, reason: 'permission is asked through init');
      expect(speech.listenCalls, 1);
      expect(find.byKey(kFeedbackVoiceWaveKey), findsOneWidget);
      expect(find.text(kFeedbackListeningLabel), findsOneWidget);
    });

    testWidgets('Stop lands the words in the SAME box and sends NOTHING',
        (WidgetTester tester) async {
      await pump(tester);
      await startDictation(tester);

      speech.hear('bijli ka kaam', isFinal: true);
      await tester.pump();
      // Nothing is typed while listening — the words land on Stop.
      expect(_fieldText(tester), isEmpty);

      await tester.tap(voiceControl);
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
      await tester.tap(voiceControl);
      await tester.pumpAndSettle();

      expect(_fieldText(tester), 'pehle likha phir bola');
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
      // It is also the ONLY send on this screen: the listening state has a Stop,
      // not a second Send, so there is one way to send and it is always visible.
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
      expect(find.byKey(kFeedbackVoiceWaveKey), findsNothing);
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

      expect(find.byKey(kFeedbackVoiceWaveKey), findsNothing);
      expect(find.text(kFeedbackSpeakLabel), findsOneWidget);
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
      expect(find.textContaining('akshar', skipOffstage: false), findsNothing);

      await tester.enterText(find.byType(TextField), 'a' * (justOutside + 1));
      await tester.pump();
      final Finder counter =
          find.text('$kFeedbackCounterShowsWithin akshar bache');
      await revealCounter(tester, counter);
      expect(counter, findsOneWidget);
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
      final Finder counter =
          find.text('Itna hi likh sakte hain ($kWorkerFeedbackMessageMax akshar).');
      await revealCounter(tester, counter);
      expect(counter, findsOneWidget);
    });

    testWidgets('spoken words are bounded too', (WidgetTester tester) async {
      await pump(tester);
      await startDictation(tester);
      speech.hear('b' * (kWorkerFeedbackMessageMax + 200), isFinal: true);
      await tester.pump();
      await tester.tap(voiceControl);
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
      expect(_fieldText(tester), 'kuch dikkat hai',
          reason: 'their words are never thrown away by a refusal');
      // The server message is NEVER forwarded into the UI.
      expect(find.textContaining('message is too long'), findsNothing);
    });
  });

  group('the consent dead end (tri-state UNKNOWN → a real 403)', () {
    /// Type a report and get the 403 refusal onto the screen.
    Future<GoRouter> refused(WidgetTester tester) async {
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
      return router;
    }

    testWidgets('the refusal carries a way OUT, not a snackbar that disappears',
        (WidgetTester tester) async {
      await refused(tester);

      expect(find.byType(SnackBar), findsNothing,
          reason: 'the old dead end WAS a snackbar with nothing to act on');
      expect(find.text('Aage badhne ke liye consent dena hoga.'), findsOneWidget);
      expect(find.text('Consent dein'), findsOneWidget);
      // Honest, and now true: the box survives the trip, so say so.
      expect(
        find.text('Aapki baat abhi nahi bheji gayi. Consent dene ke baad wapas '
            'aakar Bhejein dabayein — aapki baat yahin rahegi.'),
        findsOneWidget,
      );
    });

    testWidgets('"Consent dein" PUSHES consent — the feedback screen survives',
        (WidgetTester tester) async {
      final GoRouter router = await refused(tester);

      await tester.tap(find.text('Consent dein'));
      await tester.pumpAndSettle();

      expect(find.text('Your privacy'), findsOneWidget);
      // `go` REPLACED the stack: consent with no back button, and accepting
      // carried an onboarded worker on into /name and the interview. A push
      // keeps the report alive underneath and declares itself a RECOVERY, which
      // is what stops the consent screen walking on into onboarding.
      expect(consentExtra, isA<ConsentReturnIntent>());
      expect(find.byType(FeedbackScreen, skipOffstage: false), findsOneWidget,
          reason: 'the screen they were writing on must still be on the stack');
      expect(router.routerDelegate.canPop(), isTrue,
          reason: 'a worker who taps in must be able to back out');
    });

    testWidgets('DECLINING returns to the report, with every word still there',
        (WidgetTester tester) async {
      await refused(tester);
      await tester.tap(find.text('Consent dein'));
      await tester.pumpAndSettle();

      await tester.tap(find.text('DECLINE'));
      await tester.pumpAndSettle();

      expect(find.text('Your privacy'), findsNothing);
      // The SAME screen state, not a rebuilt one: a fresh FeedbackScreen would
      // come back with an empty box.
      expect(_fieldText(tester), 'paisa nahi mila');
    });

    testWidgets('ACCEPTING comes back here and re-arms Bhejein — never /name',
        (WidgetTester tester) async {
      await refused(tester);
      await tester.tap(find.text('Consent dein'));
      await tester.pumpAndSettle();

      await tester.tap(find.text('ACCEPT'));
      await tester.pumpAndSettle();

      expect(find.text('Your privacy'), findsNothing);
      expect(_fieldText(tester), 'paisa nahi mila');
      // The refusal panel described an attempt that is over; it must not sit
      // there telling a worker who has just consented that they need consent.
      expect(find.text('Consent dein'), findsNothing);
      expect(find.text('Consent ho gaya. Ab "Bhejein" dabayein.'), findsOneWidget);

      // And the send goes through now — nothing was posted behind their back on
      // the way through consent; the tap stayed theirs.
      when(() => repo.submit(
            message: any(named: 'message'),
            category: any(named: 'category'),
            screen: any(named: 'screen'),
          )).thenAnswer((_) async {});
      await tester.tap(find.text('Bhejein'));
      await tester.pumpAndSettle();
      expect(find.byType(FeedbackScreen), findsNothing);
      expect(find.textContaining('Shukriya'), findsOneWidget);
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
      await startDictation(tester);

      // The recognised block is assigned over the field WHOLESALE, built on the
      // text snapshotted when the mic started — so anything typed in between
      // would be destroyed without a word. The field goes read-only instead.
      expect(tester.widget<TextField>(find.byType(TextField)).readOnly, isTrue);
      await tester.enterText(find.byType(TextField), 'Search kaam nahi kar raha');
      await tester.pump();
      expect(_fieldText(tester), 'Search kaam nahi');

      speech.hear('button dabane par', isFinal: true);
      await tester.tap(voiceControl);
      await tester.pump();
      await tester.pump();

      expect(_fieldText(tester), 'Search kaam nahi button dabane par');
      expect(tester.widget<TextField>(find.byType(TextField)).readOnly, isFalse);
    });

    testWidgets('Stop with nothing heard says so instead of going quiet', (
      WidgetTester tester,
    ) async {
      await pump(tester);
      await startDictation(tester);

      // Too quiet, too loud a workshop, or no local model: the mic ran and
      // produced nothing. Dropping the waveform in silence reads as a broken app.
      await tester.tap(voiceControl);
      await tester.pump();
      await tester.pump();

      expect(find.text(kVoiceToTextUnavailable), findsOneWidget);
    });

    testWidgets('Bhejein with nothing heard notices, and posts nothing', (
      WidgetTester tester,
    ) async {
      await pump(tester);
      await startDictation(tester);

      // Bhejein stays enabled while the mic is live (the words are in the
      // recogniser, not the field), so it is reachable with nothing to send.
      // Absorbing that tap is the dead control this screen exists to remove.
      await tester.tap(find.text('Bhejein'));
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
