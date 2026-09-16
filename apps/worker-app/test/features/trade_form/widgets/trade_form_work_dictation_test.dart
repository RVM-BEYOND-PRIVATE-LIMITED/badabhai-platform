// LIVE voice-to-text on the work-history description.
//
// ── WHY THIS SUITE EXISTS, AND WHAT IT IS GUARDING AGAINST ───────────────────
// The control this replaced recorded a clip, uploaded it, and waited on server
// STT. Its first network call lived in the STOP handler, so it advertised itself
// to every worker and only discovered the voice stack was dormant AFTER a
// recording existed — then hid itself and deleted the clip, with no message. The
// properties below are the ones that make that class of failure impossible here:
// nothing is uploaded, the control never vanishes, and words that were heard are
// never silently thrown away.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/util/devanagari_guard.dart';
import 'package:badabhai_worker_app/features/trade_form/presentation/widgets/trade_form_work_dictation.dart';
import 'package:badabhai_worker_app/features/voice/domain/speech_dictation.dart';

// The SAME hand double the controller's own suite drives, on purpose: a second
// copy is a second thing that can drift away from the recogniser's real shape.
import '../../voice/dictation_controller_test.dart' show FakeDictation;

/// A typical budget Android phone, in logical pixels at dpr 1 — the hardware
/// these workers actually own.
const Size _kBudgetPhone = Size(360, 640);

void main() {
  late FakeDictation speech;
  late TextEditingController field;
  late List<String> pushed;

  setUp(() async {
    await locator.reset();
    speech = FakeDictation();
    locator.registerSingleton<SpeechDictation>(speech);
    field = TextEditingController();
    pushed = <String>[];
  });

  tearDown(() async {
    field.dispose();
    await locator.reset();
  });

  Future<void> pump(
    WidgetTester tester, {
    bool enabled = true,
    int maxLength = 300,
  }) async {
    tester.view.physicalSize = _kBudgetPhone;
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light(),
        home: Scaffold(
          body: TradeFormWorkDictation(
            controller: field,
            enabled: enabled,
            maxLength: maxLength,
            onText: pushed.add,
          ),
        ),
      ),
    );
  }

  /// Tap the mic and let the start leg settle.
  Future<void> startSpeaking(WidgetTester tester) async {
    await tester.tap(find.byKey(kWorkDictationButtonKey));
    await tester.pumpAndSettle();
  }

  group('TradeFormWorkDictation', () {
    testWidgets('offers the mic without asking any server anything', (
      WidgetTester tester,
    ) async {
      await pump(tester);
      // THE PROPERTY THE OLD MIC COULD NOT HOLD. No session id, no recorder, no
      // bucket, no `/voice/*` route — so there is no server state that can make
      // this control a lie before the worker has even tapped it.
      expect(find.byKey(kWorkDictationButtonKey), findsOneWidget);
      expect(find.text(kWorkDictationIdleLabel), findsOneWidget);
      expect(speech.listenCalls, 0);
    });

    testWidgets('goes live on tap and shows the waveform', (
      WidgetTester tester,
    ) async {
      await pump(tester);
      await startSpeaking(tester);

      expect(speech.listenCalls, 1);
      expect(find.byKey(kWorkDictationWaveKey), findsOneWidget);
      expect(find.text(kWorkDictationStopLabel), findsOneWidget);
    });

    testWidgets('lands the recognised words in the field as the worker speaks', (
      WidgetTester tester,
    ) async {
      await pump(tester);
      await startSpeaking(tester);

      speech.hear('Turning machine par kaam kiya', isFinal: true);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(kWorkDictationButtonKey)); // Rokein
      await tester.pumpAndSettle();

      expect(field.text, 'Turning machine par kaam kiya');
      // The host is told, because assigning the controller bypasses the field's
      // own `onChanged` — without this the entry is never pushed and the words
      // are lost on save.
      expect(pushed.last, 'Turning machine par kaam kiya');
    });

    testWidgets('CONTINUES what was already typed rather than eating it', (
      WidgetTester tester,
    ) async {
      field.text = 'Lathe chalaya';
      await pump(tester);
      await startSpeaking(tester);

      speech.hear('aur quality check kiya', isFinal: true);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(kWorkDictationButtonKey));
      await tester.pumpAndSettle();

      expect(field.text, 'Lathe chalaya aur quality check kiya');
    });

    testWidgets('caps at the server ceiling, so a long answer is not a 400', (
      WidgetTester tester,
    ) async {
      await pump(tester, maxLength: 10);
      await startSpeaking(tester);

      speech.hear('abcdefghijklmnopqrstuvwxyz', isFinal: true);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(kWorkDictationButtonKey));
      await tester.pumpAndSettle();

      expect(field.text.length, lessThanOrEqualTo(10));
      expect(pushed.last.length, lessThanOrEqualTo(10));
    });

    testWidgets('says the SCRIPT was the problem, and never blames the voice', (
      WidgetTester tester,
    ) async {
      await pump(tester);
      await startSpeaking(tester);

      // THE DEFECT THAT KILLED THE OLD MIC, pinned. A Devanagari reading strips
      // to nothing; the control must name the script rule — the one thing the
      // worker can act on — rather than claim it could not hear them.
      speech.hear('मैंने टर्निंग मशीन पर काम किया', isFinal: true);
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(kWorkDictationButtonKey));
      await tester.pumpAndSettle();

      expect(find.byKey(kWorkDictationStatusKey), findsOneWidget);
      expect(find.text(kDevanagariBlockedHint), findsOneWidget);
      expect(find.text(kWorkDictationHeardNothing), findsNothing);
    });

    testWidgets('stays on screen after a failure — it never hides itself', (
      WidgetTester tester,
    ) async {
      await pump(tester);
      await startSpeaking(tester);

      // Stop having heard nothing at all.
      await tester.tap(find.byKey(kWorkDictationButtonKey));
      await tester.pumpAndSettle();

      expect(find.text(kWorkDictationHeardNothing), findsOneWidget);
      // THE REGRESSION GUARD. The old mic latched an `_unavailable` flag and
      // returned `SizedBox.shrink()` — taking the button AND the note row with
      // it, so the worker was left with no control and no explanation. A failure
      // here must always leave a mic to tap again.
      expect(find.byKey(kWorkDictationButtonKey), findsOneWidget);
      expect(find.text(kWorkDictationIdleLabel), findsOneWidget);
    });

    testWidgets('a recogniser that will not start is said out loud', (
      WidgetTester tester,
    ) async {
      speech.ready = false; // no engine, or the platform refused the mic
      await pump(tester);
      await startSpeaking(tester);

      // The controller's own copy, not a second string invented here — it names
      // the ONE thing the worker can act on (phone settings) and says typing
      // still works.
      expect(find.text(const MicPermissionFailure().message), findsOneWidget);
      expect(find.byKey(kWorkDictationButtonKey), findsOneWidget);
    });

    testWidgets('is inert while the page is submitting', (
      WidgetTester tester,
    ) async {
      await pump(tester, enabled: false);

      expect(
        tester.widget<TextButton>(find.byKey(kWorkDictationButtonKey)).onPressed,
        isNull,
      );
      expect(speech.listenCalls, 0);
    });
  });
}
