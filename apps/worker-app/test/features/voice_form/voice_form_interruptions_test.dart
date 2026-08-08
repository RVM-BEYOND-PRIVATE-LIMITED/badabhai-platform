import 'dart:async';

import 'package:flutter/widgets.dart' show AppLifecycleState;
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:record/record.dart';

import 'package:badabhai_worker_app/features/voice/data/session_voice_recorder.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/question_audio_player.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/silence_endpointer.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/voice_form_gateway.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/voice_form_models.dart';
import 'package:badabhai_worker_app/features/voice_form/presentation/cubit/voice_form_cubit.dart';

class MockAudioRecorder extends Mock implements AudioRecorder {}

class FakeTts implements QuestionAudioPlayer {
  @override
  Future<void> play(VoiceQuestion question) async {}
  @override
  Future<void> stop() async {}
}

/// A TTS whose `play` parks until the supplied future completes — lets a test
/// hold `_present` mid-flight and drive lifecycle events underneath it.
class BlockingTts implements QuestionAudioPlayer {
  BlockingTts(this._gate);
  final Future<void> _gate;
  @override
  Future<void> play(VoiceQuestion question) => _gate;
  @override
  Future<void> stop() async {}
}

class ScriptGateway implements VoiceFormGateway {
  ScriptGateway(this.total);
  final int total;
  int served = 0;
  int submits = 0;
  final List<VoiceAnswer> received = <VoiceAnswer>[];

  @override
  Future<VoiceFormStep> start() async {
    served = 1;
    return NextQuestion(VoiceQuestion(id: 'q1', prompt: 'Q1'),
        index: 1, total: total);
  }

  @override
  Future<VoiceFormStep> submit(VoiceAnswer answer) async {
    submits++;
    received.add(answer);
    if (served >= total) return const VoiceFormDone();
    served++;
    return NextQuestion(VoiceQuestion(id: 'q$served', prompt: 'Q$served'),
        index: served, total: total);
  }

  @override
  Future<void> finalize() async {}
}

