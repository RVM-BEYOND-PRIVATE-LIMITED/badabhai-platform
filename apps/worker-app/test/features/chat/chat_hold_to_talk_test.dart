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
/// through the result callback (and a sound level, if set) so the widget's
/// live-fill + waveform can be exercised without a platform channel.
class FakeSpeechDictation implements SpeechDictation {
  bool ready = true;
  bool listening = false;
  String emit = '';

  /// A SECOND final, emitted right after [emit] within the same listen — stands
  /// in for the impl's continuous-listen restart, where the words spoken before a
  /// mid-session pause are flushed as a final and the next utterance arrives as a
  /// fresh final that must APPEND, not overwrite.
  String emit2 = '';
  double emitLevel = 0;
  int initCalls = 0;
  int listenCalls = 0;
  int stopCalls = 0;

  /// The last result sink handed to [listen] — a test can replay it to simulate
  /// a TRAILING final the recogniser flushes after the worker tapped Stop.
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

/// Tap-to-talk on the chat composer (owner request): the trailing button in the
/// SEND slot is a MIC when the composer is empty. TAP it → the device recogniser
/// starts and KEEPS listening (no hold), filling the input field live and showing
/// the waveform. The button becomes STOP; tapping STOP ends listening, the text
/// stays, and the button becomes SEND. It goes as an ORDINARY chat message — no
/// server voice endpoint. The haldi mic on the LEFT still opens the voice screen.
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

  // Opacity of the live-waveform cue (0 hidden, 1 shown while listening).
  double waveOpacity(WidgetTester tester) {
    final AnimatedOpacity ao = tester.widget<AnimatedOpacity>(
      find.byKey(const ValueKey<String>('voiceWaveCue')),
    );
    return ao.opacity;
  }

  // The three states of the trailing composer button, by their tooltips (the
  // left voice-note mic is a separate button and is never matched here).
  Finder micButton() => find.byTooltip('Bolkar likhein');
  Finder stopButton() => find.byTooltip('Rokein');
  Finder sendButton() => find.byTooltip('Bhejein');

  /// Tap the mic and pump through initialize()+listen() so the recogniser's
  /// results have reached the composer.
  Future<void> startDictation(WidgetTester tester) async {
    await tester.tap(micButton());
    await tester.pump(); // _startDictation -> setState(listening)
    await tester.pump(); // initialize()
    await tester.pump(); // listen() -> onResult fills the field
  }

  Future<void> stopDictation(WidgetTester tester) async {
    await tester.tap(stopButton());
    await tester.pump();
    await tester.pumpAndSettle();
  }

  testWidgets(
      'tap Mic runs device dictation, shows the waveform, fills the composer; '
      'Stop ends it and Send appears — sending nothing', (
    WidgetTester tester,
  ) async {
    speech.emit = 'Me CNC per kaam krta hun';

    await pumpScreen(tester);
    expect(waveOpacity(tester), 0);
    expect(micButton(), findsOneWidget); // empty composer → mic in the send slot

    await startDictation(tester);

    expect(speech.initCalls, 1);
    expect(speech.listenCalls, 1);
    expect(waveOpacity(tester), 1, reason: 'the waveform shows while listening');
    expect(find.text('Me CNC per kaam krta hun'), findsOneWidget);
    expect(stopButton(), findsOneWidget); // now a Stop button, no hold needed

    await stopDictation(tester);

    expect(speech.stopCalls, 1);
    expect(waveOpacity(tester), 0);
    // The text stayed and the button is now Send — but nothing was sent yet.
    expect(sendButton(), findsOneWidget);
    expect(find.text('Me CNC per kaam krta hun'), findsOneWidget);
    verifyNever(() => chat.sendMessage(any(),
        submissionId: any(named: 'submissionId')));
  });

  testWidgets('tapping Send after dictation sends the recognised text once',
      (WidgetTester tester) async {
    speech.emit = 'CNC operator';
    when(() => chat.sendMessage(any(), submissionId: any(named: 'submissionId')))
        .thenAnswer((_) async => const ChatTurn(reply: 'Got it.'));

    await pumpScreen(tester);
    await startDictation(tester);
    await stopDictation(tester);

    await tester.tap(sendButton());
    await tester.pumpAndSettle();

    verify(() => chat.sendMessage('CNC operator',
        submissionId: any(named: 'submissionId'))).called(1);
    // Composer cleared → the button reverts to Mic for the next turn.
    expect(micButton(), findsOneWidget);
  });

  testWidgets('the waveform stays for the WHOLE listen and hides on Stop', (
    WidgetTester tester,
  ) async {
    speech.emit = 'kuch';

    await pumpScreen(tester);
    await startDictation(tester);
    expect(waveOpacity(tester), 1);

    // No auto-hide — it must persist until the worker taps Stop.
    await tester.pump(const Duration(seconds: 3));
    expect(waveOpacity(tester), 1,
        reason: 'waveform shows until Stop is tapped');

    await stopDictation(tester);
    expect(waveOpacity(tester), 0, reason: 'hidden on Stop');
  });

  testWidgets(
    'a phrase before a mid-listen pause is KEPT — the next utterance appends',
    (WidgetTester tester) async {
      // "hello", then a think (the recogniser silently restarts), then "I am a
      // CLC programmer". The impl flushes the first phrase as a final, so the
      // second lands as "hello I am a CLC programmer" — never dropped.
      speech.emit = 'hello';
      speech.emit2 = 'I am a CLC programmer';

      await pumpScreen(tester);
      await startDictation(tester);

      expect(find.text('hello I am a CLC programmer'), findsOneWidget);
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
      expect(find.text('hello'), findsOneWidget);

      // Utterance 2 after a think — a fresh partial that does NOT extend "hello".
      speech.lastOnResult!(
        const DictationResult('I am a CNC developer', isFinal: false),
      );
      await tester.pump();
      expect(find.text('hello I am a CNC developer'), findsOneWidget);

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
      expect(find.text('I am a CNC developer'), findsOneWidget);

      await stopDictation(tester);
    },
  );

  testWidgets(
    'a trailing final delivered AFTER Stop never re-fills the composer',
    (WidgetTester tester) async {
      // The recogniser can flush one last final asynchronously after the worker
      // tapped Stop. It must be ignored, else the composer refills.
      speech.emit = 'pehla';

      await pumpScreen(tester);
      await startDictation(tester);
      expect(find.text('pehla'), findsOneWidget);

      await stopDictation(tester); // stops accepting dictation

      // The plugin flushes a late final AFTER Stop:
      speech.lastOnResult!(const DictationResult('doosra', isFinal: true));
      await tester.pump();

      final TextField field = tester.widget<TextField>(find.byType(TextField));
      expect(field.controller!.text, 'pehla',
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
      final TextField field = tester.widget<TextField>(find.byType(TextField));
      expect(field.controller!.text, isEmpty);
      expect(micButton(), findsOneWidget); // reverted to Mic
    },
  );
}
