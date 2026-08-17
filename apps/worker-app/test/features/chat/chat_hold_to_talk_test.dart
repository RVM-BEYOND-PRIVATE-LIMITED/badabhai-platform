import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_turn.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';
import 'package:badabhai_worker_app/features/chat/presentation/chat_profiling_screen.dart';
import 'package:badabhai_worker_app/features/voice/domain/speech_dictation.dart';

class MockChatRepository extends Mock implements ChatRepository {}

/// A hand fake for the ON-DEVICE recogniser: [listen] feeds [emit] straight back
/// through the result callback (and a sound level, if set) so the widget's live
/// streaming + auto-stop can be exercised without a platform channel.
class FakeSpeechDictation implements SpeechDictation {
  bool ready = true;
  bool listening = false;
  String emit = '';

  /// A SECOND final, emitted right after [emit] within the same listen — stands
  /// in for the impl's continuous-listen restart, where the words spoken before a
  /// mid-session pause are flushed as a final and the next utterance appends.
  String emit2 = '';
  double emitLevel = 0;
  int initCalls = 0;
  int listenCalls = 0;
  int stopCalls = 0;

  /// The last result sink handed to [listen] — a test can replay it to simulate a
  /// TRAILING final the recogniser flushes after the worker tapped Stop.
  void Function(DictationResult result)? lastOnResult;

  @override
  Future<bool> initialize() async {
    initCalls++;
    return ready;
  }

  @override
  Future<void> listen({
    required void Function(DictationResult result) onResult,
    void Function(double level)? onSoundLevel,
    String? localeId,
  }) async {
    listenCalls++;
    listening = true;
    lastOnResult = onResult;
    if (emitLevel > 0) onSoundLevel?.call(emitLevel);
    if (emit.isNotEmpty) onResult(DictationResult(emit, isFinal: true));
    if (emit2.isNotEmpty) onResult(DictationResult(emit2, isFinal: true));
  }

  @override
  Future<void> stop() async {
    stopCalls++;
    listening = false;
  }

  @override
  Future<void> cancel() async {
    listening = false;
  }

  @override
  bool get isListening => listening;
}