void main() {
  setUpAll(() {
    registerFallbackValue(const RecordConfig());
    registerFallbackValue(Duration.zero);
  });

  late MockAudioRecorder plugin;
  late StreamController<RecordState> states;

  setUp(() {
    plugin = MockAudioRecorder();
    states = StreamController<RecordState>.broadcast();
    when(() => plugin.hasPermission()).thenAnswer((_) async => true);
    when(() => plugin.start(any(), path: any(named: 'path')))
        .thenAnswer((_) async {});
    when(() => plugin.cancel()).thenAnswer((_) async {});
    when(() => plugin.dispose()).thenAnswer((_) async {});
    when(() => plugin.stop()).thenAnswer((_) async => 'clip.m4a');
    when(() => plugin.onAmplitudeChanged(any()))
        .thenAnswer((_) => const Stream<Amplitude>.empty());
    when(() => plugin.onStateChanged()).thenAnswer((_) => states.stream);
  });

  tearDown(() => states.close());

  VoiceFormCubit build(ScriptGateway gateway, {DateTime Function()? clock}) =>
      VoiceFormCubit(
        gateway: gateway,
        recorder: SessionVoiceRecorder(recorder: plugin, clock: clock),
        endpointer: SilenceEndpointer(),
        tts: FakeTts(),
        sleep: (_) async {},
      );

  test('a simulated call pauses and resumes WITHOUT advancing the question',
      () async {
    final ScriptGateway gateway = ScriptGateway(8);
    final VoiceFormCubit cubit = build(gateway);
    addTearDown(cubit.close);
    await cubit.start();
    expect(cubit.state, isA<VoiceFormAsking>());

    cubit.handleLifecycle(AppLifecycleState.paused);
    await pumpEventQueue();
    expect(cubit.state, isA<VoiceFormInterrupted>());

    cubit.handleLifecycle(AppLifecycleState.resumed);
    await pumpEventQueue();
    final VoiceFormState s = cubit.state;
    expect(s, isA<VoiceFormAsking>());
    expect((s as VoiceFormAsking).question.id, 'q1'); // SAME question
    expect(gateway.submits, 0, reason: 'an interruption never advances');
  });

  test('repeated paused events are idempotent — the mic is cancelled once',
      () async {
    final ScriptGateway gateway = ScriptGateway(8);
    final VoiceFormCubit cubit = build(gateway);
    addTearDown(cubit.close);
    await cubit.start();
    clearInteractions(plugin);

    cubit.handleLifecycle(AppLifecycleState.paused);
    cubit.handleLifecycle(AppLifecycleState.paused); // stacked (iOS)
    cubit.handleLifecycle(AppLifecycleState.paused);
    await pumpEventQueue();

    expect(cubit.state, isA<VoiceFormInterrupted>());
    verify(() => plugin.cancel()).called(1); // not three times
  });

  test('a state-stream error discards the clip and re-asks the SAME question',
      () async {
    final ScriptGateway gateway = ScriptGateway(8);
    final VoiceFormCubit cubit = build(gateway);
    addTearDown(cubit.close);
    await cubit.start();
    clearInteractions(plugin);

    states.addError(Exception('bluetooth SCO drop'));
    await pumpEventQueue();

    final VoiceFormState s = cubit.state;
    expect(s, isA<VoiceFormAsking>());
    expect((s as VoiceFormAsking).question.id, 'q1'); // re-asked, not advanced
    expect(gateway.submits, 0);
    verify(() => plugin.cancel()).called(1); // the interrupted clip is discarded
  });

  test('durationSeconds is RECORDED time, not wall-clock across an interruption',
      () async {
    DateTime now = DateTime(2026, 8, 8, 9, 0, 0);
    final ScriptGateway gateway = ScriptGateway(1);
    final VoiceFormCubit cubit = build(gateway, clock: () => now);
    addTearDown(cubit.close);
    await cubit.start(); // Q1 clip starts at 09:00:00

    now = now.add(const Duration(seconds: 30)); // a 30s phone call
    cubit.handleLifecycle(AppLifecycleState.paused);
    await pumpEventQueue();
    cubit.handleLifecycle(AppLifecycleState.resumed); // fresh clip at 09:00:30
    await pumpEventQueue();

    now = now.add(const Duration(seconds: 3)); // 3s of actual answer
    await cubit.answerBySpeaking();

    // 33s of wall-clock elapsed, but only 3s was recorded.
    expect(gateway.received.single.clip!.durationSeconds, 3);
  });

  test('two consecutive silent questions stop the session with a settings hint',
      () async {
    when(() => plugin.stop()).thenAnswer((_) async => null); // mic delivers nothing
    final ScriptGateway gateway = ScriptGateway(8);
    final VoiceFormCubit cubit = build(gateway);
    addTearDown(cubit.close);
    await cubit.start();

    await cubit.answerBySpeaking(); // silent #1 → re-arm same question
    expect(cubit.state, isA<VoiceFormAsking>());
    await cubit.answerBySpeaking(); // silent #2 → stop

    final VoiceFormState s = cubit.state;
    expect(s, isA<VoiceFormError>());
    expect((s as VoiceFormError).failure.message, kVoiceMicSilentMessage);
    expect(gateway.submits, 0);
  });

  test(
      'paused DURING the submit await stays Interrupted with NO new '
      'plugin.start() — the mic is never armed in the background (#691)',
      () async {
    final Completer<VoiceFormStep> submitBlock = Completer<VoiceFormStep>();
    final VoiceFormCubit cubit = VoiceFormCubit(
      gateway: _BlockingSubmitGateway(submitBlock),
      recorder: SessionVoiceRecorder(recorder: plugin),
      endpointer: SilenceEndpointer(),
      tts: FakeTts(),
      sleep: (_) async {},
    );
    addTearDown(cubit.close);
    await cubit.start();
    expect(cubit.state, isA<VoiceFormAsking>());
    clearInteractions(plugin); // ignore the initial Q1 arm

    final Future<void> adv = cubit.answerBySpeaking(); // parks on submit
    await pumpEventQueue();

    cubit.handleLifecycle(AppLifecycleState.paused);
    await pumpEventQueue();
    expect(cubit.state, isA<VoiceFormInterrupted>());

    // Submit resolves AFTER the pause — the stale advance must abort.
    submitBlock.complete(const NextQuestion(
        VoiceQuestion(id: 'q2', prompt: 'Q2'),
        index: 2,
        total: 8));
    await adv;
    await pumpEventQueue();

    expect(cubit.state, isA<VoiceFormInterrupted>(),
        reason: 'a stale advance must never overwrite VoiceFormInterrupted');
    verifyNever(() => plugin.start(any(), path: any(named: 'path')));
  });

  test(
      'the FOREGROUND gate alone stops the mic — independent of the epoch',
      () async {
    // Both other interruption tests are satisfied by the EPOCH check returning
    // first, so neither measures the foreground gate the fix leads with. This
    // one moves the generation back into agreement before releasing the await,
    // leaving _foreground as the only thing that can refuse the mic.
    final ScriptGateway gateway = ScriptGateway(8);
    final Completer<void> ttsBlock = Completer<void>();
    final BlockingTts tts = BlockingTts(ttsBlock.future);

    final VoiceFormCubit cubit = VoiceFormCubit(
      gateway: gateway,
      recorder: SessionVoiceRecorder(recorder: plugin),
      endpointer: SilenceEndpointer(),
      tts: tts,
      sleep: (_) async {},
    );
    addTearDown(cubit.close);

    final Future<void> starting = cubit.start(); // parks inside _present's tts
    await pumpEventQueue();

    // paused THEN resumed: the generation ends up back where the parked
    // continuation captured it, so only _foreground can still refuse.
    cubit.handleLifecycle(AppLifecycleState.paused);
    await pumpEventQueue();
    cubit.handleLifecycle(AppLifecycleState.paused); // still backgrounded
    await pumpEventQueue();

    ttsBlock.complete();
    await starting;
    await pumpEventQueue();

    verifyNever(() => plugin.start(any(), path: any(named: 'path')));
  });

  test(
      'a pause during stop() aborts even when a clip WAS captured — the epoch '
      'guard belongs on both branches (#691)', () async {
    // The gap the first fix left: the epoch check sat inside `if (clip == null)`,
    // so a `paused` landing during `await _recorder.stop()` was walked over
    // whenever the take produced a clip. The advance then emitted
    // Asking(uploading) over the VoiceFormInterrupted the handler had just
    // emitted — and resumeSession() no-ops on Asking, so the mid-session
    // permission re-check is skipped in exactly the case the pause was long
    // enough for permission to be revoked.
    final ScriptGateway gateway = ScriptGateway(8);
    final Completer<String?> stopBlock = Completer<String?>();

    final VoiceFormCubit cubit = build(gateway);
    addTearDown(cubit.close);
    await cubit.start();
    expect(cubit.state, isA<VoiceFormAsking>());

    // stop() hangs, and resolves WITH a clip (the non-null branch).
    when(() => plugin.stop()).thenAnswer((_) => stopBlock.future);

    final Future<void> adv = cubit.answerBySpeaking();
    await pumpEventQueue();

    cubit.handleLifecycle(AppLifecycleState.paused);
    await pumpEventQueue();
    expect(cubit.state, isA<VoiceFormInterrupted>());

    stopBlock.complete('clip-captured.m4a'); // a REAL clip, not null
    await adv;
    await pumpEventQueue();

    expect(cubit.state, isA<VoiceFormInterrupted>(),
        reason: 'a captured clip does not entitle the advance to overwrite the '
            'interruption');
    expect(gateway.submits, 0, reason: 'the stale advance must not submit');
  });

  test('paused DURING the prime window does not arm / emit listening (#691)',
      () async {
    final Completer<void> primeBlock = Completer<void>();
    final VoiceFormCubit cubit = VoiceFormCubit(
      gateway: ScriptGateway(8),
      recorder: SessionVoiceRecorder(recorder: plugin),
      endpointer: SilenceEndpointer(),
      tts: FakeTts(),
      sleep: (_) => primeBlock.future, // block the 250ms prime
    );
    addTearDown(cubit.close);
    final Future<void> started = cubit.start(); // arms → start → parks on prime
    await pumpEventQueue();
    expect(cubit.state, isA<VoiceFormAsking>());
    expect((cubit.state as VoiceFormAsking).micPhase, MicPhase.priming);

    cubit.handleLifecycle(AppLifecycleState.paused);
    await pumpEventQueue();
    expect(cubit.state, isA<VoiceFormInterrupted>());

    primeBlock.complete(); // the prime finishes — the arm chain must abort
    await started;
    await pumpEventQueue();

    expect(cubit.state, isA<VoiceFormInterrupted>(),
        reason: 'the prime continuation must not arm listening after a pause');
  });
}

/// A gateway whose `submit` parks on [_block] so a test can inject a `paused`
/// mid-submit (#691).
class _BlockingSubmitGateway implements VoiceFormGateway {
  _BlockingSubmitGateway(this._block);
  final Completer<VoiceFormStep> _block;

  @override
  Future<VoiceFormStep> start() async => const NextQuestion(
      VoiceQuestion(id: 'q1', prompt: 'Q1'), index: 1, total: 8);

  @override
  Future<VoiceFormStep> submit(VoiceAnswer answer) => _block.future;

  @override
  Future<void> finalize() async {}
}
