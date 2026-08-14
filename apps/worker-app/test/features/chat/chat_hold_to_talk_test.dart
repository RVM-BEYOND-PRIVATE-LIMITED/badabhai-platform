import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
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

  /// A SECOND final, emitted right after [emit] within the same hold — stands in
  /// for the impl's continuous-listen restart, where the words spoken before a
  /// mid-hold pause are flushed as a final and the next utterance arrives as a
  /// fresh final that must APPEND, not overwrite.
  String emit2 = '';
  double emitLevel = 0;
  int initCalls = 0;
  int listenCalls = 0;
  int stopCalls = 0;

  /// The last result sink handed to [listen] — a test can replay it to simulate
  /// a TRAILING final the recogniser flushes after the worker released.
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

/// Hold-to-talk on the chat composer mic: a LONG-PRESS runs the DEVICE speech
/// recogniser and fills the input field live (voice → text), showing a live
/// waveform cue while held. The worker then taps Send and it goes as an ORDINARY
/// chat message — no server voice endpoint. A plain TAP still opens the voice
/// screen.
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

  // Opacity of the live-waveform cue (0 hidden, 1 shown while held).
  double waveOpacity(WidgetTester tester) {
    final AnimatedOpacity ao = tester.widget<AnimatedOpacity>(
      find.byKey(const ValueKey<String>('voiceWaveCue')),
    );
    return ao.opacity;
  }

  Finder composerMic() => find.byIcon(Icons.mic);

  testWidgets('holding the mic runs device dictation, shows the waveform, and '
      'fills the composer — sending nothing', (WidgetTester tester) async {
    speech.emit = 'Me CNC per kaam krta hun';

    await pumpScreen(tester);
    expect(waveOpacity(tester), 0);

    final TestGesture gesture = await tester.startGesture(
      tester.getCenter(composerMic()),
    );
    await tester.pump(const Duration(milliseconds: 600)); // long-press fires
    await tester.pump(); // initialize()
    await tester.pump(); // listen() -> onResult fills the field

    expect(speech.initCalls, 1);
    expect(speech.listenCalls, 1);
    expect(
      waveOpacity(tester),
      1,
      reason: 'the waveform shows during the hold',
    );
    expect(find.text('Me CNC per kaam krta hun'), findsOneWidget);

    await gesture.up();
    await tester.pump();
    await tester.pumpAndSettle();

    expect(speech.stopCalls, 1);
    // Nothing was sent — the recognised text only reached the composer.
    verifyNever(() => chat.sendMessage(any()));
    expect(waveOpacity(tester), 0);
  });

  testWidgets('the waveform stays for the WHOLE hold and hides on release', (
    WidgetTester tester,
  ) async {
    speech.emit = 'kuch';

    await pumpScreen(tester);
    final TestGesture gesture = await tester.startGesture(
      tester.getCenter(composerMic()),
    );
    await tester.pump(const Duration(milliseconds: 600)); // long-press
    await tester.pump(); // initialize()
    await tester.pump(); // listen() -> result
    expect(waveOpacity(tester), 1);

    // No auto-hide — it must persist for the whole hold.
    await tester.pump(const Duration(seconds: 3));
    expect(
      waveOpacity(tester),
      1,
      reason: 'waveform shows until the button is let go',
    );

    await gesture.up();
    await tester.pumpAndSettle();
    expect(waveOpacity(tester), 0, reason: 'hidden on release');
  });

  testWidgets('recognised words append onto text already typed', (
    WidgetTester tester,
  ) async {
    speech.emit = 'CNC operator';

    await pumpScreen(tester);
    await tester.enterText(find.byType(TextField), 'Mera naam');

    final TestGesture gesture = await tester.startGesture(
      tester.getCenter(composerMic()),
    );
    await tester.pump(const Duration(milliseconds: 600));
    await tester.pump();
    await tester.pump();
    await gesture.up();
    await tester.pumpAndSettle();

    expect(find.text('Mera naam CNC operator'), findsOneWidget);
  });

  testWidgets(
    'a phrase before a mid-hold pause is KEPT — the next utterance appends',
    (WidgetTester tester) async {
      // "hello", then a five-second think (the recogniser silently restarts),
      // then "I am a CLC programmer". The impl flushes the first phrase as a
      // final, so the second must land as "hello I am a CLC programmer" — the
      // first words are never dropped.
      speech.emit = 'hello';
      speech.emit2 = 'I am a CLC programmer';

      await pumpScreen(tester);
      final TestGesture gesture = await tester.startGesture(
        tester.getCenter(composerMic()),
      );
      await tester.pump(const Duration(milliseconds: 600));
      await tester.pump(); // initialize()
      await tester.pump(); // listen() -> both finals arrive
      await gesture.up();
      await tester.pumpAndSettle();

      expect(find.text('hello I am a CLC programmer'), findsOneWidget);
    },
  );

  testWidgets(
    'a phrase kept when the recogniser RESETS its partial mid-hold — no final, '
    'no restart — the pre-pause words survive',
    (WidgetTester tester) async {
      // The device delivers the first phrase as a PARTIAL, then after a pause
      // starts a NEW partial for the second phrase WITHOUT a final and WITHOUT
      // restarting the session. "hello" must not be replaced by the next phrase.
      await pumpScreen(tester);

      final TestGesture gesture = await tester.startGesture(
        tester.getCenter(composerMic()),
      );
      await tester.pump(const Duration(milliseconds: 600)); // long-press
      await tester.pump(); // initialize()
      await tester.pump(); // listen() registers the result sink

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

      await gesture.up();
      await tester.pumpAndSettle();
    },
  );

  testWidgets(
    'a partial that GROWS within one utterance updates in place (no dupes)',
    (WidgetTester tester) async {
      await pumpScreen(tester);
      final TestGesture gesture = await tester.startGesture(
        tester.getCenter(composerMic()),
      );
      await tester.pump(const Duration(milliseconds: 600));
      await tester.pump();
      await tester.pump();

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

      await gesture.up();
      await tester.pumpAndSettle();
    },
  );

  testWidgets(
    'a trailing final delivered AFTER release never re-fills the composer',
    (WidgetTester tester) async {
      // The recogniser can flush one last final asynchronously after the worker
      // has let go — landing after they cleared/sent. It must be ignored, else
      // the composer intermittently refills with the sentence just spoken.
      speech.emit = 'pehla';

      await pumpScreen(tester);
      final TestGesture gesture = await tester.startGesture(
        tester.getCenter(composerMic()),
      );
      await tester.pump(const Duration(milliseconds: 600));
      await tester.pump(); // initialize()
      await tester.pump(); // listen() -> onResult fills 'pehla'
      expect(find.text('pehla'), findsOneWidget);

      await gesture.up();
      await tester.pumpAndSettle(); // release -> stops accepting dictation

      // The plugin flushes a late final AFTER release:
      speech.lastOnResult!(const DictationResult('doosra', isFinal: true));
      await tester.pump();

      final TextField field = tester.widget<TextField>(find.byType(TextField));
      expect(
        field.controller!.text,
        'pehla',
        reason: 'a post-release final must not append or refill',
      );
      expect(find.text('pehla doosra'), findsNothing);
    },
  );

  testWidgets(
    'no recogniser / denied mic → honest notice, composer stays empty',
    (WidgetTester tester) async {
      speech.ready = false;

      await pumpScreen(tester);

      final TestGesture gesture = await tester.startGesture(
        tester.getCenter(composerMic()),
      );
      await tester.pump(const Duration(milliseconds: 600));
      await tester.pump();
      await gesture.up();
      await tester.pumpAndSettle();

      expect(
        speech.listenCalls,
        0,
        reason: 'never listens without a recogniser',
      );
      expect(find.text(const MicPermissionFailure().message), findsOneWidget);
      final TextField field = tester.widget<TextField>(find.byType(TextField));
      expect(field.controller!.text, isEmpty);
    },
  );
}