/// Voice-to-text on the chat composer (Gemini-style): the trailing button is a
/// MIC when the field is empty. TAP it → the device recogniser starts, an inline
/// pulsing visualizer shows, and recognised words STREAM into the field LIVE. The
/// button becomes STOP; tapping STOP (or a run of silence via the auto-stop) ends
/// listening, the streamed text stays, and the button becomes SEND.
void main() {
  late MockChatRepository chat;
  late FakeSpeechDictation speech;

  setUp(() async {
    chat = MockChatRepository();
    speech = FakeSpeechDictation();
    await locator.reset();
    locator.registerFactory<ChatBloc>(() => ChatBloc(chat));
    locator.registerLazySingleton<SpeechDictation>(() => speech);
    when(() => chat.ensureSession()).thenAnswer((_) async => null);
  });

  tearDown(() async => locator.reset());

  Future<void> pumpScreen(WidgetTester tester) async {
    tester.view.physicalSize = const Size(400, 700);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(const MaterialApp(home: ChatProfilingScreen()));
    await tester.pump(); // ChatStarted -> ensureSession resolves, spinner drops
    await tester.pumpAndSettle();
  }

  // The inline visualizer shown while listening.
  Finder waveInline() => find.byKey(const ValueKey<String>('voiceWaveInline'));

  // The composer buttons, by tooltip (the left voice-note mic is never matched).
  Finder micButton() => find.byTooltip('Bolkar likhein');
  Finder stopButton() => find.byTooltip('Rokein');
  Finder sendButton() => find.byTooltip('Bhejein');

  String fieldText(WidgetTester tester) =>
      tester.widget<TextField>(find.byType(TextField)).controller!.text;

  /// Tap the mic and pump through initialize()+listen() so the recogniser's
  /// results have streamed into the field.
  Future<void> startDictation(WidgetTester tester) async {
    await tester.tap(micButton());
    await tester.pump(); // _startDictation -> setState(listening)
    await tester.pump(); // initialize()
    await tester.pump(); // listen() -> onResult streams into the field
  }

  Future<void> stopDictation(WidgetTester tester) async {
    await tester.tap(stopButton());
    await tester.pump();
    await tester.pumpAndSettle();
  }

  testWidgets(
      'tap Mic streams text LIVE with the visualizer; Stop keeps the text and '
      'Send appears', (WidgetTester tester) async {
    speech.emit = 'Me CNC per kaam krta hun';

    await pumpScreen(tester);
    expect(micButton(), findsOneWidget);
    expect(waveInline(), findsNothing);

    await startDictation(tester);

    expect(speech.initCalls, 1);
    expect(speech.listenCalls, 1);
    expect(waveInline(), findsOneWidget); // pulsing visualizer shows
    expect(stopButton(), findsOneWidget);
    expect(find.byType(TextField), findsOneWidget); // field stays visible
    // LIVE: the recognised text is already in the field while listening.
    expect(fieldText(tester), 'Me CNC per kaam krta hun');

    await stopDictation(tester);

    expect(speech.stopCalls, 1);
    expect(waveInline(), findsNothing);
    expect(fieldText(tester), 'Me CNC per kaam krta hun'); // stays after Stop
    expect(sendButton(), findsOneWidget);
    verifyNever(() => chat.sendMessage(any(),
        submissionId: any(named: 'submissionId')));
  });

  testWidgets('a run of SILENCE auto-stops listening (text kept, Send appears)',
      (WidgetTester tester) async {
    speech.emit = 'CNC operator';

    await pumpScreen(tester);
    await startDictation(tester);
    expect(waveInline(), findsOneWidget);

    // No further speech → after the silence window the session ends itself.
    await tester.pump(const Duration(seconds: 4));
    await tester.pumpAndSettle();

    expect(speech.stopCalls, 1, reason: 'auto-stop stopped the recogniser');
    expect(waveInline(), findsNothing);
    expect(fieldText(tester), 'CNC operator'); // streamed text kept
    expect(sendButton(), findsOneWidget);
  });

  testWidgets('tapping Send after Stop sends the streamed text once',
      (WidgetTester tester) async {
    speech.emit = 'CNC operator';
    when(() => chat.sendMessage(any(), submissionId: any(named: 'submissionId')))
        .thenAnswer((_) async => const ChatTurn(reply: 'Got it.'));

    await pumpScreen(tester);
    await startDictation(tester);
    await stopDictation(tester);
    expect(fieldText(tester), 'CNC operator');

    await tester.tap(sendButton());
    await tester.pumpAndSettle();

    verify(() => chat.sendMessage('CNC operator',
        submissionId: any(named: 'submissionId'))).called(1);
    expect(micButton(), findsOneWidget); // composer cleared → back to Mic
  });

  testWidgets('the visualizer shows while listening and clears on Stop',
      (WidgetTester tester) async {
    speech.emit = 'kuch';

    await pumpScreen(tester);
    await startDictation(tester);
    expect(waveInline(), findsOneWidget);

    // Persists across a couple of seconds (still under the silence window).
    await tester.pump(const Duration(seconds: 2));
    expect(waveInline(), findsOneWidget);

    await stopDictation(tester);
    expect(waveInline(), findsNothing);
  });

  testWidgets(
    'a phrase before a mid-listen pause is KEPT — the next utterance appends',
    (WidgetTester tester) async {
      // "hello", then a think (the recogniser silently restarts), then "I am a
      // CLC programmer". Both flush as finals; the field must stream to
      // "hello I am a CLC programmer" — the first phrase never dropped.
      speech.emit = 'hello';
      speech.emit2 = 'I am a CLC programmer';

      await pumpScreen(tester);
      await startDictation(tester);

      expect(fieldText(tester), 'hello I am a CLC programmer');
      await stopDictation(tester);
    },
  );

  testWidgets(
    'a phrase kept when the recogniser RESETS its partial mid-listen — no final, '
    'no restart — the pre-pause words survive',
    (WidgetTester tester) async {
      await pumpScreen(tester);
      await startDictation(tester);

      // Utterance 1 — a partial, never finalised.
      speech.lastOnResult!(const DictationResult('hello', isFinal: false));
      await tester.pump();
      expect(fieldText(tester), 'hello');

      // Utterance 2 after a think — a fresh partial that does NOT extend "hello".
      speech.lastOnResult!(
        const DictationResult('I am a CNC developer', isFinal: false),
      );
      await tester.pump();
      expect(fieldText(tester), 'hello I am a CNC developer');

      await stopDictation(tester);
    },
  );

  testWidgets(
    'a partial that GROWS within one utterance updates in place (no dupes)',
    (WidgetTester tester) async {
      await pumpScreen(tester);
      await startDictation(tester);

      speech.lastOnResult!(const DictationResult('I am', isFinal: false));
      await tester.pump();
      speech.lastOnResult!(const DictationResult('I am a CNC', isFinal: false));
      await tester.pump();
      speech.lastOnResult!(
        const DictationResult('I am a CNC developer', isFinal: false),
      );
      await tester.pump();

      // A growing partial replaces in place — never "I am I am a CNC ...".
      expect(fieldText(tester), 'I am a CNC developer');
      await stopDictation(tester);
    },
  );

  testWidgets(
    'a trailing final delivered AFTER Stop never re-fills the composer',
    (WidgetTester tester) async {
      // The recogniser can flush one last final asynchronously after Stop. It
      // must be ignored, else the composer refills.
      speech.emit = 'pehla';

      await pumpScreen(tester);
      await startDictation(tester);
      expect(fieldText(tester), 'pehla');

      await stopDictation(tester); // stops accepting dictation

      // The plugin flushes a late final AFTER Stop:
      speech.lastOnResult!(const DictationResult('doosra', isFinal: true));
      await tester.pump();

      expect(fieldText(tester), 'pehla',
          reason: 'a post-Stop final must not append or refill');
      expect(find.text('pehla doosra'), findsNothing);
    },
  );

  testWidgets(
    'no recogniser / denied mic → honest notice, composer stays empty, stays Mic',
    (WidgetTester tester) async {
      speech.ready = false;

      await pumpScreen(tester);

      await tester.tap(micButton());
      await tester.pump(); // _startDictation
      await tester.pump(); // initialize() -> false
      await tester.pumpAndSettle();

      expect(speech.listenCalls, 0,
          reason: 'never listens without a recogniser');
      expect(find.text(const MicPermissionFailure().message), findsOneWidget);
      expect(waveInline(), findsNothing);
      expect(fieldText(tester), isEmpty);
      expect(micButton(), findsOneWidget); // reverted to Mic
    },
  );
}
